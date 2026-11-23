// Private consultation — host opens /consult, guest opens /consult/join/<token>.
// Media is peer-to-peer; this script only uses the server to exchange SDP/ICE.

const JOIN_PREFIX = '/consult/join/';
const path = location.pathname.replace(/\/+$/, '') || '/consult';
const isGuest = path.startsWith(JOIN_PREFIX);

const els = {
  status: document.getElementById('status'),
  remoteVideo: document.getElementById('remoteVideo'),
  remotePlaceholder: document.getElementById('remotePlaceholder'),
  remoteTag: document.getElementById('remoteTag'),
  localVideo: document.getElementById('localVideo'),
  localPlaceholder: document.getElementById('localPlaceholder'),
  sharePanel: document.getElementById('sharePanel'),
  link: document.getElementById('link'),
  copy: document.getElementById('copy'),
  shareHint: document.getElementById('shareHint'),
  notice: document.getElementById('notice'),
  toggleVideo: document.getElementById('toggleVideo'),
  toggleAudio: document.getElementById('toggleAudio'),
  reconnect: document.getElementById('reconnect'),
  end: document.getElementById('end'),
};

const state = {
  role: isGuest ? 'guest' : 'host',
  roomId: null,
  token: isGuest ? decodeURIComponent(path.slice(JOIN_PREFIX.length)) : null,
  since: 0,
  pc: null,
  localStream: new MediaStream(),
  pending: [],
  peers: { remote: false },
  videoOn: false,
  audioOn: true,
  offering: false,
  stopped: false,
  ice: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }],
};

function setStatus(text) {
  els.status.textContent = text;
}

function showNotice(text) {
  if (!text) {
    els.notice.hidden = true;
    els.notice.textContent = '';
    return;
  }
  els.notice.hidden = false;
  els.notice.textContent = text;
}

function updateLocalPreview() {
  els.localPlaceholder.hidden = state.videoOn;
  els.toggleVideo.textContent = state.videoOn ? 'Turn video off' : 'Turn video on';
  els.toggleAudio.textContent = state.audioOn ? 'Mute' : 'Unmute';
}

function showRemotePlaceholder(text) {
  if (!text) {
    els.remotePlaceholder.hidden = true;
    return;
  }
  els.remotePlaceholder.hidden = false;
  els.remotePlaceholder.textContent = text;
}

// ---------------------------------------------------------------
// Local media
// ---------------------------------------------------------------
async function startMedia() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    for (const track of stream.getTracks()) state.localStream.addTrack(track);
    state.videoOn = stream.getVideoTracks().length > 0;
  } catch (err) {
    try {
      const audioOnly = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const track of audioOnly.getTracks()) state.localStream.addTrack(track);
      state.videoOn = false;
      showNotice('Camera unavailable (' + err.name + '). You can join with audio only and turn video on later.');
    } catch (audioErr) {
      state.videoOn = false;
      showNotice('No camera or microphone access: ' + audioErr.message + '. Check the browser permission for this site.');
    }
  }
  els.localVideo.srcObject = state.localStream;
  updateLocalPreview();
  await syncTracks();
}

function transceiverFor(kind) {
  if (!state.pc) return null;
  return state.pc.getTransceivers().find((tx) => tx.receiver && tx.receiver.track && tx.receiver.track.kind === kind) || null;
}

function localTrack(kind) {
  return state.localStream.getTracks().find((track) => track.kind === kind) || null;
}

// Push whatever local tracks exist onto the connection. Using replaceTrack on
// the negotiated transceivers means turning the camera on or off never
// renegotiates the session.
async function syncTracks() {
  if (!state.pc) return;
  for (const kind of ['video', 'audio']) {
    const tx = transceiverFor(kind);
    if (!tx) continue;
    const track = localTrack(kind);
    if (tx.sender.track === track) continue;
    try {
      await tx.sender.replaceTrack(track);
    } catch (err) {
      console.warn('Could not attach the ' + kind + ' track:', err.message);
    }
  }
}

async function setVideo(next) {
  if (next === state.videoOn) return;
  if (next) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } } });
      const track = stream.getVideoTracks()[0];
      if (!track) throw new Error('No camera track');
      state.localStream.addTrack(track);
      els.localVideo.srcObject = state.localStream;
      state.videoOn = true;
      showNotice('');
    } catch (err) {
      showNotice('Could not start the camera: ' + err.message);
      state.videoOn = false;
    }
  } else {
    for (const track of state.localStream.getVideoTracks()) {
      track.stop();
      state.localStream.removeTrack(track);
    }
    state.videoOn = false;
  }
  await syncTracks();
  updateLocalPreview();
}

