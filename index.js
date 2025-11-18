// index.js
const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

/*
  We keep maps:
  - providers[sid] = ws (provider side)
  - pendingHttpRequests[reqId] = {res, chunks}
*/
const providers = {};
const renters = {};
const pendingHttp = {}; // reqId -> res object

console.log("Proxy bridge starting...");

app.get("/", (req, res) => res.send("Proxy bridge running"));

// --- HTTP proxy entrypoint for renters ---
// renter uses: GET/POST /session/:sid/*  (we'll forward verb, headers, body)
app.all("/session/:sid/*", express.raw({ type: "*/*", limit: "50mb" }), async (req, res) => {
  const sid = req.params.sid;
  const providerWs = providers[sid];
  if (!providerWs || providerWs.readyState !== providerWs.OPEN) {
    return res.status(503).send("Provider not connected");
  }

  // Create unique request id
  const reqId = uuidv4();

  // Build envelope for provider
  const envelope = {
    type: "http-request",
    reqId,
    method: req.method,
    path: req.originalUrl.replace(`/session/${sid}`, ""), // path on provider
    headers: req.headers,
  };

  // Store the express res to be completed when provider responds
  pendingHttp[reqId] = res;

  // Send the envelope header as JSON, then binary body (if any)
  try {
    providerWs.send(JSON.stringify(envelope));
    if (req.body && req.body.length) {
      // send body as binary message
      providerWs.send(req.body);
    } else {
      // send an empty marker
      providerWs.send(JSON.stringify({ type: "http-body-empty", reqId }));
    }
  } catch (e) {
    delete pendingHttp[reqId];
    return res.status(500).send("Error forwarding to provider");
  }

  // When provider replies using messages we will complete the response
});

// --- WebSocket server: handles provider and renter connections ---
// Provider should connect to /ws/provider?sessionId=SID
wss.on("connection", (ws, req) => {
  const url = req.url || "";
  console.log("WS connected:", url);

  if (url.startsWith("/ws/provider")) {
    const params = new URLSearchParams(url.split("?")[1] || "");
    const sid = params.get("sessionId");
    if (!sid) {
      ws.close();
      return;
    }
    providers[sid] = ws;
    console.log("Provider registered:", sid);

    // Provider messages may be either:
    // - JSON strings with type fields (http-response metadata)
    // - Binary chunks that belong to a pending request (we'll treat binary as body parts)

    // We'll maintain small buffers per reqId on provider side if needed:
    ws.on("message", (msg) => {
      // If Buffer or ArrayBuffer -> treat as binary body chunk
      if (Buffer.isBuffer(msg) || msg instanceof ArrayBuffer) {
        // provider must previously have sent a JSON header indicating next chunk belongs to reqId
        // For simplicity provider sends a header JSON before binary chunks (see provider code)
        // We won't try to decode ambiguous binary here.
        console.log("Received unexpected binary from provider (ignored unless header used)");
        return;
      }

      // text message
      let data;
      try { data = JSON.parse(msg.toString()); } catch (e) {
        console.log("Provider text:", msg.toString());
        return;
      }

      if (data.type === "http-response") {
        // data: { type: 'http-response', reqId, status, headers }
        const res = pendingHttp[data.reqId];
        if (!res) {
          console.log("No pending response for", data.reqId);
          return;
        }
        // store status and headers; now wait for next binary message body or an 'http-body-empty' marker
        res.statusCode = data.status || 200;
        // set headers
        if (data.headers) {
          for (const [k, v] of Object.entries(data.headers)) {
            try { res.setHeader(k, v); } catch (e) {}
          }
        }
        // if provider indicates body follows as a binary frame, provider will send a Buffer next.
        // We'll simply wait — provider will send a base64 string body message or a binary message.
      } else if (data.type === "http-body") {
        // data: { type:'http-body', reqId, isBase64:false, body?: string (base64 if true) }
        const res = pendingHttp[data.reqId];
        if (!res) return;
        if (data.isBase64 && data.body) {
          const buff = Buffer.from(data.body, "base64");
          res.end(buff);
        } else if (data.body) {
          res.end(data.body);
        } else {
          // no body, just end
          res.end();
        }
        delete pendingHttp[data.reqId];
      } else {
        console.log("Provider message:", data);
      }
    });

    ws.on("close", () => {
      console.log("Provider disconnected:", sid);
      delete providers[sid];
    });

    return;
  }

  // Renter WS (we keep for possible future ws-channel proxying)
  if (url.startsWith("/ws/renter")) {
    const params = new URLSearchParams(url.split("?")[1] || "");
    const sid = params.get("sessionId");
    // we don't need to do much here now, renters will use HTTP for Jupyter pages;
    renters[sid] = ws;
    ws.on("message", (m) => {
      // Potential future: forward kernel WS channels
      console.log("Renter ws message:", typeof m);
    });
    ws.on("close", () => delete renters[sid]);
  }
});

// Helper: allow provider to send HTTP response body in base64 if necessary
// Provider side will send: JSON { type: 'http-response', reqId, status, headers }
// then send: JSON { type:'http-body', reqId, isBase64: true, body: '<base64>' }

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log("Proxy bridge listening on", PORT));
