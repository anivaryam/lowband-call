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

// Defense-in-depth caps on PEER-SUPPLIED data (chat travels peer-to-peer,
// so the server can't sanitize it for us).
const MAX_NAME = 32;
const MAX_TEXT = 2000;

const $ = (id) => document.getElementById(id);
const setUse = (id, symbol) => $(id).setAttribute("href", `#${symbol}`);

const state = {
  ws: null,
  localStream: null,
  selfId: null,
  myName: null,
  room: null,
  preset: "low",
  facing: "user",
  // peerId -> { id, name, pc, channel, polite, makingOffer, ignoreOffer,
  //             tile, videoEl, lastBytes, lastTime, lastBytesIn, lastTimeIn }
  peers: new Map(),
  statsTimer: null,
  pingTimer: null,
  unread: 0,
  camOff: false,
  docPip: null, // Document Picture-in-Picture window, when active
  screenTrack: null, // live getDisplayMedia track while sharing
  screenStream: null,
};

// ---------- Join flow ----------

// Deep link + last-used prefills. Room rides in the hash so an invite link
// drops the receiver straight onto the right channel.
(function prefill() {
  const hashRoom = decodeURIComponent(location.hash.slice(1));
  if (hashRoom) $("room-input").value = hashRoom.slice(0, 64);
  const savedName = localStorage.getItem("lb_name");
  if (savedName) $("name-input").value = savedName;
  const savedPreset = localStorage.getItem("lb_preset");
  if (savedPreset && PRESETS[savedPreset]) checkQualityRadios(savedPreset);
})();

function qualityValue(group) {
  return document.querySelector(`input[name="${group}"]:checked`)?.value || "low";
}

function checkQualityRadios(preset) {
  for (const group of ["qjoin", "qlive"]) {
    const el = document.querySelector(`input[name="${group}"][value="${preset}"]`);
    if (el) el.checked = true;
  }
}

$("join-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  state.myName = $("name-input").value.trim().slice(0, MAX_NAME);
  state.room = $("room-input").value.trim();
  state.preset = qualityValue("qjoin");
  checkQualityRadios(state.preset);
  localStorage.setItem("lb_name", state.myName);
  localStorage.setItem("lb_preset", state.preset);
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
    $("local-label").textContent = `${state.myName || "You"} (chat only)`;
  }
  $("local-video").srcObject = state.localStream;
  $("local-tile").classList.toggle("no-video", !state.localStream || presetKey === "audio");
  $("local-tile").dataset.letter = (state.myName || "?")[0].toUpperCase();
  resetMediaButtons();
  updateLocalMirror();
}

function stopLocalTracks() {
  if (state.localStream) for (const t of state.localStream.getTracks()) t.stop();
}

// Front camera previews mirrored — the bathroom-mirror convention every
// call app follows. ONLY the local preview mirrors; peers always receive
// the un-mirrored feed. Back camera and screen share must never mirror
// (text would read backwards).
function updateLocalMirror() {
  $("local-video").classList.toggle(
    "mirror",
    state.facing === "user" && !state.screenTrack
  );
}

