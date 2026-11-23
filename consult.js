// -------------------------------------------------------------
// Private consultation channel
// -------------------------------------------------------------
// A small, dependency-free WebRTC room: the browser-to-browser media never
// touches this server, which only relays SDP offers/answers and ICE candidates
// between the two participants. Rooms live in memory and expire, so a leaked
// link stops working after CONSULT_ROOM_TTL_MS (4 hours by default) or as soon
// as the host ends the consultation.

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ROOM_TTL_MS = Math.max(5 * 60 * 1000, Number(process.env.CONSULT_ROOM_TTL_MS || 4 * 60 * 60 * 1000));
const MAX_ROOMS = Math.max(1, Number(process.env.CONSULT_MAX_ROOMS || 20));
const PEER_ONLINE_MS = 6000;
const MESSAGE_TTL_MS = 2 * 60 * 1000;
const MAX_SDP_LENGTH = 60 * 1024;
const MAX_CANDIDATE_LENGTH = 2000;

const FALLBACK_ICE = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
];

// CONSULT_ICE_SERVERS lets an operator add a TURN server for restrictive
// networks: [{"urls":"turn:host:3478","username":"...","credential":"..."}]
const ICE_SERVERS = (() => {
  const raw = String(process.env.CONSULT_ICE_SERVERS || '').trim();
  if (!raw) return FALLBACK_ICE;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length ? parsed : FALLBACK_ICE;
  } catch {
    console.warn('CONSULT_ICE_SERVERS is not valid JSON; using the default STUN servers');
    return FALLBACK_ICE;
  }
})();

const rooms = new Map();
let createHits = [];

function makeToken() {
  return randomBytes(32).toString('hex');
}

function newPeer() {
  return { lastSeen: 0, queue: [] };
}

function prune() {
  const now = Date.now();
  for (const [id, room] of rooms) {
    if (room.expiresAt <= now) rooms.delete(id);
  }
  createHits = createHits.filter((at) => now - at < 60 * 60 * 1000);
}

setInterval(prune, 60000).unref?.();

function roomForToken(id, token) {
  if (!id || !token) return null;
  const room = rooms.get(id);
  if (!room) return null;
  if (room.expiresAt <= Date.now()) {
    rooms.delete(id);
    return null;
  }
  if (token === room.hostToken) return { room, role: 'host' };
  if (token === room.guestToken) return { room, role: 'guest' };
  return null;
}

function roomForGuestToken(token) {
  if (!token) return null;
  for (const room of rooms.values()) {
    if (room.expiresAt <= Date.now()) continue;
    if (token === room.guestToken) return room;
  }
  return null;
}

function validateMessage(message) {
  if (!message || typeof message !== 'object') return null;
  if (message.type === 'offer' || message.type === 'answer') {
    const sdp = message.sdp;
    if (!sdp || typeof sdp !== 'object') return null;
    if (typeof sdp.sdp !== 'string' || typeof sdp.type !== 'string') return null;
    if (sdp.sdp.length > MAX_SDP_LENGTH) return null;
    return { type: message.type, sdp: { type: sdp.type, sdp: sdp.sdp } };
  }
  if (message.type === 'candidate') {
    const candidate = message.candidate;
    if (!candidate || typeof candidate !== 'object') return null;
    if (typeof candidate.candidate !== 'string' || candidate.candidate.length > MAX_CANDIDATE_LENGTH) return null;
    return {
      type: 'candidate',
      candidate: {
        candidate: candidate.candidate,
        sdpMid: typeof candidate.sdpMid === 'string' ? candidate.sdpMid : null,
        sdpMLineIndex: Number.isInteger(candidate.sdpMLineIndex) ? candidate.sdpMLineIndex : null,
        usernameFragment: typeof candidate.usernameFragment === 'string' ? candidate.usernameFragment : null,
      },
    };
  }
  return null;
}

function pageHeaders(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self)');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
      "connect-src 'self'; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  );
}

function expiredPage(res) {
  pageHeaders(res);
  res
    .status(410)
    .type('html')
    .send('<!doctype html><meta charset="utf-8"><title>Link expired</title>' +
      '<p style="font:16px/1.5 system-ui;padding:32px;max-width:36rem">' +
      'This consultation link has expired or the consultation has ended. Ask the host for a new link.</p>');
}

