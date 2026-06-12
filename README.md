# Lowband Call

Messenger-style web app with peer-to-peer group video calls (up to 4 people)
and text chat, built for **slow internet connections** and running with
**no database whatsoever**.

## Quick start

```bash
npm install
npm start          # http://localhost:3000
```

Open the URL in two browsers (or share via a tunnel/LAN), enter the same room
name, and you're in a call.

## How it works without a database

| Concern | Where it lives |
|---|---|
| Rooms / presence | In-memory `Map` on the Node server — vanishes when the room empties |
| Video & audio | Peer-to-peer over WebRTC (RTP/UDP) — never touches the server |
| Chat messages | WebRTC DataChannel, peer-to-peer — never stored, never relayed |
| Signaling (offer/answer/ICE) | Relayed over WebSocket, then discarded |

The server is a ~130-line static-file + signaling relay. Nothing is persisted.

## How it stays fast on slow connections

1. **Default preset caps video at 250 kbps, 480×270, ≤20 fps** via
   `RTCRtpSender.setParameters({ encodings: [{ maxBitrate }] })`, so the encoder
   never produces more than a slow link can carry.
2. **Audio-only preset (~50 kbps)** disables the video encoder entirely
   (`encodings[0].active = false`) for 2G/edge-of-coverage situations.
3. **Google Congestion Control (GCC)** — built into every WebRTC browser —
   continuously adapts the send rate below the cap using delay-gradient and
   loss feedback, so calls degrade gracefully instead of freezing.
4. **Peer-to-peer media path** — no media server hop, which minimizes latency
   and removes a bandwidth bottleneck.
5. **Mesh-aware upload budget** — group calls send a copy of your video to
   every peer, so the per-link cap is `preset ÷ peers`: total upload never
   exceeds the preset even with 3 peers connected.
6. Live quality switcher and an on-screen total-upload readout.

## Research basis

> **Bart Jansen, Timothy Goodwin, Varun Gupta, Fernando Kuipers, Gil Zussman.
> "Performance Evaluation of WebRTC-based Video Conferencing."**
> *IFIP WG 7.3 Performance 2017*, Nov 14–16 2017, New York, NY.
> ACM SIGMETRICS Performance Evaluation Review 45(3), 2018.
> PDF: https://wimnet.ee.columbia.edu/wp-content/uploads/2017/10/WebRTC-Performance.pdf

Findings from the paper that this app's design follows directly:

- **A WebRTC call can be established with as little as 20 kbps** of available
  bandwidth, and **250 kbps is enough for an acceptable 25 FPS video call at
  480×270** — exactly the resolution/bitrate this app uses as its default
  "Low bandwidth" preset (§4.1).
- Under a fixed bandwidth cap, WebRTC **uses ~80% of available bandwidth and
  holds a constant, stable data rate** — it does not oscillate or collapse on
  constrained links (§4.1, Fig. 5).
- With **packet loss up to 10%, calls survive**: GCC keeps the rate unchanged
  between 2–10% loss and converges to a ~50 kbps audio-dominated floor at 10%
  loss rather than dropping the call (§4.1, Fig. 7) — which is why the
  audio-only preset targets ~50 kbps.
- Added latency does **not** reduce the data rate (GCC responds to latency
  *variation*, not absolute latency), so calls remain usable on high-latency
  links (§4.1, Fig. 6).
- **Mesh (direct P2P) calls reach a stable rate roughly 2× faster than
  SFU-relayed calls** (~15 s vs ~30 s), supporting the serverless P2P media
  topology used here (§iii).

## Architecture

```
Browser A ──┐                       ┌── Browser B
            │  WebSocket signaling  │
            └──► Node server ◄──────┘      (offers/answers/ICE only)
            ┌───────────────────────┐
Browser A ◄─┤   WebRTC P2P (UDP)    ├─► Browser B
            └───────────────────────┘      (video + audio + chat)
```

## Files

- `server.js` — static file server + in-memory WebSocket signaling relay
- `public/app.js` — WebRTC perfect negotiation, bitrate presets, DataChannel chat
- `public/index.html`, `public/style.css` — UI
- `test-signaling.js` — signaling-protocol smoke test (`node test-signaling.js` with server running)

## Features

- Group calls up to 4 people (full mesh, perfect negotiation per peer pair)
- P2P group chat over DataChannels (broadcast to all peers)
- Camera flip (front/back) via `facingMode` + `replaceTrack` — no renegotiation
- Picture-in-Picture ("Float") so the call survives app switching on mobile
- Fullscreen, mute/camera toggles, live quality presets
- Responsive: phone / tablet / desktop

## Limitations

- 4 peers per room. The paper shows mesh beats SFU at small scale; bigger
  rooms would need an SFU and that's a different bandwidth story. Note the
  mesh trade-off: per-peer video quality drops as people join (shared upload
  budget).
- No TURN server configured: peers behind symmetric NATs on different networks
  may fail to connect. Add a TURN entry to `ICE_SERVERS` in `public/app.js`
  if needed (e.g. coturn).
- `getUserMedia` requires HTTPS in production (localhost is exempt). Put it
  behind TLS or a tunnel when deploying.