function connectSignaling() {
  // Re-entry safety: a join while a session is live (double submit, error
  // recovery) must tear the old one down first, or the old socket leaks,
  // its keepalive closure pings it forever, and the server keeps a zombie
  // in the room.
  clearInterval(state.pingTimer);
  state.pingTimer = null;
  if (state.ws) {
    state.ws.onclose = null;
    sendLeave();
  }
  destroyAllPeers();

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
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
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
    setConnState("disconnected", "bad");
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
  // Shareable invite: reload or send the URL and land on this channel.
  history.replaceState(null, "", `#${encodeURIComponent(state.room)}`);
  // Chat starts open where there's room for it, closed on phones.
  $("call-screen").classList.toggle("chat-open", window.matchMedia("(min-width: 901px)").matches);
  setUnread(0);
  setConnState("awaiting peers", "wait");
  addSystemMessage(`You joined #${state.room}. Messages are peer-to-peer and not stored anywhere.`);
  // Names the call in the system PiP overlay / lock-screen controls.
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: `#${state.room}`,
      artist: "Lowband Call",
    });
  } catch {
    /* MediaMetadata unsupported */
  }
  syncMediaSessionState();
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
    lastBytesIn: 0,
    lastTimeIn: 0,
  };
  state.peers.set(peerId, peer);

  if (state.localStream) {
    for (const track of state.localStream.getTracks()) pc.addTrack(track, state.localStream);
    // A peer joining mid-call must see what everyone else sees: the shared
    // screen if one is up, or nothing if the camera is toggled off.
    const vSender = pc.getSenders().find((s) => s.track?.kind === "video");
    if (state.screenTrack) vSender?.replaceTrack(state.screenTrack).catch(() => {});
    else if (state.camOff) vSender?.replaceTrack(null).catch(() => {});
  } else if (state.screenTrack) {
    // Chat-only sharer: the screen track is the only thing to offer.
    pc.addTrack(state.screenTrack, state.screenStream);
  }

  pc.ontrack = (e) => {
    ensureTile(peer);
    if (peer.videoEl.srcObject !== e.streams[0]) peer.videoEl.srcObject = e.streams[0];
    // Receiver-side mute fires when the sender's camera stops delivering
    // frames (cam toggled off, voice preset) — swap to the letter avatar
    // instead of leaving a frozen/black frame.
    if (e.track.kind === "video") {
      const sync = () => peer.tile.classList.toggle("no-video", e.track.muted);
      e.track.onmute = sync;
      e.track.onunmute = sync;
      sync();
    }
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
    // ICE gave up on this link: drop the dead tile instead of showing a
    // frozen frame forever. (transient "disconnected" recovers on its own.)
    if (pc.connectionState === "failed") {
      addSystemMessage(`Connection to ${peer.name} lost.`);
      destroyPeer(peerId);
    }
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
  if (!peer || !data || typeof data !== "object") return;
  const pc = peer.pc;

  if (data.description) {
    const offerCollision =
      data.description.type === "offer" &&
      (peer.makingOffer || pc.signalingState !== "stable");
    peer.ignoreOffer = !peer.polite && offerCollision;
    if (peer.ignoreOffer) return;
    // Stale/duplicate answer (e.g. coalesced double-offer races): applying
    // an answer in "stable" throws and would kill this handler.
    if (data.description.type === "answer" && pc.signalingState === "stable") return;

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
  const wasFloating = document.pictureInPictureElement === peer.videoEl;
  peer.channel?.close();
  peer.pc.close();
  peer.tile?.remove();
  $("waiting-tile").hidden = state.peers.size > 0;
  // Hand the float window (and the iOS auto-PiP flag) to the next peer
  // instead of leaving a dead frame floating over other apps.
  const next = firstRemoteVideo();
  if (next && "autoPictureInPicture" in next) next.autoPictureInPicture = true;
  if (wasFloating) {
    document.exitPictureInPicture?.().then(() => {
      if (next) enterPip().catch(() => {});
    }).catch(() => {});
  }
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
  // Until a live video track arrives this peer shows as a letter avatar
  // (covers voice-preset peers, who never send video at all).
  tile.dataset.letter = (peer.name || "?")[0].toUpperCase();
  tile.classList.add("no-video");
  // iOS Safari: flag one remote video for system auto-PiP on home-swipe /
  // app switch (the JS visibilitychange path is gesture-gated there).
  if ("autoPictureInPicture" in video && !firstRemoteVideo()) {
    video.autoPictureInPicture = true;
  }
  // iOS fires webkit presentation events instead of the standard PiP ones.
  video.addEventListener("webkitpresentationmodechanged", () => {
    const float = video.webkitPresentationMode === "picture-in-picture";
    $("pip-btn").setAttribute("aria-pressed", String(float));
    $("pip-btn").title = float ? "Unfloat video" : "Float their video";
  });
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
  if (state.peers.size === 0) setConnState("awaiting peers", "wait");
  else if (connected === state.peers.size) setConnState(`${connected} linked`, "ok");
  else setConnState(`${connected}/${state.peers.size} linked`, "wait");
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
      // Camera: keep motion smooth, let resolution drop. Screen: the
      // opposite — text must stay legible, frame rate can crawl.
      sender.track.contentHint = state.screenTrack ? "detail" : "motion";
      const params = sender.getParameters();
      params.encodings = params.encodings?.length ? params.encodings : [{}];
      params.encodings[0].maxBitrate = preset.maxBitrate
        ? Math.floor(preset.maxBitrate / share)
        : undefined;
      params.encodings[0].active = state.preset !== "audio";
      params.degradationPreference = state.screenTrack
        ? "maintain-resolution"
        : "maintain-framerate";
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
  ch.onopen = () => {
    addSystemMessage(`Chat connected with ${peer.name}.`);
    // Late joiner: tell them a share is already running so their tile of
    // us renders letterboxed instead of cropped.
    if (state.screenTrack && ch.readyState === "open") {
      ch.send(JSON.stringify({ sys: "screen", on: true }));
    }
  };
  ch.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      // Control message: peer started/stopped screen sharing. Screen
      // content needs object-fit: contain (whole screen visible); cameras
      // look better cropped to fill.
      if (msg.sys === "screen") {
        peer.tile?.classList.toggle("screen", msg.on === true);
        return;
      }
      const { name, text } = msg;
      if (typeof name !== "string" || typeof text !== "string" || !text.trim()) return;
      addChatMessage(name.slice(0, MAX_NAME), text.slice(0, MAX_TEXT), false);
    } catch {
      /* ignore malformed */
    }
  };
}

