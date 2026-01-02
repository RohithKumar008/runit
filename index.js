// index.js
const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const providers = {};     // sid -> providerWs
const pendingHttp = {};   // reqId -> { res }

console.log("Classic-notebook proxy starting...");

app.get("/", (req, res) => res.send("Classic Notebook proxy running"));

// HTTP proxy: forward any /session/:sid/* request to provider
app.all("/session/:sid/*", express.raw({ type: "*/*", limit: "100mb" }), (req, res) => {
  const sid = req.params.sid;
  const provider = providers[sid];
  if (!provider || provider.readyState !== provider.OPEN) {
    return res.status(503).send("Provider not connected");
  }

  const reqId = uuidv4();
  pendingHttp[reqId] = res;

  const envelope = {
    type: "http-request",
    reqId,
    method: req.method,
    path: req.originalUrl.replace(`/session/${sid}`, "") || "/",
    headers: req.headers,
  };

  try {
    provider.send(JSON.stringify(envelope));
    // send body (if any) as binary or empty marker
    if (req.body && req.body.length) provider.send(req.body);
    else provider.send(JSON.stringify({ type: "http-body-empty", reqId }));
  } catch (e) {
    delete pendingHttp[reqId];
    return res.status(500).send("Forward error");
  }

  // provider will later send http-response + http-body -> handled below in ws provider handler
});

// WebSocket endpoint for kernel channels: renter opens this to talk to kernels
// Example: wss://yourdomain/session-ws/test123?path=/api/kernels/<id>/channels
wss.on("connection", (ws, req) => {
  const url = req.url || "";
  if (url.startsWith("/ws/provider")) {
    // provider connection
    const params = new URLSearchParams(url.split("?")[1] || "");
    const sid = params.get("sessionId");
    if (!sid) { ws.close(); return; }
    providers[sid] = ws;
    console.log("Provider connected:", sid);

    ws.on("message", (msg) => {
      // provider sends JSON control or binary http-body
      if (Buffer.isBuffer(msg)) {
        // ignore stray binary
        return;
      }
      let data;
      try { data = JSON.parse(msg.toString()); } catch (e) {
        console.log("Provider raw:", msg.toString()); return;
      }
      if (data.type === "http-response") {
        const res = pendingHttp[data.reqId];
        if (!res) { console.log("No pending for", data.reqId); return; }
        res.statusCode = data.status || 200;
        if (data.headers) {
          Object.entries(data.headers).forEach(([k,v]) => { try{ res.setHeader(k, v); }catch{} });
        }
      } else if (data.type === "http-body") {
        const res = pendingHttp[data.reqId];
        if (!res) return;
        const buff = data.isBase64 ? Buffer.from(data.body, "base64") : Buffer.from(data.body || "");
        res.end(buff);
        delete pendingHttp[data.reqId];
      } else if (data.type === "ws-proxy-open") {
        // provider confirms it opened local WS for a kernel; map it if needed
        // not used by server except logging
      } else if (data.type === "ws-proxy-data") {
        // server forwards to renter ws stored in data.renterConnId — implement if you track multiple renters
      }
    });

    ws.on("close", () => { delete providers[sid]; console.log("Provider disconnected:", sid); });
    return;
  }

  // Renter connecting to a kernel WS: /session-ws/:sid?path=...
  if (url.startsWith("/session-ws/") || url.startsWith("/session-ws?") || url.startsWith("/ws/renter")) {
    // parse path and sid
    const raw = url.replace("/session-ws/", "").replace("/ws/renter", "");
    const params = new URLSearchParams(url.split("?")[1] || "");
    const sid = raw.split("?")[0] || params.get("sessionId") || (params.get("sid"));
    const path = params.get("path") || decodeURIComponent((url.split("path=")[1]||""));
    if (!sid) { ws.close(); return; }
    const provider = providers[sid];
    if (!provider || provider.readyState !== provider.OPEN) { ws.close(); return; }

    // Generate an internal id for this renter ws so provider can map responses
    const renterConnId = uuidv4();

    // Instruct provider to open a local websocket to Jupyter at `path`
    provider.send(JSON.stringify({
      type: "ws-proxy-open",
      renterConnId,
      path
    }));

    // When renter sends data, forward to provider (provider will forward to local jupyter)
    ws.on("message", (m) => {
      // binary or text - send as base64 if binary
      if (Buffer.isBuffer(m)) {
        provider.send(JSON.stringify({ type: "ws-proxy-data-binary", renterConnId, payload: m.toString("base64") }));
      } else {
        provider.send(JSON.stringify({ type: "ws-proxy-data", renterConnId, payload: m.toString() }));
      }
    });

    // provider will later send back ws-proxy-data messages which we need to forward to this ws.
    // To simplify, provider will send ws-proxy-back messages with renterConnId and payload, server will route them.
    // Implement a small route table:
    const routeKey = renterConnId;
    if (!wss.routeMap) wss.routeMap = {};
    wss.routeMap[routeKey] = ws;

    ws.on("close", () => {
      provider.send(JSON.stringify({ type: "ws-proxy-close", renterConnId }));
      delete wss.routeMap[routeKey];
    });

    return;
  }

  console.log("Unknown WS connection:", url);
  ws.close();
});

// For provider -> server routing of ws-proxy-back messages we need provider to send messages with type "ws-proxy-back"
wss.on("connection", (ws) => {
  // handled in the above on connection, but the provider handler will forward messages and server should route them
});

// Start
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log("Proxy listening on", PORT));