function setAudio(next) {
  state.audioOn = next;
  for (const track of state.localStream.getAudioTracks()) track.enabled = next;
  updateLocalPreview();
}

// ---------------------------------------------------------------
// Connection
// ---------------------------------------------------------------
function ensurePc() {
  if (state.pc) return state.pc;
  const pc = new RTCPeerConnection({ iceServers: state.ice });
  state.pc = pc;
  state.pending = [];

  // The guest offers, so it declares both media sections up front. The host
  // answers and picks up the same sections from the offer.
  if (state.role === 'guest') {
    pc.addTransceiver('video', { direction: 'sendrecv' });
    pc.addTransceiver('audio', { direction: 'sendrecv' });
  }

  pc.onicecandidate = (event) => {
    if (event.candidate) send({ type: 'candidate', candidate: event.candidate.toJSON() });
  };

  pc.ontrack = (event) => {
    const stream = event.streams && event.streams[0] ? event.streams[0] : new MediaStream([event.track]);
    els.remoteVideo.srcObject = stream;
    const track = event.track;
    track.onmute = () => showRemotePlaceholder(state.role === 'guest' ? 'The host turned their video off' : 'The guest turned their video off');
    track.onunmute = () => showRemotePlaceholder('');
    // Browsers may block audible autoplay until the page has been interacted with.
    els.remoteVideo.play().catch(() => {
      showNotice('Click anywhere on the page to start the audio.');
      document.addEventListener('pointerdown', () => {
        els.remoteVideo.play().then(() => showNotice('')).catch(() => {});
      }, { once: true });
    });
  };

  pc.onconnectionstatechange = () => {
    const stateName = pc.connectionState;
    if (stateName === 'connected') {
      setStatus('Connected');
      showRemotePlaceholder('');
      els.reconnect.hidden = true;
      showNotice('');
    } else if (stateName === 'failed') {
      setStatus('Disconnected');
      showRemotePlaceholder('Connection lost');
      els.reconnect.hidden = false;
      showNotice('The direct connection failed. This is usually a restrictive network; try Reconnect, or use a different network.');
    } else if (stateName === 'disconnected') {
      setStatus('Connection interrupted…');
    } else if (stateName === 'connecting') {
      setStatus('Connecting…');
    }
  };

  return pc;
}

function resetConnection() {
  if (state.pc) {
    try { state.pc.close(); } catch { /* already closed */ }
  }
  state.pc = null;
  state.pending = [];
  state.offering = false;
  els.remoteVideo.srcObject = null;
  els.reconnect.hidden = true;
}

async function flushPending() {
  if (!state.pc || !state.pc.remoteDescription) return;
  const queued = state.pending.splice(0);
  for (const candidate of queued) {
    try { await state.pc.addIceCandidate(candidate); } catch { /* ignore stale candidates */ }
  }
}

