// Dedicated private-consultation server.
// Serves only the consultation room, its assets and its signaling API, bound to
// loopback. The cloudflared tunnel points at this port, so a remote guest can
// reach nothing else on the machine.

import express from 'express';
import path from 'path';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { createConsultRouter } from './consult.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.CONSULT_PORT || 3002);
const HOST = process.env.CONSULT_HOST || '127.0.0.1';
const PUBLIC_BASE = String(process.env.CONSULT_PUBLIC_URL || process.env.PUBLIC_URL || '').replace(/\/+$/, '');

function isLocalHostName(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1') return true;
  if (/^(127\.|10\.|192\.168\.|169\.254\.)/.test(host)) return true;
  const match = host.match(/^172\.(\d+)\./);
  if (match) {
    const second = Number(match[1]);
    if (second >= 16 && second <= 31) return true;
  }
  return /^(fc|fd)/.test(host) || host.endsWith('.local');
}

// Starting a consultation is reserved for the operator at this machine. Tunnel
// traffic always carries Cloudflare headers and the public hostname, so it can
// never look like a local request.
function isLocalOwner(req) {
  if (req.get('cf-connecting-ip') || req.get('cf-ray') || req.get('cf-visitor') || req.get('x-forwarded-for')) {
    return false;
  }
  return isLocalHostName(String(req.get('host') || '').split(':')[0]);
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));

// Routes first, so /consult hits the operator check instead of a static redirect.
app.use(createConsultRouter({
  isLocalOwner,
  publicBase: (req) => PUBLIC_BASE || `${req.protocol}://${req.get('host')}`,
}));

// Only the room assets — never the rest of public/ (the ops dashboard lives there).
app.use('/consult', express.static(path.join(__dirname, 'public', 'consult')));

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

const server = createServer(app);
server.listen(PORT, HOST, () => {
  console.log(`Consultation server on http://${HOST}:${PORT}/consult`);
  console.log(PUBLIC_BASE
    ? `Guest links use ${PUBLIC_BASE}`
    : 'No CONSULT_PUBLIC_URL set: guest links will only work on this machine.');
});

function shutdown(signal) {
  console.log(`Received ${signal}, shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
