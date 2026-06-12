// Signaling + static file server. No database: rooms live in memory and
// vanish when empty. Media and chat never touch this server — they flow
// peer-to-peer over WebRTC.
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_PEERS_PER_ROOM = 4;
const MAX_ROOMS = 512; // memory backstop — each room is just a tiny Map

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};
const COMPRESSIBLE = new Set([".html", ".js", ".css", ".svg"]);

// Everything the page needs is same-origin (no webfonts, no CDNs), so the
// policy can be strict. ws:/wss: stay listed for older Safari, where
// 'self' did not match same-origin WebSocket upgrades.
const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
    "media-src 'self' blob:; connect-src 'self' ws: wss:; object-src 'none'; " +
    "base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  // display-capture MUST be (self): () denies getDisplayMedia and silently
  // kills screen sharing on deployments. picture-in-picture listed
  // explicitly so a proxy can't narrow the default.
  "Permissions-Policy":
    "camera=(self), microphone=(self), display-capture=(self), " +
    "picture-in-picture=(self), geolocation=(), payment=()",
};

// Static cache: tiny files, compressed once per mtime. On slow links the
// win is twofold — gzip/brotli cuts first-load bytes ~70%, and ETag
// revalidation turns every later load into a ~0-byte 304 while still
// shipping fixes on plain refresh (the old no-store re-sent everything).
const fileCache = new Map(); // path -> { mtimeMs, size, etag, raw, gz, br }

function loadFile(filePath) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) return null;
  const hit = fileCache.get(filePath);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit;

  const raw = fs.readFileSync(filePath);
  const entry = {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    etag: `"${crypto.createHash("sha1").update(raw).digest("base64url")}"`,
    raw,
    gz: null,
    br: null,
  };
  if (COMPRESSIBLE.has(path.extname(filePath))) {
    entry.gz = zlib.gzipSync(raw, { level: 9 });
    entry.br = zlib.brotliCompressSync(raw, {
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 },
    });
  }
  fileCache.set(filePath, entry);
  return entry;
}

const server = http.createServer((req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" });
    return res.end();
  }

  const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const filePath = path.normalize(
    path.join(PUBLIC_DIR, urlPath === "/" ? "index.html" : urlPath)
  );
  // normalize + prefix-with-separator: rejects traversal AND siblings like
  // /public-secrets that a bare startsWith(PUBLIC_DIR) would let through.
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403, SECURITY_HEADERS);
    return res.end("Forbidden");
  }

  let entry;
  try {
    entry = loadFile(filePath);
  } catch {
    entry = null;
  }
  if (!entry) {
    res.writeHead(404, SECURITY_HEADERS);
    return res.end("Not found");
  }

  const headers = {
    ...SECURITY_HEADERS,
    "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream",
    // no-cache = always revalidate (tiny 304), never serve stale code.
    "Cache-Control": "no-cache",
    ETag: entry.etag,
    Vary: "Accept-Encoding",
  };

  if (req.headers["if-none-match"] === entry.etag) {
    res.writeHead(304, headers);
    return res.end();
  }

  let body = entry.raw;
  const accepts = req.headers["accept-encoding"] || "";
  if (entry.br && /\bbr\b/.test(accepts)) {
    headers["Content-Encoding"] = "br";
    body = entry.br;
  } else if (entry.gz && /\bgzip\b/.test(accepts)) {
    headers["Content-Encoding"] = "gzip";
    body = entry.gz;
  }
  headers["Content-Length"] = body.length;
  res.writeHead(200, headers);
  res.end(req.method === "HEAD" ? undefined : body);
});

// rooms: Map<roomId, Map<peerId, ws>>
const rooms = new Map();

// Accept the signaling socket at any path ending in /ws so the app also
// works behind path-prefixed tunnels and reverse proxies.
// maxPayload: an SDP with many ICE candidates tops out well under 128 KB;
// anything bigger is abuse, and ws closes the socket for us.
const wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });
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

// Per-socket token bucket. Legitimate traffic is light (trickle ICE bursts
// ~30 messages at call setup, then a ping every 10 s); a flood eats the
// bucket and gets the socket dropped instead of melting the relay loop.
const BUCKET_BURST = 100;
const BUCKET_REFILL_PER_SEC = 25;

function takeToken(ws) {
  const now = Date.now();
  ws.bucket = Math.min(
    BUCKET_BURST,
    ws.bucket + ((now - ws.bucketStamp) / 1000) * BUCKET_REFILL_PER_SEC
  );
  ws.bucketStamp = now;
  if (ws.bucket < 1) return false;
  ws.bucket -= 1;
  return true;
}

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
  ws.bucket = BUCKET_BURST;
  ws.bucketStamp = Date.now();

  ws.on("message", (raw) => {
    if (!takeToken(ws)) return ws.terminate();
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;
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
        if (rooms.size >= MAX_ROOMS) {
          return send(ws, { type: "error", reason: "Server at capacity — try later." });
        }
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
    // The relay is content-blind but shape-checked: only objects travel,
    // only within the sender's room.
    if (
      msg.type === "signal" &&
      ws.roomId &&
      typeof msg.to === "string" &&
      msg.data &&
      typeof msg.data === "object"
    ) {
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