function broadcastScreenState(on) {
  const payload = JSON.stringify({ sys: "screen", on });
  for (const peer of state.peers.values()) {
    if (peer.channel?.readyState === "open") peer.channel.send(payload);
  }
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
  if (!mine && !isChatOpen()) setUnread(state.unread + 1);
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

// ---------- Chat panel toggle + unread badge ----------

function isChatOpen() {
  return $("call-screen").classList.contains("chat-open");
}

function setUnread(n) {
  state.unread = n;
  const badge = $("chat-badge");
  badge.hidden = n === 0;
  badge.textContent = n > 9 ? "9+" : String(n);
}

function toggleChat(force) {
  const open = $("call-screen").classList.toggle("chat-open", force);
  if (open) {
    setUnread(0);
    // Focus the composer where a keyboard won't pop over the call.
    if (window.matchMedia("(pointer: fine)").matches) $("chat-input").focus();
  }
  return open;
}

$("chat-btn").addEventListener("click", () => toggleChat());
$("chat-close").addEventListener("click", () => toggleChat(false));

// ---------- Controls ----------

function resetMediaButtons() {
  state.camOff = false;
  for (const [btn, icon, on] of [["mic-btn", "mic-icon", "i-mic"], ["cam-btn", "cam-icon", "i-cam"]]) {
    $(btn).classList.remove("off");
    $(btn).setAttribute("aria-pressed", "false");
    setUse(icon, on);
  }
  $("mic-btn").title = "Mute microphone (m)";
  $("cam-btn").title = "Turn camera off (c)";
}

function toggleTrack(kind) {
  const track =
    kind === "audio"
      ? state.localStream?.getAudioTracks()[0]
      : state.localStream?.getVideoTracks()[0];
  if (!track) {
    addSystemMessage(kind === "audio" ? "No microphone available." : "No camera available.");
    return;
  }
  let off;
  if (kind === "video") {
    // Logical cam state lives in state.camOff (not track.enabled) so a
    // camera flip while off can't desync the toggle.
    off = !state.camOff;
    state.camOff = off;
    track.enabled = !off;
    // replaceTrack(null) stops the RTP stream outright — a disabled track
    // would still ship black keyframes. Off = zero video bytes on the wire,
    // and peers get a track-mute event that flips their tile to the avatar.
    for (const peer of state.peers.values()) {
      // when off, the video sender is the one holding a null track
      const sender = peer.pc
        .getSenders()
        .find((s) => (off ? s.track?.kind === "video" : !s.track));
      if (sender) sender.replaceTrack(off ? null : track).catch(() => {});
    }
    $("local-tile").classList.toggle("no-video", off || !state.localStream);
  } else {
    track.enabled = !track.enabled;
    off = !track.enabled;
  }
  const [btn, icon, onSym, offSym, onTitle, offTitle] =
    kind === "audio"
      ? ["mic-btn", "mic-icon", "i-mic", "i-mic-off", "Mute microphone (m)", "Unmute microphone (m)"]
      : ["cam-btn", "cam-icon", "i-cam", "i-cam-off", "Turn camera off (c)", "Turn camera on (c)"];
  $(btn).classList.toggle("off", off);
  $(btn).setAttribute("aria-pressed", String(off));
  $(btn).title = off ? offTitle : onTitle;
  $(btn).setAttribute("aria-label", off ? offTitle : onTitle);
  setUse(icon, off ? offSym : onSym);
  syncMediaSessionState();
}

$("mic-btn").addEventListener("click", () => toggleTrack("audio"));
$("cam-btn").addEventListener("click", () => toggleTrack("video"));

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
  // replaceTrack swaps the outgoing video without renegotiating. While a
  // screen share or cam-off owns the senders, only the local stream is
  // updated — the new camera goes live when the share/mute ends.
  if (!state.screenTrack && !state.camOff) {
    for (const peer of state.peers.values()) {
      const sender = peer.pc.getSenders().find((s) => s.track?.kind === "video");
      if (sender) await sender.replaceTrack(newTrack);
    }
  }
  if (!state.screenTrack) {
    $("local-video").srcObject = state.localStream;
    updateLocalMirror();
  }
  applyBitrateCaps();
});