export function createConsultRouter({ isLocalOwner, publicBase }) {
  const router = express.Router();

  // Host page. express.static may redirect /consult -> /consult/, so accept both.
  router.get(['/consult', '/consult/'], (req, res) => {
    if (!isLocalOwner(req)) {
      pageHeaders(res);
      return res.status(403).type('html').send('<!doctype html><meta charset="utf-8"><title>Not available</title>' +
        '<p style="font:16px/1.5 system-ui;padding:32px;max-width:36rem">' +
        'Consultations are started from the machine hosting them.</p>');
    }
    pageHeaders(res);
    return res.sendFile(path.join(__dirname, 'public', 'consult.html'));
  });

  // Guest entry point: the link itself is the credential.
  router.get('/consult/join/:token', (req, res) => {
    const room = roomForGuestToken(String(req.params.token || ''));
    if (!room) return expiredPage(res);
    pageHeaders(res);
    return res.sendFile(path.join(__dirname, 'public', 'consult.html'));
  });

  // Guest bootstrap: the join token resolves to its room id.
  router.get('/api/consult/lookup', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const room = roomForGuestToken(String(req.query.token || ''));
    if (!room) return res.status(404).json({ error: 'Consultation not found or ended' });
    res.json({ roomId: room.id, expiresAt: room.expiresAt, iceServers: ICE_SERVERS });
  });

  // Start a consultation. Only the operator of this machine may do this.
  router.post('/api/consult/rooms', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!isLocalOwner(req)) {
      return res.status(403).json({ error: 'A consultation can only be started from the machine hosting it.' });
    }
    prune();
    const now = Date.now();
    if (createHits.length >= 30) {
      return res.status(429).json({ error: 'Too many consultations started recently. Try again later.' });
    }
    if (rooms.size >= MAX_ROOMS) {
      return res.status(429).json({ error: 'Too many active consultations. End one first.' });
    }
    const room = {
      id: randomBytes(9).toString('hex'),
      hostToken: makeToken(),
      guestToken: makeToken(),
      createdAt: now,
      expiresAt: now + ROOM_TTL_MS,
      seq: 0,
      peers: { host: newPeer(), guest: newPeer() },
    };
    rooms.set(room.id, room);
    createHits.push(now);
    res.json({
      roomId: room.id,
      token: room.hostToken,
      guestUrl: `${publicBase(req)}/consult/join/${room.guestToken}`,
      expiresAt: room.expiresAt,
      iceServers: ICE_SERVERS,
    });
  });

  // Signaling: poll for messages addressed to this participant.
  router.get('/api/consult/signal/:id', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const auth = roomForToken(String(req.params.id || ''), String(req.query.token || ''));
    if (!auth) return res.status(404).json({ error: 'Consultation not found or ended' });
    const { room, role } = auth;
    const other = role === 'host' ? room.peers.guest : room.peers.host;
    const self = room.peers[role];
    self.lastSeen = Date.now();
    const since = Math.max(0, Number(req.query.since) || 0);
    const cutoff = Date.now() - MESSAGE_TTL_MS;
    self.queue = self.queue.filter((entry) => entry.at > cutoff && entry.seq > since);
    res.json({
      role,
      since: room.seq,
      messages: self.queue.map((entry) => entry.message),
      peerOnline: other.lastSeen > 0 && Date.now() - other.lastSeen < PEER_ONLINE_MS,
      expiresAt: room.expiresAt,
      iceServers: ICE_SERVERS,
    });
  });

  // Signaling: deliver one message to the other participant.
  router.post('/api/consult/signal/:id', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const body = req.body || {};
    const auth = roomForToken(String(req.params.id || ''), String(body.token || ''));
    if (!auth) return res.status(404).json({ error: 'Consultation not found or ended' });
    const message = validateMessage(body.message);
    if (!message) return res.status(400).json({ error: 'Invalid signaling message' });
    const { room, role } = auth;
    const target = role === 'host' ? room.peers.guest : room.peers.host;
    const cutoff = Date.now() - MESSAGE_TTL_MS;
    target.queue = target.queue.filter((entry) => entry.at > cutoff);
    if (target.queue.length > 100) target.queue.shift();
    room.seq += 1;
    target.queue.push({ seq: room.seq, at: Date.now(), message });
    // Mark the sender as present too, so the guest can start as soon as the
    // host has the page open.
    room.peers[role].lastSeen = Date.now();
    res.json({ ok: true, seq: room.seq });
  });

  // End the consultation: the link stops working immediately.
  router.delete('/api/consult/rooms/:id', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const token = req.get('x-consult-token') || '';
    const auth = roomForToken(String(req.params.id || ''), String(token));
    if (!auth) return res.status(404).json({ error: 'Consultation not found' });
    rooms.delete(auth.room.id);
    res.json({ ok: true });
  });

  return router;
}
