// index.js
const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

let providers = {};   // { sessionId: providerSocket }
let renters = {};     // { sessionId: renterSocket }

console.log("Bridge server starting...");


// ---------------------------
// Provider connects
// ---------------------------
app.post("/provider/register", (req, res) => {
  const sessionId = req.body.sessionId;

  console.log("Provider registered for session:", sessionId);

  res.json({ ok: true, message: "Provider registered", sessionId });
});


// ---------------------------
// WebSocket handling
// ---------------------------
wss.on("connection", (ws, req) => {
  const url = req.url;

  // Provider socket
  if (url.startsWith("/ws/provider")) {
    const sessionId = new URLSearchParams(url.replace("/ws/provider?", "")).get("sessionId");

    console.log("Provider WebSocket connected for session:", sessionId);
    providers[sessionId] = ws;

    ws.on("message", (msg) => {
      if (renters[sessionId]) {
        renters[sessionId].send(msg);
      }
    });

    ws.on("close", () => {
      console.log("Provider disconnected:", sessionId);
      delete providers[sessionId];
    });
  }

  // Renter socket
  else if (url.startsWith("/ws/renter")) {
    const sessionId = new URLSearchParams(url.replace("/ws/renter?", "")).get("sessionId");

    console.log("Renter WebSocket connected for session:", sessionId);
    renters[sessionId] = ws;

    ws.on("message", (msg) => {
      if (providers[sessionId]) {
        providers[sessionId].send(msg);
      }
    });

    ws.on("close", () => {
      console.log("Renter disconnected:", sessionId);
      delete renters[sessionId];
    });
  }
});


app.get("/", (req, res) => {
  res.send("GPU Rental Bridge Server Running ✔");
});


// ---------------------------
// Start server
// ---------------------------
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log("Bridge server listening on port", PORT);
});