// ---------- Screen share (replaceTrack, same pattern as camera flip) ----------

function videoSenders() {
  return [...state.peers.values()]
    .map((p) => p.pc.getSenders().find((s) => s.track?.kind === "video" || !s.track))
    .filter(Boolean);
}

async function startScreenShare() {
  // Browser picker. Audio false: tab/system audio would eat the thin
  // uplink this app exists to protect.
  const display = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: { max: 15 } },
    audio: false,
  });
  const track = display.getVideoTracks()[0];
  state.screenTrack = track;
  state.screenStream = display;
  for (const peer of state.peers.values()) {
    const sender = peer.pc.getSenders().find((s) => s.track?.kind === "video" || !s.track);
    // Chat-only users have no video sender yet — addTrack renegotiates.
    if (sender) sender.replaceTrack(track).catch(() => {});
    else peer.pc.addTrack(track, display);
  }
  // Local preview shows the screen, never mirrored, never cropped.
  $("local-video").srcObject = display;
  $("local-tile").classList.remove("no-video");
  $("local-tile").classList.add("screen");
  updateLocalMirror();
  setScreenButton(true);
  broadcastScreenState(true);
  await applyBitrateCaps();
  addSystemMessage("Sharing your screen.");
  // Browser's own "Stop sharing" bar ends the track — follow it.
  track.onended = () => stopScreenShare();
}

function stopScreenShare() {
  if (!state.screenTrack) return;
  state.screenTrack.onended = null;
  state.screenTrack.stop();
  state.screenTrack = null;
  state.screenStream = null;
  const cam = state.localStream?.getVideoTracks()[0] || null;
  const next = state.camOff ? null : cam;
  for (const sender of videoSenders()) sender.replaceTrack(next).catch(() => {});
  $("local-video").srcObject = state.localStream;
  $("local-tile").classList.toggle("no-video", state.camOff || !cam);
  $("local-tile").classList.remove("screen");
  updateLocalMirror();
  setScreenButton(false);
  broadcastScreenState(false);
  applyBitrateCaps();
  addSystemMessage("Screen sharing stopped.");
}

function setScreenButton(on) {
  $("screen-btn").classList.toggle("on", on);
  $("screen-btn").setAttribute("aria-pressed", String(on));
  $("screen-btn").title = on ? "Stop sharing (s)" : "Share screen (s)";
  $("screen-btn").setAttribute("aria-label", $("screen-btn").title);
  setUse("screen-icon", on ? "i-screen-off" : "i-screen");
}

$("screen-btn").addEventListener("click", async () => {
  try {
    if (state.screenTrack) stopScreenShare();
    else await startScreenShare();
  } catch {
    /* user cancelled the picker */
  }
});

// No getDisplayMedia (iOS Safari, older browsers): hide the button rather
// than show a dead control.
if (!navigator.mediaDevices?.getDisplayMedia) $("screen-btn").hidden = true;