async function makeOffer() {
  if (state.role !== 'guest' || state.offering || state.stopped) return;
  if (state.pc && state.pc.signalingState !== 'stable') return;
  state.offering = true;
  try {
    const pc = ensurePc();
    await syncTracks();
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await send({ type: 'offer', sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
  } catch (err) {
    showNotice('Could not start the call: ' + err.message);
  } finally {
    state.offering = false;
  }
}

async function handleSignal(message) {
  if (!message) return;
  if (message.type === 'candidate') {
    if (!state.pc || !state.pc.remoteDescription) {
      state.pending.push(message.candidate);
      return;
    }
    try { await state.pc.addIceCandidate(message.candidate); } catch { /* ignore */ }
    return;
  }
  if (message.type === 'offer') {
    if (state.role !== 'host') return;
    const pc = ensurePc();
    if (pc.signalingState !== 'stable' && pc.signalingState !== 'have-remote-offer') return;
    await pc.setRemoteDescription(message.sdp);
    await syncTracks();
    await flushPending();
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await send({ type: 'answer', sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
    return;
  }
  if (message.type === 'answer') {
    if (state.role !== 'guest' || !state.pc) return;
    if (state.pc.signalingState !== 'have-local-offer') return;
    await state.pc.setRemoteDescription(message.sdp);
    await flushPending();
  }
}

async function send(message) {
  if (!state.roomId || !state.token || state.stopped) return;
  try {
    await fetch('/api/consult/signal/' + encodeURIComponent(state.roomId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: state.token, message }),
    });
  } catch { /* the next poll will retry the session */ }
}

// ---------------------------------------------------------------
// Signaling poll loop
// ---------------------------------------------------------------
function ended(message) {
  state.stopped = true;
  resetConnection();
  for (const track of state.localStream.getTracks()) track.stop();
  setStatus('Ended');
  showRemotePlaceholder(message);
  els.toggleVideo.disabled = true;
  els.toggleAudio.disabled = true;
  els.end.disabled = true;
  els.sharePanel.hidden = true;
  showNotice(message);
}

async function poll() {
  if (state.stopped) return;
  try {
    const url = '/api/consult/signal/' + encodeURIComponent(state.roomId) +
      '?token=' + encodeURIComponent(state.token) + '&since=' + state.since;
    const response = await fetch(url, { cache: 'no-store' });
    if (response.status === 404 || response.status === 410) {
      ended('This consultation has ended.');
      return;
    }
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const data = await response.json();
    if (Array.isArray(data.iceServers) && data.iceServers.length) state.ice = data.iceServers;
    state.since = Number(data.since) || state.since;
    state.peers.remote = !!data.peerOnline;

    if (state.role === 'host') {
      els.remoteTag.textContent = data.peerOnline ? 'Guest' : 'Guest (not joined yet)';
      if (!data.peerOnline && !state.pc) setStatus('Waiting for the guest to open the link…');
    } else if (data.peerOnline && !state.pc) {
      setStatus('Connecting…');
    }

    for (const message of data.messages || []) {
      await handleSignal(message);
    }

    if (state.role === 'guest' && data.peerOnline && !state.pc) await makeOffer();
  } catch {
    setStatus('Reconnecting to the server…');
  } finally {
    if (!state.stopped) setTimeout(poll, 700);
  }
}

// ---------------------------------------------------------------
// Boot
// ---------------------------------------------------------------
async function createRoom() {
  const response = await fetch('/api/consult/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(detail.error || ('HTTP ' + response.status));
  }
  return response.json();
}

els.toggleVideo.addEventListener('click', () => setVideo(!state.videoOn));
els.toggleAudio.addEventListener('click', () => setAudio(!state.audioOn));

els.copy.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(els.link.value);
    els.copy.textContent = 'Copied';
    setTimeout(() => { els.copy.textContent = 'Copy link'; }, 1600);
  } catch {
    els.link.select();
    els.shareHint.textContent = 'Press Ctrl+C to copy the selected link.';
  }
});

els.reconnect.addEventListener('click', async () => {
  resetConnection();
  setStatus('Reconnecting…');
  showRemotePlaceholder('Reconnecting…');
  if (state.role === 'guest') await makeOffer();
});

els.end.addEventListener('click', async () => {
  els.end.disabled = true;
  try {
    await fetch('/api/consult/rooms/' + encodeURIComponent(state.roomId), {
      method: 'DELETE',
      headers: { 'x-consult-token': state.token },
    });
  } catch { /* ending locally still closes our side */ }
  ended(state.role === 'host' ? 'You ended the consultation. The link no longer works.' : 'You left the consultation.');
});

window.addEventListener('beforeunload', () => {
  for (const track of state.localStream.getTracks()) track.stop();
});

async function boot() {
  try {
    await startMedia();

    if (state.role === 'host') {
      const room = await createRoom();
      state.roomId = room.roomId;
      state.token = room.token;
      state.ice = room.iceServers || state.ice;
      els.link.value = room.guestUrl;
      els.sharePanel.hidden = false;
      const expires = new Date(room.expiresAt);
      els.shareHint.textContent = 'This one-off link stops working when you end the consultation or at ' +
        expires.toLocaleTimeString() + '.';
      setStatus('Waiting for the guest to open the link…');
    } else {
      els.sharePanel.hidden = true;
      els.end.textContent = 'Leave';
      setStatus('Waiting for the host…');
    }

    if (isGuest) {
      // The room id is not in the guest URL; the poll route needs it, so look
      // it up from the join token.
      const lookup = await fetch('/api/consult/lookup?token=' + encodeURIComponent(state.token), { cache: 'no-store' });
      if (!lookup.ok) {
        ended('This consultation link has expired or the consultation has ended.');
        return;
      }
      const found = await lookup.json();
      state.roomId = found.roomId;
      if (Array.isArray(found.iceServers) && found.iceServers.length) state.ice = found.iceServers;
    }

    poll();
  } catch (err) {
    setStatus('Could not start');
    showNotice(err.message);
  }
}

updateLocalPreview();
boot();
