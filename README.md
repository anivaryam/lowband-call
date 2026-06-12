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

The server is a small static-file + signaling relay. Nothing is persisted.

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
6. Live quality switcher and an on-screen up/down bitrate readout.
7. **Camera off = zero video bytes** — the toggle uses `replaceTrack(null)`,
   which stops the RTP stream outright (a merely *disabled* track keeps
   shipping black keyframes). Peers show a letter avatar instead.
8. **The app itself is ~15 KB over the wire** — brotli/gzip-compressed
   static assets, ETag revalidation (repeat visits are 0-byte 304s), inline
   SVG icon sprite, zero webfonts, zero CDN requests.

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
- P2P group chat over DataChannels (broadcast to all peers), with unread
  badge and a bottom-sheet layout on phones
- Camera flip (front/back) via `facingMode` + `replaceTrack` — no renegotiation
- Screen sharing (`getDisplayMedia` + `replaceTrack`, capped at 15 fps with
  `contentHint: "detail"` so text stays sharp inside the bitrate budget);
  peers letterbox the screen instead of cropping it; auto-reverts to camera
  when the browser's "Stop sharing" bar is used; hidden where unsupported
  (iOS Safari)
- Floating call, three tiers by platform: Document PiP on desktop Chromium
  (whole grid floats), video PiP on Android Chrome, WebKit presentation mode
  on iOS Safari (+ `autoPictureInPicture` for system auto-float on
  app-switch); mic/cam/hang-up exposed in the system PiP overlay via Media
  Session video-conferencing actions; float follows to the next peer if the
  floated one leaves
- Fullscreen, mute/camera toggles, live quality presets (icon dock,
  keyboard shortcuts: `m` mic, `c` camera, `f` fullscreen)
- Invite deep links — the room rides in the URL hash (`/#room-name`),
  share button copies it
- Letter avatars for peers without live video (voice preset / camera off)
- Name and preset remembered locally (`localStorage`); nothing on the server
- Responsive: phone / tablet / desktop; respects `prefers-reduced-motion`

## Security hardening

- Strict CSP (`default-src 'self'`, no inline script), `X-Frame-Options: DENY`,
  `nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy` scoping
  camera/mic to same origin
- Static path traversal blocked at two layers (URL normalization + root-prefix
  check)
- WebSocket hardening: 128 KB max payload, per-socket token-bucket rate
  limiting, shape-validated relay messages, room-count cap
- Peer-supplied chat payloads are type-checked and length-capped client-side
  (chat is P2P — the server never sees it, so the client must validate)

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