for (const radio of document.querySelectorAll('input[name="qlive"]')) {
  radio.addEventListener("change", async (e) => {
    state.preset = e.target.value;
    localStorage.setItem("lb_preset", state.preset);
    checkQualityRadios(state.preset);
    const track = state.localStream?.getVideoTracks()[0];
    const preset = PRESETS[state.preset];
    if (track && preset.video) {
      try {
        await track.applyConstraints(preset.video);
      } catch {
        /* keep current resolution if constraints unsupported */
      }
    }
    $("local-tile").classList.toggle(
      "no-video",
      !state.localStream || state.preset === "audio"
    );
    await applyBitrateCaps();
    addSystemMessage(`Bandwidth preset: ${state.preset}`);
  });
}

// ---------- Share invite link ----------

$("share-btn").addEventListener("click", async () => {
  const url = `${location.origin}${location.pathname}#${encodeURIComponent(state.room)}`;
  try {
    if (navigator.share) {
      await navigator.share({ title: "Lowband Call", url });
    } else {
      await navigator.clipboard.writeText(url);
      addSystemMessage("Invite link copied.");
    }
  } catch {
    addSystemMessage(`Invite link: ${url}`);
  }
});

// ---------- Picture-in-Picture: float the call over other apps ----------
// Three tiers, best available wins:
//   1. Document PiP (desktop Chromium): the WHOLE video grid floats — every
//      peer stays visible while you work in other windows.
//   2. Video PiP (Android Chrome, desktop): first remote video floats.
//   3. webkitSetPresentationMode (iOS Safari): same, via WebKit API.

function firstRemoteVideo() {
  for (const peer of state.peers.values()) {
    if (peer.videoEl?.srcObject) return peer.videoEl;
  }
  return null;
}

async function enterDocPip() {
  const pipWin = await documentPictureInPicture.requestWindow({
    width: 400,
    height: 260,
  });
  // Same-origin stylesheet carries over by href; tiles keep their look.
  for (const link of document.querySelectorAll('link[rel="stylesheet"]')) {
    pipWin.document.head.appendChild(link.cloneNode());
  }
  pipWin.document.body.className = "pip-doc";
  // MOVE (not copy) the grid AND the local self-view: MediaStream-backed
  // <video> keeps playing across documents, and tiles for joining/leaving
  // peers keep landing in the floated grid because it's the same node.
  // Keep node refs — once moved, the main document can't look them up.
  const grid = $("video-grid");
  const localTile = $("local-tile");
  pipWin.document.body.append(grid, localTile);
  state.docPip = pipWin;
  $("pip-btn").setAttribute("aria-pressed", "true");
  $("pip-btn").title = "Unfloat call";
  pipWin.addEventListener("pagehide", () => {
    // Put both back where they live (positions are absolute; order vs the
    // dock doesn't matter visually).
    $("videos")?.append(grid, localTile);
    state.docPip = null;
    $("pip-btn").setAttribute("aria-pressed", "false");
    $("pip-btn").title = "Float the call";
  });
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
    if (state.docPip) {
      state.docPip.close();
    } else if (document.pictureInPictureElement) {
      await document.exitPictureInPicture();
    } else if (window.documentPictureInPicture) {
      await enterDocPip();
    } else {
      await enterPip();
    }
  } catch {
    addSystemMessage("Floating video needs an active peer video first.");
  }
});

document.addEventListener("enterpictureinpicture", () => {
  $("pip-btn").setAttribute("aria-pressed", "true");
  $("pip-btn").title = "Unfloat video";
}, true);
document.addEventListener("leavepictureinpicture", () => {
  $("pip-btn").setAttribute("aria-pressed", "false");
  $("pip-btn").title = "Float their video";
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
    !document.pictureInPictureElement &&
    !state.docPip
  ) {
    enterPip().catch(() => {});
  }
});

// Chrome's sanctioned auto-PiP hook for video-call sites, plus the
// video-conferencing actions: mic / camera / hang-up buttons rendered
// INSIDE the system PiP overlay and on the lock screen.
if (navigator.mediaSession?.setActionHandler) {
  const actions = [
    ["enterpictureinpicture", () => enterPip()],
    ["togglemicrophone", () => $("mic-btn").click()],
    ["togglecamera", () => $("cam-btn").click()],
    ["hangup", () => $("leave-btn").click()],
  ];
  for (const [name, fn] of actions) {
    try {
      navigator.mediaSession.setActionHandler(name, fn);
    } catch {
      /* action not supported in this browser */
    }
  }
}

