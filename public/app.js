"use strict";

// Quality presets. Numbers follow Jansen et al. (IFIP Performance 2017):
// WebRTC sustains 25 FPS at 480x270 with only 250 kbps available, and an
// audio-only stream needs ~50 kbps. "low" is therefore the default.
// NOTE: in a mesh call the preset is the TOTAL upload budget — it gets
// split across peers (see applyBitrateCaps), so a slow uplink is never
// asked to carry preset × peers.
const PRESETS = {
  audio:  { video: false, maxBitrate: 0 },
  low:    { video: { width: { ideal: 480 }, height: { ideal: 270 }, frameRate: { max: 20 } }, maxBitrate: 250_000 },
  medium: { video: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { max: 25 } }, maxBitrate: 500_000 },
  high:   { video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { max: 30 } }, maxBitrate: 1_200_000 },
};

const ICE_SERVERS = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
];

const $ = (id) => document.getElementById(id);

const state = {
  ws: null,
  localStream: null,
  selfId: null,
  myName: null,
  room: null,
  preset: "low",
  facing: "user",
  // peerId -> { id, name, pc, channel, polite, makingOffer, ignoreOffer,
  //             tile, videoEl, lastBytes, lastTime }
  peers: new Map(),
  statsTimer: null,
  pingTimer: null,
};

// ---------- Join flow ----------

$("join-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  state.myName = $("name-input").value.trim();
  state.room = $("room-input").value.trim();
  state.preset = $("quality-select").value;
  $("live-quality").value = state.preset;
  $("join-error").hidden = true;

  await acquireMedia(state.preset);
  connectSignaling();
});

async function acquireMedia(presetKey) {
  const preset = PRESETS[presetKey];
  stopLocalTracks();
  try {
    state.localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: preset.video ? { ...preset.video, facingMode: state.facing } : false,
    });
  } catch {
    // No camera/mic (or permission denied): degrade to chat-only.
    state.localStream = null;
    $("local-label").textContent = "You (no media — chat only)";
  }
  $("local-video").srcObject = state.localStream;
  updateLocalMirror();
}

function stopLocalTracks() {
  if (state.localStream) for (const t of state.localStream.getTracks()) t.stop();
}

// Front camera previews mirrored (what users expect); back camera doesn't.
function updateLocalMirror() {
  $("local-video").classList.toggle("mirror", state.facing === "user");
}

function connectSignaling() {
  // Resolve relative to the page so the app works behind path-prefixed
  // tunnels/proxies (e.g. https://relay/t/<id>/ -> .../t/<id>/ws).
  const wsUrl = new URL("ws", location.href);
  wsUrl.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(wsUrl);
  state.ws = ws;

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "join", room: state.room, name: state.myName }));
    // App-level keepalive: tunnels answer protocol pings themselves, so the
    // server judges liveness on these messages.
    state.pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
    }, 10_000);
  };

  ws.onmessage = async (e) => {
    const msg = JSON.parse(e.data);
    switch (msg.type) {
      case "joined":
        state.selfId = msg.selfId;
        showCallScreen();
        // Newcomer initiates a connection to everyone already in the room.
        for (const p of msg.peers) createPeer(p.id, p.name, true);
        break;
      case "peer-joined":
        createPeer(msg.id, msg.name, false);
        addSystemMessage(`${msg.name} joined`);
        break;
      case "peer-left":
        addSystemMessage(`${msg.name || "Peer"} left`);
        destroyPeer(msg.id);
        break;
      case "signal":
        await handleSignal(msg);
        break;
      case "room-full":
        showJoinError("Room is full (4 participants max).");
        ws.close();
        break;
      case "error":
        showJoinError(msg.reason || "Could not join.");
        ws.close();
        break;
    }
  };

  ws.onclose = () => {
    clearInterval(state.pingTimer);
    state.pingTimer = null;
    setConnState("disconnected");
  };
}

function sendLeave() {
  if (state.ws?.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type: "leave" }));
  }
  state.ws?.close();
}

// Free the room slot even when the tab is closed instead of pressing Leave.
window.addEventListener("pagehide", sendLeave);

function showJoinError(text) {
  stopLocalTracks();
  $("join-error").textContent = text;
  $("join-error").hidden = false;
  $("call-screen").hidden = true;
  $("join-screen").hidden = false;
}

function showCallScreen() {
  $("join-screen").hidden = true;
  $("call-screen").hidden = false;
  $("room-label").textContent = `#${state.room}`;
  setConnState("waiting for others…");
  addSystemMessage(`You joined #${state.room}. Messages are peer-to-peer and not stored anywhere.`);
  startStats();
}

// ---------- WebRTC mesh (perfect negotiation per peer) ----------

