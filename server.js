// Signaling + static file server. No database: rooms live in memory and
// vanish when empty. Media and chat never touch this server — they flow
// peer-to-peer over WebRTC.
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_PEERS_PER_ROOM = 4;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
  let filePath = path.join(PUBLIC_DIR, urlPath === "/" ? "index.html" : urlPath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end("Not found");
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream",
      // App ships updates often and files are tiny: always serve fresh so
      // peers get fixes on plain refresh instead of fighting browser cache.
      "Cache-Control": "no-store",
    });
    res.end(data);
  });
});

// rooms: Map<roomId, Map<peerId, ws>>
const rooms = new Map();

// Accept the signaling socket at any path ending in /ws so the app also
// works behind path-prefixed tunnels and reverse proxies.
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const { pathname } = new URL(req.url, "http://x");
  if (pathname === "/ws" || pathname.endsWith("/ws")) {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

// App-level liveness window. Tunnels/proxies answer protocol pings on the
// local hop themselves and can swallow remote disconnects entirely, so
// liveness must be judged on application messages from the browser.
// Generous window: backgrounded mobile tabs throttle timers, and a call
// must survive the user switching apps mid-conversation.
const STALE_MS = 90_000;

function leaveRoom(ws) {
  const roomId = ws.roomId;
  if (!roomId) return;
  ws.roomId = null;
  const room = rooms.get(roomId);
  if (!room || !room.has(ws.peerId)) return;
  room.delete(ws.peerId);
  for (const peer of room.values()) {
    send(peer, { type: "peer-left", id: ws.peerId, name: ws.name });
  }
  if (room.size === 0) rooms.delete(roomId);
}

wss.on("connection", (ws) => {
  ws.peerId = crypto.randomUUID();
  ws.roomId = null;
  ws.lastSeen = Date.now();

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    ws.lastSeen = Date.now();

    if (msg.type === "ping") return send(ws, { type: "pong" });
    if (msg.type === "leave") return leaveRoom(ws);

    if (msg.type === "join") {
      const roomId = String(msg.room || "").slice(0, 64);
      const name = String(msg.name || "Guest").slice(0, 32);
      if (!roomId) return send(ws, { type: "error", reason: "Room name required" });
      leaveRoom(ws); // a socket can only be in one room

      let room = rooms.get(roomId);
      if (!room) {
        room = new Map();
        rooms.set(roomId, room);
      }
      // Evict ghosts (dead sockets or peers gone silent) before judging "full".
      for (const peer of room.values()) {
        if (peer.readyState !== peer.OPEN || Date.now() - peer.lastSeen > STALE_MS) {
          leaveRoom(peer);
          peer.terminate();
        }
      }
      if (room.size >= MAX_PEERS_PER_ROOM) {
        return send(ws, { type: "room-full" });
      }

      ws.roomId = roomId;
      ws.name = name;
      room.set(ws.peerId, ws);

      // Joiner learns who is already here; existing peers learn about the joiner.
      const peers = [...room.values()]
        .filter((p) => p !== ws)
        .map((p) => ({ id: p.peerId, name: p.name }));
      send(ws, { type: "joined", selfId: ws.peerId, peers });
      for (const peer of room.values()) {
        if (peer !== ws) send(peer, { type: "peer-joined", id: ws.peerId, name });
      }
      return;
    }

    // Relay WebRTC signaling (offers/answers/ICE) to the addressed peer.
    if (msg.type === "signal" && ws.roomId) {
      const room = rooms.get(ws.roomId);
      const target = room && room.get(msg.to);
      if (target) send(target, { type: "signal", from: ws.peerId, data: msg.data });
    }
  });

  ws.on("close", () => leaveRoom(ws));
});

// Sweep peers that stopped sending app-level pings (browser closed but the
// tunnel kept the local socket open).
const sweep = setInterval(() => {
  for (const ws of wss.clients) {
    if (Date.now() - ws.lastSeen > STALE_MS) {
      leaveRoom(ws);
      ws.terminate();
    }
  }
}, 15_000);
wss.on("close", () => clearInterval(sweep));

server.listen(PORT, () => {
  console.log(`lowband-call listening on http://localhost:${PORT}`);
});
