// Smoke test for the signaling server. Not shipped to clients.
const WebSocket = require("ws");

const URL = "ws://localhost:3000/ws";
const failures = [];

function client() {
  const ws = new WebSocket(URL);
  ws.inbox = [];
  ws.on("message", (raw) => ws.inbox.push(JSON.parse(raw)));
  return new Promise((res, rej) => {
    ws.on("open", () => res(ws));
    ws.on("error", rej);
  });
}

const waitFor = (ws, type, timeout = 3000) =>
  new Promise((res, rej) => {
    const t0 = Date.now();
    const poll = setInterval(() => {
      const i = ws.inbox.findIndex((m) => m.type === type);
      if (i >= 0) {
        clearInterval(poll);
        res(ws.inbox.splice(i, 1)[0]);
      } else if (Date.now() - t0 > timeout) {
        clearInterval(poll);
        rej(new Error(`timeout waiting for ${type}`));
      }
    }, 20);
  });

function check(label, cond) {
  if (cond) console.log(`PASS ${label}`);
  else {
    console.log(`FAIL ${label}`);
    failures.push(label);
  }
}

(async () => {
  // 1. First peer joins, gets empty peer list
  const a = await client();
  a.send(JSON.stringify({ type: "join", room: "t1", name: "Alice" }));
  const aJoined = await waitFor(a, "joined");
  check("A joins, empty peers", aJoined.peers.length === 0 && !!aJoined.selfId);

  // 2. Second peer joins, sees A; A notified
  const b = await client();
  b.send(JSON.stringify({ type: "join", room: "t1", name: "Bob" }));
  const bJoined = await waitFor(b, "joined");
  check("B joins, sees Alice", bJoined.peers.length === 1 && bJoined.peers[0].name === "Alice");
  const aPeerJoined = await waitFor(a, "peer-joined");
  check("A notified of Bob", aPeerJoined.name === "Bob" && aPeerJoined.id === bJoined.selfId);

  // 3. Signal relay A -> B
  a.send(JSON.stringify({ type: "signal", to: bJoined.selfId, data: { description: { type: "offer", sdp: "x" } } }));
  const sig = await waitFor(b, "signal");
  check("signal relayed A->B", sig.from === aJoined.selfId && sig.data.description.sdp === "x");

  // 4. Third and fourth peers allowed (mesh), fifth rejected
  const c = await client();
  c.send(JSON.stringify({ type: "join", room: "t1", name: "Carol" }));
  const cJoined = await waitFor(c, "joined");
  check("third peer allowed, sees 2", cJoined.peers.length === 2);
  const dd = await client();
  dd.send(JSON.stringify({ type: "join", room: "t1", name: "Dan" }));
  const ddJoined = await waitFor(dd, "joined");
  check("fourth peer allowed, sees 3", ddJoined.peers.length === 3);
  const ee = await client();
  ee.send(JSON.stringify({ type: "join", room: "t1", name: "Eli" }));
  const full = await waitFor(ee, "room-full");
  check("fifth peer rejected", full.type === "room-full");
  ee.close();
  c.close();
  dd.close();
  await waitFor(a, "peer-left");
  await waitFor(a, "peer-left");

  // 5. Leave notification + room reuse after empty
  b.close();
  const left = await waitFor(a, "peer-left");
  check("A notified Bob left", left.name === "Bob");
  a.close();
  await new Promise((r) => setTimeout(r, 100));
  const d = await client();
  d.send(JSON.stringify({ type: "join", room: "t1", name: "Dave" }));
  const dJoined = await waitFor(d, "joined");
  check("room freed after empty", dJoined.peers.length === 0);
  d.close();

  // 6. Explicit leave message frees the slot even if the socket stays open
  // (tunnel scenario: remote browser gone, local socket still connected).
  const e1 = await client();
  const e2 = await client();
  e1.send(JSON.stringify({ type: "join", room: "t2", name: "Eve" }));
  e2.send(JSON.stringify({ type: "join", room: "t2", name: "Finn" }));
  await waitFor(e1, "joined");
  await waitFor(e2, "joined");
  e1.send(JSON.stringify({ type: "leave" })); // sockets NOT closed
  e2.send(JSON.stringify({ type: "leave" }));
  await waitFor(e2, "peer-left");
  await new Promise((r) => setTimeout(r, 100));
  const g1 = await client();
  const g2 = await client();
  g1.send(JSON.stringify({ type: "join", room: "t2", name: "Gail" }));
  const g1Joined = await waitFor(g1, "joined");
  check("rejoin after both leave (sockets open)", g1Joined.peers.length === 0);
  g2.send(JSON.stringify({ type: "join", room: "t2", name: "Hank" }));
  const g2Joined = await waitFor(g2, "joined");
  check("second rejoin not blocked by ghosts", g2Joined.peers.length === 1);

  // 7. App-level ping answered
  g1.send(JSON.stringify({ type: "ping" }));
  await waitFor(g1, "pong");
  check("ping answered with pong", true);
  for (const s of [e1, e2, g1, g2]) s.close();

  console.log(failures.length ? `\n${failures.length} FAILURES` : "\nALL PASS");
  process.exit(failures.length ? 1 : 0);
})().catch((e) => {
  console.error("test error:", e.message);
  process.exit(1);
});