function createPeer(peerId, peerName, isInitiator) {
  if (state.peers.has(peerId)) return;

  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const peer = {
    id: peerId,
    name: peerName,
    pc,
    channel: null,
    // Both ends derive the same role from the ID pair, so offer collisions
    // during renegotiation always resolve the same way.
    polite: state.selfId < peerId,
    makingOffer: false,
    ignoreOffer: false,
    pendingCandidates: [],
    tile: null,
    videoEl: null,
    lastBytes: 0,
    lastTime: 0,
  };
  state.peers.set(peerId, peer);

  if (state.localStream) {
    for (const track of state.localStream.getTracks()) pc.addTrack(track, state.localStream);
  }

  pc.ontrack = (e) => {
    ensureTile(peer);
    if (peer.videoEl.srcObject !== e.streams[0]) peer.videoEl.srcObject = e.streams[0];
  };

  pc.onicecandidate = (e) => {
    if (e.candidate) sendSignal(peerId, { candidate: e.candidate });
  };

  pc.onnegotiationneeded = async () => {
    // addTrack fires this on BOTH ends at setup. If both send initial
    // offers, the impolite side drops the other's offer AND its trickled
    // candidates, and that link can stall in "new" forever. Only the
    // initiator opens; the other side answers (renegotiations still flow
    // because by then remoteDescription is set).
    if (!isInitiator && !pc.remoteDescription) return;
    try {
      peer.makingOffer = true;
      await pc.setLocalDescription();
      sendSignal(peerId, { description: pc.localDescription });
    } finally {
      peer.makingOffer = false;
    }
  };

  pc.onconnectionstatechange = () => {
    updateConnState();
    if (pc.connectionState === "connected") applyBitrateCaps();
  };

  if (isInitiator) {
    wireChatChannel(peer, pc.createDataChannel("chat"));
  } else {
    pc.ondatachannel = (e) => wireChatChannel(peer, e.channel);
  }

  ensureTile(peer);
  applyBitrateCaps();
}

async function handleSignal({ from, data }) {
  const peer = state.peers.get(from);
  if (!peer) return;
  const pc = peer.pc;

  if (data.description) {
    const offerCollision =
      data.description.type === "offer" &&
      (peer.makingOffer || pc.signalingState !== "stable");
    peer.ignoreOffer = !peer.polite && offerCollision;
    if (peer.ignoreOffer) return;

    await pc.setRemoteDescription(data.description);
    // Candidates that arrived before the remote description can now apply.
    for (const c of peer.pendingCandidates.splice(0)) {
      await pc.addIceCandidate(c).catch(() => {});
    }
    if (data.description.type === "offer") {
      await pc.setLocalDescription();
      sendSignal(from, { description: pc.localDescription });
    }
  } else if (data.candidate) {
    if (!pc.remoteDescription) {
      peer.pendingCandidates.push(data.candidate);
      return;
    }
    try {
      await pc.addIceCandidate(data.candidate);
    } catch (err) {
      if (!peer.ignoreOffer) throw err;
    }
  }
}

function sendSignal(to, data) {
  if (state.ws?.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type: "signal", to, data }));
  }
}

function destroyPeer(peerId) {
  const peer = state.peers.get(peerId);
  if (!peer) return;
  state.peers.delete(peerId);
  peer.channel?.close();
  peer.pc.close();
  peer.tile?.remove();
  $("waiting-tile").hidden = state.peers.size > 0;
  updateConnState();
  applyBitrateCaps();
}

function destroyAllPeers() {
  for (const id of [...state.peers.keys()]) destroyPeer(id);
}

function ensureTile(peer) {
  if (peer.tile) return;
  const tile = document.createElement("div");
  tile.className = "video-tile";
  const video = document.createElement("video");
  video.autoplay = true;
  video.playsInline = true;
  const label = document.createElement("span");
  label.className = "tile-label";
  label.textContent = peer.name;
  tile.append(video, label);
  $("video-grid").appendChild(tile);
  peer.tile = tile;
  peer.videoEl = video;
  $("waiting-tile").hidden = true;
}

function updateConnState() {
  const connected = [...state.peers.values()].filter(
    (p) => p.pc.connectionState === "connected"
  ).length;
  if (state.peers.size === 0) setConnState("waiting for others…");
  else setConnState(`${connected}/${state.peers.size} connected`);
}