// Mirror mic/cam state into the system PiP overlay's buttons.
function syncMediaSessionState() {
  try {
    const mic = state.localStream?.getAudioTracks()[0];
    navigator.mediaSession.setMicrophoneActive?.(!!mic && mic.enabled);
    navigator.mediaSession.setCameraActive?.(!state.camOff && !!state.localStream?.getVideoTracks()[0]);
  } catch {
    /* older browsers */
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
  setUse("fs-icon", active ? "i-shrink" : "i-expand");
  $("fs-btn").title = active ? "Exit full screen (f)" : "Full screen (f)";
  $("fs-btn").setAttribute("aria-label", $("fs-btn").title);
});

// ---------- Keyboard shortcuts ----------

window.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (/^(input|select|textarea)$/i.test(e.target.tagName)) return;
  if ($("call-screen").hidden) return;
  if (e.key === "m") $("mic-btn").click();
  else if (e.key === "c") $("cam-btn").click();
  else if (e.key === "f") $("fs-btn").click();
  else if (e.key === "s" && !$("screen-btn").hidden) $("screen-btn").click();
  else if (e.key === "Escape" && isChatOpen() && window.matchMedia("(max-width: 900px)").matches) {
    toggleChat(false);
  }
});

// ---------- Leave ----------

$("leave-btn").addEventListener("click", () => {
  state.docPip?.close(); // pagehide handler restores the grid first
  if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
  if (state.screenTrack) {
    state.screenTrack.onended = null;
    state.screenTrack.stop();
    state.screenTrack = null;
    state.screenStream = null;
    setScreenButton(false);
  }
  sendLeave();
  destroyAllPeers();
  stopStats();
  stopLocalTracks();
  state.localStream = null;
  $("local-video").srcObject = null;
  $("messages").replaceChildren();
  setUnread(0);
  $("call-screen").hidden = true;
  $("join-screen").hidden = false;
});

// ---------- Live bitrate meter (up + down) ----------

function startStats() {
  stopStats();
  state.statsTimer = setInterval(async () => {
    let up = 0;
    let down = 0;
    let any = false;
    for (const peer of state.peers.values()) {
      const stats = await peer.pc.getStats();
      for (const report of stats.values()) {
        if (report.type === "outbound-rtp" && report.kind === "video") {
          if (peer.lastTime) {
            up += ((report.bytesSent - peer.lastBytes) * 8) / (report.timestamp - peer.lastTime);
            any = true;
          }
          peer.lastBytes = report.bytesSent;
          peer.lastTime = report.timestamp;
        } else if (report.type === "inbound-rtp" && report.kind === "video") {
          if (peer.lastTimeIn) {
            const rate = ((report.bytesReceived - peer.lastBytesIn) * 8) / (report.timestamp - peer.lastTimeIn);
            down += rate;
            any = true;
            // Chrome doesn't fire track "mute" when a sender goes
            // replaceTrack(null) — the frame just freezes. A dead inbound
            // rate is the reliable signal to swap in the letter avatar.
            peer.tile?.classList.toggle("no-video", rate < 1);
          }
          peer.lastBytesIn = report.bytesReceived;
          peer.lastTimeIn = report.timestamp;
        }
      }
    }
    const text = any ? `↑${Math.max(0, Math.round(up))} ↓${Math.max(0, Math.round(down))} kb/s` : "";
    $("stats").textContent = text;
    renderChatSub();
  }, 2000);
}

function stopStats() {
  if (state.statsTimer) clearInterval(state.statsTimer);
  state.statsTimer = null;
  $("stats").textContent = "";
}

function setConnState(text, tone) {
  $("conn-state").textContent = text;
  $("conn-dot").className = `dot ${tone || "wait"}`;
  renderChatSub();
}

// The topbar meter is hidden on phones; mirror state + meter into the chat
// header so the numbers are still reachable there.
function renderChatSub() {
  $("chat-conn").textContent =
    `${$("conn-state").textContent}${$("stats").textContent ? " · " + $("stats").textContent : ""}`;
}