// Split the preset's upload budget across peers: a mesh sends a copy of
// the video to every peer, so per-link caps keep TOTAL upload within what
// a slow connection can carry. This is the core low-bandwidth control.
async function applyBitrateCaps() {
  const preset = PRESETS[state.preset];
  const share = Math.max(1, state.peers.size);
  for (const peer of state.peers.values()) {
    for (const sender of peer.pc.getSenders()) {
      if (sender.track?.kind !== "video") continue;
      sender.track.contentHint = "motion";
      const params = sender.getParameters();
      params.encodings = params.encodings?.length ? params.encodings : [{}];
      params.encodings[0].maxBitrate = preset.maxBitrate
        ? Math.floor(preset.maxBitrate / share)
        : undefined;
      params.encodings[0].active = state.preset !== "audio";
      params.degradationPreference = "maintain-framerate";
      try {
        await sender.setParameters(params);
      } catch {
        /* older browsers: GCC still adapts on its own */
      }
    }
  }
}

// ---------- Chat over DataChannels (never touches the server) ----------

function wireChatChannel(peer, ch) {
  peer.channel = ch;
  ch.onopen = () => addSystemMessage(`Chat connected with ${peer.name}.`);
  ch.onmessage = (e) => {
    try {
      const { name, text } = JSON.parse(e.data);
      addChatMessage(name, text, false);
    } catch {
      /* ignore malformed */
    }
  };
}

$("chat-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("chat-input");
  const text = input.value.trim();
  if (!text) return;
  const payload = JSON.stringify({ name: state.myName, text });
  let sent = 0;
  for (const peer of state.peers.values()) {
    if (peer.channel?.readyState === "open") {
      peer.channel.send(payload);
      sent++;
    }
  }
  if (sent > 0) {
    addChatMessage(state.myName, text, true);
    input.value = "";
  } else {
    addSystemMessage("No one connected yet — message not sent.");
  }
});

function addChatMessage(name, text, mine) {
  const el = document.createElement("div");
  el.className = `msg ${mine ? "mine" : "theirs"}`;
  const who = document.createElement("span");
  who.className = "who";
  who.textContent = name;
  const body = document.createElement("span");
  body.className = "body";
  body.textContent = text;
  el.append(who, body);
  appendMessage(el);
}

function addSystemMessage(text) {
  const el = document.createElement("div");
  el.className = "msg system";
  el.textContent = text;
  appendMessage(el);
}

function appendMessage(el) {
  const box = $("messages");
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
}

// ---------- Controls ----------

$("mic-btn").addEventListener("click", () => {
  const track = state.localStream?.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  $("mic-btn").textContent = track.enabled ? "Mic on" : "Mic off";
});

$("cam-btn").addEventListener("click", () => {
  const track = state.localStream?.getVideoTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  $("cam-btn").textContent = track.enabled ? "Cam on" : "Cam off";
});

$("flip-btn").addEventListener("click", async () => {
  const oldTrack = state.localStream?.getVideoTracks()[0];
  if (!oldTrack) return addSystemMessage("No camera active.");

  const newFacing = state.facing === "user" ? "environment" : "user";
  const preset = PRESETS[state.preset].video ? PRESETS[state.preset] : PRESETS.low;
  const grab = (video) => navigator.mediaDevices.getUserMedia({ video, audio: false });
  const oldDeviceId = oldTrack.getSettings().deviceId;

  // Phones can't open a second camera while the first is live —
  // release the current one BEFORE asking for the other.
  oldTrack.stop();
  state.localStream.removeTrack(oldTrack);

  let newTrack = null;
  let flipped = true;
  // 1st choice: the camera facing the other way.
  try {
    newTrack = (await grab({ ...preset.video, facingMode: { exact: newFacing } })).getVideoTracks()[0];
  } catch {
    // 2nd: any other physical camera by device id (covers phones that
    // mislabel facing, tablets with odd camera order, etc.).
    try {
      const cams = (await navigator.mediaDevices.enumerateDevices()).filter(
        (d) => d.kind === "videoinput" && d.deviceId && d.deviceId !== oldDeviceId
      );
      if (cams.length) {
        newTrack = (await grab({ ...preset.video, deviceId: { exact: cams[0].deviceId } })).getVideoTracks()[0];
      }
    } catch {
      /* fall through to recovery */
    }
  }
  // Last resort: reacquire the original camera so video doesn't go black.
  if (!newTrack) {
    flipped = false;
    addSystemMessage("No other camera found on this device.");
    try {
      const video = oldDeviceId
        ? { ...preset.video, deviceId: { exact: oldDeviceId } }
        : { ...preset.video, facingMode: state.facing };
      newTrack = (await grab(video)).getVideoTracks()[0];
    } catch {
      return addSystemMessage("Camera unavailable — toggle Cam or rejoin to restore video.");
    }
  }

  if (flipped) {
    // Trust what the device reports over what we asked for.
    state.facing = newTrack.getSettings().facingMode || newFacing;
  }
  state.localStream.addTrack(newTrack);
  // replaceTrack swaps the outgoing video without renegotiating.
  for (const peer of state.peers.values()) {
    const sender = peer.pc.getSenders().find((s) => s.track?.kind === "video");
    if (sender) await sender.replaceTrack(newTrack);
  }
  $("local-video").srcObject = state.localStream;
  updateLocalMirror();
  applyBitrateCaps();
});

$("live-quality").addEventListener("change", async (e) => {
  state.preset = e.target.value;
  const track = state.localStream?.getVideoTracks()[0];
  const preset = PRESETS[state.preset];
  if (track && preset.video) {
    try {
      await track.applyConstraints(preset.video);
    } catch {
      /* keep current resolution if constraints unsupported */
    }
  }
  await applyBitrateCaps();
  addSystemMessage(`Quality preset: ${state.preset}`);
});

// ---------- Picture-in-Picture: float a peer's video over other apps ----------

function firstRemoteVideo() {
  for (const peer of state.peers.values()) {
    if (peer.videoEl?.srcObject) return peer.videoEl;
  }
  return null;
}

async function enterPip() {
  const video = firstRemoteVideo();
  if (!video) throw new Error("no remote video");
  if (video.requestPictureInPicture) {
    await video.requestPictureInPicture();
  } else if (video.webkitSetPresentationMode) {
    // iOS Safari
    video.webkitSetPresentationMode("picture-in-picture");
  } else {
    throw new Error("unsupported");
  }
}

$("pip-btn").addEventListener("click", async () => {
  try {
    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture();
    } else {
      await enterPip();
    }
  } catch {
    addSystemMessage("Floating video needs an active peer video first.");
  }
});

document.addEventListener("enterpictureinpicture", () => {
  $("pip-btn").textContent = "Unfloat";
}, true);
document.addEventListener("leavepictureinpicture", () => {
  $("pip-btn").textContent = "Float";
}, true);

// Auto-float when the app goes to background mid-call. Browsers that
// require a gesture (or the Auto-PiP permission) reject silently — the
// manual Float button is the guaranteed path.
document.addEventListener("visibilitychange", () => {
  const anyConnected = [...state.peers.values()].some(
    (p) => p.pc.connectionState === "connected"
  );
  if (
    document.visibilityState === "hidden" &&
    anyConnected &&
    !document.pictureInPictureElement
  ) {
    enterPip().catch(() => {});
  }
});

// Chrome's sanctioned auto-PiP hook for video-call sites.
if (navigator.mediaSession?.setActionHandler) {
  try {
    navigator.mediaSession.setActionHandler("enterpictureinpicture", () => enterPip());
  } catch {
    /* action not supported in this browser */
  }
}

// ---------- Fullscreen ----------

$("fs-btn").addEventListener("click", async () => {
  const container = $("videos");
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else if (container.requestFullscreen) {
      await container.requestFullscreen();
    } else {
      const v = firstRemoteVideo();
      // iPhone Safari: only the <video> element itself can go fullscreen.
      if (v?.webkitEnterFullscreen) v.webkitEnterFullscreen();
    }
  } catch {
    /* fullscreen blocked: nothing to do */
  }
});

document.addEventListener("fullscreenchange", () => {
  const active = !!document.fullscreenElement;
  $("fs-btn").textContent = active ? "✕" : "⛶";
  $("fs-btn").title = active ? "Exit full screen" : "Full screen";
});

// ---------- Leave ----------

$("leave-btn").addEventListener("click", () => {
  sendLeave();
  destroyAllPeers();
  stopStats();
  stopLocalTracks();
  state.localStream = null;
  $("local-video").srcObject = null;
  $("messages").replaceChildren();
  $("call-screen").hidden = true;
  $("join-screen").hidden = false;
});

// ---------- Live total-upload readout ----------

function startStats() {
  stopStats();
  state.statsTimer = setInterval(async () => {
    let total = 0;
    let any = false;
    for (const peer of state.peers.values()) {
      const stats = await peer.pc.getStats();
      for (const report of stats.values()) {
        if (report.type === "outbound-rtp" && report.kind === "video") {
          if (peer.lastTime) {
            total += ((report.bytesSent - peer.lastBytes) * 8) / (report.timestamp - peer.lastTime);
            any = true;
          }
          peer.lastBytes = report.bytesSent;
          peer.lastTime = report.timestamp;
        }
      }
    }
    $("stats").textContent = any ? `↑ ${Math.round(total)} kbps` : "";
  }, 2000);
}

function stopStats() {
  if (state.statsTimer) clearInterval(state.statsTimer);
  state.statsTimer = null;
  $("stats").textContent = "";
}

function setConnState(text) {
  $("conn-state").textContent = text;
}
