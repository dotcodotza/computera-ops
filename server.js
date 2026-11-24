import express from 'express';
import cors from 'cors';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import { spawn } from 'child_process';
import os from 'os';
import { randomUUID, timingSafeEqual } from 'crypto';
import { PDFDocument, rgb } from 'pdf-lib';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const multerModule = require('multer');
const multer = multerModule.default || multerModule;
import { listTasks, getTask, createTask, updateTask, deleteTask, TaskError } from './tasks-db.js';
import {
  listWorkers, getWorker, upsertWorker, touchWorker, deleteWorker, countActiveByWorker,
  recordEvent, listEvents, getRotation, saveRotation, setSetting, listSettings,
} from './tasks-db.js';
import { createFleet, probeCapabilities, startWorkerHeartbeat, todayKey } from './fleet.js';
import { createKiloRuns } from './kilo-runs.js';
import { createSprints, buildStepPrompt, assignFleetRoles, STAGE_TEMPLATES, ROLES } from './sprint.js';
import {
  createSprint, getSprint, listSprints, updateSprint, addSprintStep, listSprintSteps,
  getSprintStep, updateSprintStep, nextPendingStep, addSprintFeed, listSprintFeed,
  resetInterruptedSprints,
} from './sprints-db.js';
import { proxyRequest } from './proxy.js';
import { createWebSearch, WEB_SEARCH_TOOL } from './web-search.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const KILO_URL = process.env.KILO_URL || 'http://127.0.0.1:7777';

// Web search for the chat agent. Without EXA_API_KEY the route answers 503 and
// the rest of the app runs unchanged.
const webSearch = createWebSearch();

// -------------------------------------------------------------
// Fleet configuration
// -------------------------------------------------------------
const ROLE = String(process.env.NODE_ROLE || 'master').toLowerCase() === 'worker' ? 'worker' : 'master';
const MASTER_URL = String(process.env.MASTER_URL || '').replace(/\/+$/, '');
const FLEET_TOKEN = String(process.env.FLEET_TOKEN || '');
const PUBLIC_MODE = ['1', 'true', 'yes', 'on'].includes(String(process.env.PUBLIC_MODE || '').toLowerCase());
let PUBLIC_URL = String(process.env.PUBLIC_URL || '').replace(/\/+$/, '');

// POV (pdfcraft) is proxied under our own origin so its same-origin postMessage
// bridge works: the workspace PDF goes in, saves come back into the workspace.
// POV_MODE=embed frames the public site instead (no bridge, no save-back).
const POV_MODE = String(process.env.POV_MODE || 'proxy').toLowerCase() === 'embed' ? 'embed' : 'proxy';
const POV_UPSTREAM = 'https://skywalkingzulu1.github.io/pdfcraft/';
const POV_CACHE_DIR = path.join(__dirname, 'data', 'pdfcraft-cache');
const POV_ASSET_RE = /^(|pov-web-[0-9a-f]+\.js|pov-web-[0-9a-f]+_bg\.wasm)$/;
const SELF_ID = ROLE === 'worker'
  ? String(process.env.WORKER_ID || `${os.hostname().toLowerCase().replace(/[^a-z0-9-]/g, '-')}-${PORT}`)
  : 'master';
const SELF_NAME = String(process.env.WORKER_NAME || (ROLE === 'worker' ? os.hostname() : 'masternode'));
let SELF_URL = PUBLIC_URL || `http://localhost:${PORT}`;
let activeLinkToken = String(process.env.HOST_LINK_TOKEN || '') || null;
const MEMORY_DIR = path.join(__dirname, 'memory');
const UPLOADS_DIR = path.join(__dirname, 'uploads');

// Safe filesystem roots
const rawRoots = process.env.ALLOWED_FS_ROOTS 
  ? process.env.ALLOWED_FS_ROOTS.split(';') 
  : [__dirname, process.env.USERPROFILE || os.homedir(), path.resolve(__dirname, '..')];

const ALLOWED_FS_ROOTS = rawRoots.filter(Boolean).map(r => path.resolve(r).toLowerCase());

// Workspace sharing: what a visitor holding today's link may touch.
// off = nothing, read = browse/download the workspace folder, write = also create/edit/delete.
const WORKSPACE_SHARE = (() => {
  const value = String(process.env.WORKSPACE_SHARE || 'read').toLowerCase();
  if (['off', '0', 'no', 'false', 'none'].includes(value)) return 'off';
  if (['write', 'rw', 'read-write', 'edit'].includes(value)) return 'write';
  return 'read';
})();
// Shared access never leaves this folder, whatever ALLOWED_FS_ROOTS says.
const SHARED_FS_ROOT = path.resolve(process.env.SHARED_FS_ROOT || __dirname).toLowerCase();
// Private paths inside the workspace (secrets, database, local tooling) stay off the shared scope.
const SHARED_FS_DENY = new Set(['data', 'node_modules', 'memory', '.git', '.freebuff', '.tools', '.env', '.env.local']);

app.use(cors());

// Lightweight counters served by /api/metrics (Stage 3: observability).
const METRICS = { startedAt: Date.now(), requests: 0, errors: 0, proxy: 0, dispatch: 0 };
app.use((req, res, next) => {
  METRICS.requests++;
  res.on('finish', () => { if (res.statusCode >= 500) METRICS.errors++; });
  next();
});

// -------------------------------------------------------------
// Fleet security helpers
// -------------------------------------------------------------
function sameSecret(candidate, expected) {
  if (!candidate || !expected) return false;
  const a = Buffer.from(String(candidate));
  const b = Buffer.from(String(expected));
  return a.length === b.length && timingSafeEqual(a, b);
}

function isPrivateClient(req) {
  const ip = String(req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  if (!ip) return false;
  if (ip === '::1' || ip === '127.0.0.1' || ip === 'localhost') return true;
  if (ip.startsWith('127.') || ip.startsWith('10.') || ip.startsWith('192.168.')) return true;
  const m = ip.match(/^172\.(\d+)\./);
  if (m) { const second = Number(m[1]); if (second >= 16 && second <= 31) return true; }
  return /^(fc|fd)/i.test(ip);
}

function hasFleetToken(req) {
  return !!FLEET_TOKEN && sameSecret(req.get('x-fleet-token'), FLEET_TOKEN);
}

// HTTP Basic auth check (used when PUBLIC_MODE is enabled)
const BASIC_AUTH_USER = process.env.BASIC_AUTH_USER;
const BASIC_AUTH_PASS = process.env.BASIC_AUTH_PASS;
function basicAuthOk(req) {
  if (!BASIC_AUTH_USER || !BASIC_AUTH_PASS) return false;
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme !== 'Basic' || !encoded) return false;
  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  const idx = decoded.indexOf(':');
  return idx > -1 && decoded.slice(0, idx) === BASIC_AUTH_USER && decoded.slice(idx + 1) === BASIC_AUTH_PASS;
}

// A request arriving through the public tunnel still has the tunnel hostname in
// its Host header, even though cloudflared connects from loopback.
// Sitting at this machine means the browser talked to a loopback host. The client
// IP alone is not enough: cloudflared also connects from 127.0.0.1, so a tunnel
// whose URL no longer matches PUBLIC_URL would otherwise look like the operator.
function isLoopbackHost(req) {
  const host = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
}

// Rotating public link: only today's token (or its cookie) opens the app when PUBLIC_MODE is on.
if (PUBLIC_MODE) {
  app.use((req, res, next) => {
    if (!activeLinkToken) return next();
    // Machine-to-machine entry points authenticate themselves (FLEET_TOKEN), so
    // they stay reachable through a public tunnel without today's link.
    if (req.path === '/api/fleet/join' || req.path === '/api/fleet/heartbeat' || req.path === '/api/fleet/run'
      || req.path.startsWith('/api/fleet/run/')
      || req.path.startsWith('/proxy/kilo') || req.path.startsWith('/proxy/ollama')) {
      return next();
    }
    // Health is what an operator or monitor polls. A request that arrived through
    // the public tunnel (its Host is PUBLIC_URL) needs the fleet token; a local
    // one needs no visitor link. Cloudflared connects from loopback, so the Host
    // header is what tells the two apart.
    if (req.path === '/api/health' && (hasFleetToken(req) || isLoopbackHost(req))) {
      return next();
    }
    // Sitting at this machine is itself authorization: cloudflared connects from
    // loopback too, so a real tunnel request is recognised by its Host header.
    if (isLoopbackHost(req)) {
      req.workspaceScope = 'full';
      return next();
    }
    // The fleet token is the machine credential. A worker that presents it proxies
    // the roster, calendar and sprint routes to this master; without this branch the
    // gate answered those with "Link expired" and the worker UI looked broken.
    if (hasFleetToken(req)) {
      req.workspaceScope = 'full';
      return next();
    }
    // The operator's Basic auth is the stable credential; it opens the app without a link.
    if (basicAuthOk(req)) {
      req.workspaceScope = 'full';
      return next();
    }
    if (sameSecret(req.query.t, activeLinkToken)) {
      res.setHeader('Set-Cookie', `cops_link=${encodeURIComponent(activeLinkToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`);
      req.fleetLinkOk = true;
      // Trade the token for the cookie and drop it from the address bar, so the
      // page the visitor ends up on is not a credential they might share again.
      if (req.method === 'GET' && !req.path.startsWith('/api/')) {
        const clean = new URL(req.originalUrl, 'http://app.local');
        clean.searchParams.delete('t');
        return res.redirect(302, clean.pathname + clean.search);
      }
      return next();
    }
    const cookies = String(req.headers.cookie || '').split(';').map(p => p.trim());
    const linkCookie = cookies.find(p => p.startsWith('cops_link='));
    if (linkCookie && sameSecret(decodeURIComponent(linkCookie.slice('cops_link='.length)), activeLinkToken)) {
      req.fleetLinkOk = true;
      return next();
    }
    res.status(401).type('html').send('<!doctype html><title>Link expired</title><p style="font-family:system-ui;padding:24px">This daily link is no longer valid. Ask the master node for today&rsquo;s link.</p>');
  });

  // Workspace sharing for people holding today's link: files, documents and the
  // document helpers, always scoped to SHARED_FS_ROOT. Tool execution and anything
  // outside the workspace still require the fleet token.
  app.use(['/api/filesystem', '/api/document', '/api/memory', '/api/tools'], (req, res, next) => {
    if (hasFleetToken(req) || basicAuthOk(req)) {
      req.workspaceScope = 'full';
      return next();
    }
    // req.path is relative to the mount, so compare against the mount base instead.
    if (`${req.baseUrl}${req.path}`.startsWith('/api/tools')) {
      return res.status(403).json({ error: 'Tool execution requires the fleet token' });
    }
    if (WORKSPACE_SHARE === 'off') {
      return res.status(403).json({ error: 'Workspace sharing is disabled on this node' });
    }
    req.workspaceScope = WORKSPACE_SHARE === 'write' ? 'shared-write' : 'shared-read';
    res.setHeader('Cache-Control', 'no-store');
    return next();
  });
}

// Engine proxies. Mounted before express.json() so request bodies stream through
// untouched (Kilo and Ollama both answer with event streams that must not be
// buffered), and behind the fleet token so a public tunnel never becomes an open
// relay to this machine's engines. (Stage 2: connectivity.)
app.use('/proxy/kilo', fleetRateLimit, requireFleetTokenStrict, (req, res) => {
  METRICS.proxy++;
  proxyRequest(req, res, {
    targetUrl: KILO_URL,
    path: req.originalUrl.slice('/proxy/kilo'.length) || '/',
    headers: { 'x-kilo-directory': KILO_DIRECTORY },
  }).catch((err) => { if (!res.headersSent) res.status(502).json({ error: err.message }); });
});
app.use('/proxy/ollama', fleetRateLimit, requireFleetTokenStrict, (req, res) => {
  METRICS.proxy++;
  proxyRequest(req, res, {
    targetUrl: OLLAMA_URL,
    path: req.originalUrl.slice('/proxy/ollama'.length) || '/',
  }).catch((err) => { if (!res.headersSent) res.status(502).json({ error: err.message }); });
});

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

// Ensure directories exist
fs.ensureDirSync(MEMORY_DIR);
fs.ensureDirSync(UPLOADS_DIR);

// Worker nodes read the shared calendar and roster from the master, so the master
// stays the only writer to the shared SQLite database.
const MASTER_PROXY_PATHS = ['/api/tasks', '/api/calendar', '/api/fleet/workers', '/api/fleet/today', '/api/fleet/events', '/api/fleet/rotate', '/api/fleet/dispatch', '/api/sprints', '/api/automations'];
if (ROLE === 'worker' && MASTER_URL) {
  app.use((req, res, next) => {
    if (!MASTER_PROXY_PATHS.some(p => req.path === p || req.path.startsWith(p + '/'))) return next();
    const init = {
      method: req.method,
      headers: { 'Content-Type': 'application/json', ...(FLEET_TOKEN ? { 'X-Fleet-Token': FLEET_TOKEN } : {}) },
    };
    if (!['GET', 'HEAD'].includes(req.method)) init.body = JSON.stringify(req.body ?? {});
    fetch(`${MASTER_URL}${req.originalUrl}`, init)
      .then(async (upstream) => {
        const text = await upstream.text();
        res.status(upstream.status).type(upstream.headers.get('content-type') || 'application/json').send(text);
      })
      .catch((err) => res.status(502).json({ error: `Master unreachable at ${MASTER_URL}: ${err.message}` }));
  });
}

// Multer for file uploads - keeps the original extension so documents stay readable
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
      const rawExt = path.extname(file.originalname || '').toLowerCase();
      const safeExt = /^\.[a-z0-9]{1,10}$/.test(rawExt) ? rawExt : '';
      cb(null, `${randomUUID()}${safeExt}`);
    },
  }),
});

// Normalize path & check if allowed
function isWithin(root, resolved) {
  return resolved === root || resolved.startsWith(root + path.sep);
}

// Paths shared with link holders: inside SHARED_FS_ROOT, minus secrets/tooling/database.
function isSharedPathAllowed(resolved) {
  if (!isWithin(SHARED_FS_ROOT, resolved)) return false;
  const rel = resolved.slice(SHARED_FS_ROOT.length).replace(/^[\\/]+/, '');
  const segments = rel ? rel.split(/[\\/]+/) : [];
  return !segments.some(seg => seg.startsWith('.') || SHARED_FS_DENY.has(seg));
}

// req.workspaceScope is set by the public-link gate: 'full' (fleet token / Basic auth),
// 'shared-read' or 'shared-write' (holder of today's link).
function isPathAllowed(filepath, req) {
  try {
    const resolved = path.resolve(filepath).toLowerCase();
    const scope = req?.workspaceScope || 'full';
    if (scope === 'shared-read' || scope === 'shared-write') return isSharedPathAllowed(resolved);
    if (scope === 'none') return false;
    return ALLOWED_FS_ROOTS.some(root => isWithin(root, resolved));
  } catch {
    return false;
  }
}

function canWriteWorkspace(req) {
  return (req?.workspaceScope || 'full') !== 'shared-read';
}

function formatFileSize(bytes) {
  if (!bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// Extract plain text from supported document types
async function extractDocumentText(filepath) {
  const ext = path.extname(filepath).toLowerCase();
  if (ext === '.pdf') {
    const dataBuffer = await fs.readFile(filepath);
    // pdf-parse v1 exports a function, v2 exports a PDFParse class
    if (typeof pdfParse === 'function') {
      const data = await pdfParse(dataBuffer);
      return data.text;
    }
    const parser = new pdfParse.PDFParse({ data: dataBuffer });
    try {
      const result = await parser.getText();
      return result.text;
    } finally {
      if (typeof parser.destroy === 'function') await parser.destroy().catch(() => {});
    }
  } else if (ext === '.docx') {
    const result = await mammoth.extractRawText({ path: filepath });
    return result.value;
  } else if (ext === '.rtf') {
    const content = await fs.readFile(filepath, 'utf-8');
    return content.replace(/\\[a-z0-9*]+\s?/gi, ' ').replace(/[{}]/g, '').trim();
  } else if (['.txt', '.md', '.js', '.json', '.html', '.css', '.py', '.ts', '.tsx', '.jsx', '.c', '.cpp', '.h', '.hpp', '.java', '.go', '.rs', '.rb', '.php', '.xml', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.log', '.csv', '.tsv', '.sh', '.bat', '.ps1', '.sql', '.graphql', '.proto', '.dockerfile', '.env', '.gitignore', '.license', '.readme'].includes(ext)) {
    return await fs.readFile(filepath, 'utf-8');
  } else if (['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg', '.ico'].includes(ext)) {
    const stat = await fs.stat(filepath);
    return `[Image file: ${path.basename(filepath)} (${formatFileSize(stat.size)}) - visual content, text extraction not available without OCR]`;
  } else if (['.zip', '.tar', '.gz', '.rar', '.7z'].includes(ext)) {
    const stat = await fs.stat(filepath);
    return `[Archive file: ${path.basename(filepath)} (${formatFileSize(stat.size)}) - archive contents not extracted]`;
  } else if (['.mp3', '.wav', '.mp4', '.avi', '.mov', '.mkv'].includes(ext)) {
    const stat = await fs.stat(filepath);
    return `[Media file: ${path.basename(filepath)} (${formatFileSize(stat.size)}) - media content, text extraction not available]`;
  }
  throw new Error(`Unsupported document extension: ${ext}`);
}

// -------------------------------------------------------------
// Tool definitions for Ollama
// -------------------------------------------------------------
const FS_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description: 'List all files and subdirectories in a directory path.',
      parameters: {
        type: 'object',
        properties: {
          dirpath: { type: 'string', description: 'Directory path to list. Leave empty or use "." for the current project root.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the text content of a file from the filesystem.',
      parameters: {
        type: 'object',
        properties: {
          filepath: { type: 'string', description: 'Path of the file to read (relative or absolute).' }
        },
        required: ['filepath']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write or overwrite text content to a file on the filesystem.',
      parameters: {
        type: 'object',
        properties: {
          filepath: { type: 'string', description: 'Path of the file to write to.' },
          content: { type: 'string', description: 'The text content to write into the file.' }
        },
        required: ['filepath', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_document_text',
      description: 'Extract plain text content from a document (PDF, TXT, MD, JSON, code files) for LLM context.',
      parameters: {
        type: 'object',
        properties: {
          filepath: { type: 'string', description: 'Path of the document to extract text from.' }
        },
        required: ['filepath']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'edit_pdf',
      description: 'Append text to a PDF page using pdf-lib.',
      parameters: {
        type: 'object',
        properties: {
          filepath: { type: 'string', description: 'Path of the PDF file to edit.' },
          text: { type: 'string', description: 'Text to append to the PDF page.' },
          pageNumber: { type: 'integer', description: '1-based page number to edit (default 1).', default: 1 }
        },
        required: ['filepath', 'text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'upload_file',
      description: 'Register an uploaded file path in the uploads directory.',
      parameters: {
        type: 'object',
        properties: {
          filename: { type: 'string', description: 'Name of the uploaded file.' }
        },
        required: ['filename']
      }
    }
  },
  WEB_SEARCH_TOOL
];

const FS_TOOL_NAMES = new Set(FS_TOOLS.filter(t => t.function).map(t => t.function.name));

// Smaller models often print the call as text instead of emitting tool_calls:
//   {"name": "read_file", "arguments": {"filepath": "a.txt"}}
// Without this the request looks like it read a file when nothing touched disk.
function parseTextToolCall(text) {
  if (!text || typeof text !== 'string') return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  for (const raw of [fenced ? fenced[1] : null, text]) {
    if (!raw) continue;
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end <= start) continue;
    let obj = null;
    try { obj = JSON.parse(raw.slice(start, end + 1)); } catch { continue; }
    if (!obj || typeof obj !== 'object') continue;
    const fn = obj.function && typeof obj.function === 'object' ? obj.function : null;
    const name = obj.name || obj.tool || fn?.name;
    let args = obj.arguments ?? obj.args ?? obj.parameters ?? obj.input ?? fn?.arguments ?? {};
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
    if (name && FS_TOOL_NAMES.has(name) && args && typeof args === 'object') return { name, args };
  }
  return null;
}

// Helper to execute the agent's tools (files, documents, PDFs, web search).
async function executeTool(name, args, req) {
  args = args && typeof args === 'object' ? args : {};
  // A model that emits a call without its required path must get an answer back,
  // not a crash that fails the whole chat turn. The guidance in the error is what
  // small models read before their next attempt.
  const needsPath = ['read_file', 'write_file', 'read_document_text', 'edit_pdf'];
  if (needsPath.includes(name) && (typeof args.filepath !== 'string' || !args.filepath.trim())) {
    return { error: `${name} needs a filepath argument` };
  }
  if (name === 'list_directory') {
    const target = args.dirpath && args.dirpath !== '.' ? path.resolve(args.dirpath) : __dirname;
    if (!isPathAllowed(target, req)) return { error: `Path is outside the workspace: ${target}. Use a workspace-relative path such as "package.json".` };
    const exists = await fs.pathExists(target);
    if (!exists) return { error: `Directory not found: ${target}` };
    const entries = await fs.readdir(target, { withFileTypes: true });
    const items = entries.map(e => ({ name: e.name, isDirectory: e.isDirectory() }));
    return { dirpath: target, items };
  }

  if (name === 'read_file') {
    const target = path.resolve(__dirname, args.filepath);
    if (!isPathAllowed(target, req)) return { error: `Path is outside the workspace: ${target}. Use a workspace-relative path such as "package.json".` };
    const exists = await fs.pathExists(target);
    if (!exists) return { error: `File not found: ${target}` };
    const stat = await fs.stat(target);
    if (stat.size > 2 * 1024 * 1024) return { error: 'File too large to read into chat (max 2MB)' };
    const content = await fs.readFile(target, 'utf-8');
    return { filepath: target, content };
  }

  if (name === 'write_file') {
    const target = path.resolve(__dirname, args.filepath);
    if (!isPathAllowed(target, req)) return { error: `Path is outside the workspace: ${target}. Use a workspace-relative path such as "package.json".` };
    if (!canWriteWorkspace(req)) return { error: 'This link has read-only workspace access' };
    await fs.outputFile(target, args.content || '');
    return { success: true, filepath: target, bytesWritten: (args.content || '').length };
  }

  if (name === 'read_document_text') {
    const target = path.resolve(__dirname, args.filepath);
    if (!isPathAllowed(target, req)) return { error: `Path is outside the workspace: ${target}. Use a workspace-relative path such as "package.json".` };
    const exists = await fs.pathExists(target);
    if (!exists) return { error: `File not found: ${target}` };
    try {
      const text = await extractDocumentText(target);
      return { filepath: target, text, size: text.length };
    } catch (err) {
      return { error: err.message };
    }
  }

  if (name === 'edit_pdf') {
    const target = path.resolve(__dirname, args.filepath);
    if (!isPathAllowed(target, req)) return { error: `Path is outside the workspace: ${target}. Use a workspace-relative path such as "package.json".` };
    const exists = await fs.pathExists(target);
    if (!exists) return { error: `File not found: ${target}` };
    try {
      const existingPdfBytes = await fs.readFile(target);
      const pdfDoc = await PDFDocument.load(existingPdfBytes);
      const pages = pdfDoc.getPages();
      const pageIndex = Math.max(0, Math.min((args.pageNumber || 1) - 1, pages.length - 1));
      const targetPage = pages[pageIndex];
      targetPage.drawText(args.text, {
        x: 50,
        y: targetPage.getHeight() - 100,
        size: 12,
        color: rgb(0, 0, 0),
      });
      const modifiedPdfBytes = await pdfDoc.save();
      await fs.writeFile(target, modifiedPdfBytes);
      return { success: true, filepath: target, message: 'PDF modified successfully', pageEdited: pageIndex + 1 };
    } catch (err) {
      return { error: err.message };
    }
  }

  if (name === 'upload_file') {
    const target = path.join(UPLOADS_DIR, args.filename);
    return { success: true, filepath: target, message: 'File ready for use' };
  }

  if (name === 'web_search') {
    try {
      return await webSearch.search(args.query, { numResults: args.numResults });
    } catch (err) {
      return { error: err.message };
    }
  }

  return { error: `Unknown tool: ${name}` };
}

// -------------------------------------------------------------
// API Endpoints
// -------------------------------------------------------------

// Health check: one call tells an operator what this node can do right now.
app.get('/api/health', async (req, res) => {
  let ollamaStatus = 'offline';
  try {
    const check = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (check.ok) ollamaStatus = 'online';
  } catch { ollamaStatus = 'unreachable'; }

  let kiloStatus = 'offline';
  try {
    const check = await fetch(`${KILO_URL}/global/health`, { signal: AbortSignal.timeout(2000) });
    if (check.ok) kiloStatus = 'online';
  } catch { kiloStatus = 'unreachable'; }

  const uptimeSec = Math.round((Date.now() - METRICS.startedAt) / 1000);
  res.json({
    status: 'ok',
    ollama: OLLAMA_URL, ollamaStatus,
    kilo: KILO_URL, kiloStatus,
    kiloRuns: kiloRuns.activeRuns().map(r => ({
      id: r.id, sessionId: r.sessionId, status: r.status, elapsedMs: r.elapsedMs, waiting: !!r.waiting,
    })),
    workspace: __dirname, platform: process.platform, povMode: POV_MODE,
    webSearch: webSearch.configured ? 'configured' : 'missing EXA_API_KEY',
    role: ROLE, node: SELF_ID, tunnel: PUBLIC_URL || null,
    uptimeSec,
    requests: METRICS.requests,
  });
});

// Counters plus per-worker circuit state, for the dashboard and monitoring.
app.get('/api/metrics', fleetRateLimit, requireFleetRead, (req, res) => {
  res.json({
    uptimeSec: Math.round((Date.now() - METRICS.startedAt) / 1000),
    requests: METRICS.requests,
    errors5xx: METRICS.errors,
    proxyRequests: METRICS.proxy,
    dispatches: METRICS.dispatch,
    kiloRuns: kiloRuns.activeRuns().map(r => ({ id: r.id, sessionId: r.sessionId, elapsedMs: r.elapsedMs })),
    workers: typeof fleet.health === 'function' ? fleet.health() : {},
    memoryMb: Math.round(process.memoryUsage().rss / 1048576),
  });
});

// List Ollama models
app.get('/api/models', async (req, res) => {
  try {
    const resp = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!resp.ok) return res.status(resp.status).json({ error: 'Failed to retrieve models from Ollama' });
    const data = await resp.json();
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: `Cannot reach Ollama at ${OLLAMA_URL}: ${err.message}`, models: [] });
  }
});

// Web search through Exa, used by the chat agent's web_search tool and by the UI.
// This spends the node's Exa quota, so on a public node it needs the fleet token
// or Basic auth, the same rule as tool execution.
app.post('/api/web/search', fleetRateLimit, async (req, res) => {
  if (PUBLIC_MODE && !hasFleetToken(req) && !basicAuthOk(req)) {
    return res.status(403).json({ error: 'Web search requires the fleet token' });
  }
  try {
    const { query, numResults, includeDomains, excludeDomains, category } = req.body || {};
    const result = await webSearch.search(query, { numResults, includeDomains, excludeDomains, category });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

// Workspace info
app.get('/api/filesystem/workspace', (req, res) => {
  const scope = req.workspaceScope || 'full';
  const shared = scope === 'shared-read' || scope === 'shared-write';
  if (shared) {
    return res.json({ cwd: SHARED_FS_ROOT, root: SHARED_FS_ROOT, shared: true, writable: canWriteWorkspace(req), scope });
  }
  res.json({
    cwd: __dirname,
    home: process.env.USERPROFILE || os.homedir(),
    allowedRoots: ALLOWED_FS_ROOTS,
    shared: false,
    writable: true,
    scope,
  });
});

// File metadata (used by Studio to notice on-disk edits, including the AI's)
app.get('/api/filesystem/stat', async (req, res) => {
  try {
    const filepath = req.query.path;
    if (!filepath) return res.status(400).json({ error: 'path query required' });
    const target = path.resolve(filepath);
    if (!isPathAllowed(target, req)) return res.status(403).json({ error: 'Access denied' });
    if (!(await fs.pathExists(target))) return res.status(404).json({ error: 'File not found' });
    const st = await fs.stat(target);
    res.json({ path: target, size: st.size, mtimeMs: st.mtimeMs, isDirectory: st.isDirectory() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
// Read file
app.post('/api/filesystem/read', async (req, res) => {
  try {
    const { filepath } = req.body;
    if (!filepath) return res.status(400).json({ error: 'filepath required' });
    const target = path.resolve(__dirname, filepath);
    if (!isPathAllowed(target, req)) return res.status(403).json({ error: 'Access denied' });
    const exists = await fs.pathExists(target);
    if (!exists) return res.status(404).json({ error: 'File not found' });
    const stat = await fs.stat(target);
    if (stat.isDirectory()) return res.status(400).json({ error: 'Specified path is a directory, not a file' });
    const content = await fs.readFile(target, 'utf-8');
    res.json({ filepath: target, name: path.basename(target), content, size: stat.size, mtime: stat.mtime });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Write file
app.post('/api/filesystem/write', async (req, res) => {
  try {
    const { filepath, content } = req.body;
    if (!filepath) return res.status(400).json({ error: 'filepath required' });
    const target = path.resolve(__dirname, filepath);
    if (!isPathAllowed(target, req)) return res.status(403).json({ error: 'Access denied' });
    if (!canWriteWorkspace(req)) return res.status(403).json({ error: 'This link has read-only workspace access' });
    await fs.outputFile(target, content !== undefined ? content : '');
    const stat = await fs.stat(target);
    res.json({ success: true, filepath: target, size: stat.size, mtime: stat.mtime });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Delete file or directory
app.post('/api/filesystem/delete', async (req, res) => {
  try {
    const { filepath } = req.body;
    if (!filepath) return res.status(400).json({ error: 'filepath required' });
    const target = path.resolve(__dirname, filepath);
    if (!isPathAllowed(target, req)) return res.status(403).json({ error: 'Access denied' });
    if (!canWriteWorkspace(req)) return res.status(403).json({ error: 'This link has read-only workspace access' });
    if (target === __dirname) return res.status(400).json({ error: 'Cannot delete project root' });
    await fs.remove(target);
    res.json({ success: true, filepath: target });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Create directory
app.post('/api/filesystem/mkdir', async (req, res) => {
  try {
    const { dirpath } = req.body;
    if (!dirpath) return res.status(400).json({ error: 'dirpath required' });
    const target = path.resolve(__dirname, dirpath);
    if (!isPathAllowed(target, req)) return res.status(403).json({ error: 'Access denied' });
    if (!canWriteWorkspace(req)) return res.status(403).json({ error: 'This link has read-only workspace access' });
    await fs.ensureDir(target);
    res.json({ success: true, dirpath: target });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// List files in directory
app.post('/api/filesystem/list', async (req, res) => {
  try {
    const { dirpath } = req.body;
    const target = dirpath ? path.resolve(__dirname, dirpath) : __dirname;
    if (!isPathAllowed(target, req)) return res.status(403).json({ error: 'Access denied' });
    const exists = await fs.pathExists(target);
    if (!exists) return res.status(404).json({ error: 'Directory not found' });
    const entries = await fs.readdir(target, { withFileTypes: true });
    const files = await Promise.all(
      entries.map(async (e) => {
        const itemPath = path.join(target, e.name);
        let size = 0, mtime = null;
        try { const s = await fs.stat(itemPath); size = s.size; mtime = s.mtime; } catch {}
        return { name: e.name, path: itemPath, isDirectory: e.isDirectory(), size, mtime, extension: path.extname(e.name).toLowerCase() };
      })
    );
    files.sort((a, b) => { if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1; return a.name.localeCompare(b.name); });
    res.json({ dirpath: target, parent: path.dirname(target) !== target ? path.dirname(target) : null, files });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Document text extraction
app.post('/api/document/read-text', async (req, res) => {
  try {
    const { filepath } = req.body;
    if (!filepath) return res.status(400).json({ error: 'filepath required' });
    const target = path.resolve(__dirname, filepath);
    if (!isPathAllowed(target, req)) return res.status(403).json({ error: 'Access denied' });
    const exists = await fs.pathExists(target);
    if (!exists) return res.status(404).json({ error: 'File not found' });
    const text = await extractDocumentText(target);
    res.json({ success: true, filepath: target, name: path.basename(target), text, size: text.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Serve raw document for viewing (PDF.js, iframe, etc.)
app.get('/api/document/view', async (req, res) => {
  try {
    const filepath = req.query.path;
    if (!filepath) return res.status(400).json({ error: 'path query required' });
    const target = path.resolve(filepath);
    if (!isPathAllowed(target, req)) return res.status(403).json({ error: 'Access denied' });
    if (!(await fs.pathExists(target))) return res.status(404).send('File not found');
    const ext = path.extname(target).toLowerCase();
    const mimeTypes = {
      '.pdf': 'application/pdf',
      '.txt': 'text/plain',
      '.md': 'text/markdown',
      '.html': 'text/html',
      '.css': 'text/css',
      '.js': 'application/javascript',
      '.json': 'application/json',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.svg': 'image/svg+xml',
    };
    res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream');
    res.setHeader('Content-Disposition', 'inline');
    res.sendFile(target);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get PDF raw bytes for PDF.js rendering
app.get('/api/document/pdf-bytes', async (req, res) => {
  try {
    const filepath = req.query.path;
    if (!filepath) return res.status(400).json({ error: 'path query required' });
    const target = path.resolve(filepath);
    if (!isPathAllowed(target, req)) return res.status(403).json({ error: 'Access denied' });
    if (!(await fs.pathExists(target))) return res.status(404).send('File not found');
    const ext = path.extname(target).toLowerCase();
    if (ext !== '.pdf') return res.status(400).json({ error: 'Not a PDF file' });
    const bytes = await fs.readFile(target);
    res.setHeader('Content-Type', 'application/pdf');
    res.send(bytes);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Save PDF bytes back (the POV bridge hands us the edited file)
app.post('/api/document/save-bytes', express.raw({ type: 'application/octet-stream', limit: '100mb' }), async (req, res) => {
  try {
    const filepath = req.query.path;
    if (!filepath) return res.status(400).json({ error: 'path query required' });
    if (!canWriteWorkspace(req)) return res.status(403).json({ error: 'This link has read-only workspace access' });
    const target = path.resolve(filepath);
    if (!isPathAllowed(target, req)) return res.status(403).json({ error: 'Access denied' });
    if (path.extname(target).toLowerCase() !== '.pdf') return res.status(400).json({ error: 'Only .pdf files can be saved here' });
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Empty body' });
    if (req.body.subarray(0, 5).toString('latin1') !== '%PDF-') return res.status(400).json({ error: 'Body is not a PDF' });
    if (!(await fs.pathExists(target))) return res.status(404).json({ error: 'File not found' });
    const backupDir = path.join(__dirname, 'data', 'backups', 'pdf');
    await fs.ensureDir(backupDir);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await fs.copy(target, path.join(backupDir, `${path.basename(target, '.pdf')}-${stamp}.pdf`));
    const tmp = `${target}.${randomUUID()}.tmp`;
    await fs.writeFile(tmp, req.body);
    await fs.move(tmp, target, { overwrite: true });
    const st = await fs.stat(target);
    res.json({ success: true, path: target, size: st.size, mtimeMs: st.mtimeMs });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
// Upload file
app.post('/api/document/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const target = path.resolve(req.file.path);
    if (!canWriteWorkspace(req)) {
      await fs.remove(target);
      return res.status(403).json({ error: 'This link has read-only workspace access' });
    }
    if (!isPathAllowed(target, req)) {
      await fs.remove(target);
      return res.status(403).json({ error: 'Access denied' });
    }
    res.json({ success: true, filepath: target, filename: req.file.filename, originalname: req.file.originalname, size: req.file.size });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Edit PDF
app.post('/api/document/edit-pdf', async (req, res) => {
  try {
    const { filepath, text, pageNumber = 1 } = req.body;
    if (!filepath) return res.status(400).json({ error: 'filepath required' });
    if (!text) return res.status(400).json({ error: 'text required' });
    const target = path.resolve(__dirname, filepath);
    if (!isPathAllowed(target, req)) return res.status(403).json({ error: 'Access denied' });
    if (!canWriteWorkspace(req)) return res.status(403).json({ error: 'This link has read-only workspace access' });
    const exists = await fs.pathExists(target);
    if (!exists) return res.status(404).json({ error: 'File not found' });
    const existingPdfBytes = await fs.readFile(target);
    const pdfDoc = await PDFDocument.load(existingPdfBytes);
    const pages = pdfDoc.getPages();
    const pageIndex = Math.max(0, Math.min(pageNumber - 1, pages.length - 1));
    const targetPage = pages[pageIndex];
    targetPage.drawText(text, { x: 50, y: targetPage.getHeight() - 100, size: 12, color: rgb(0, 0, 0) });
    const modifiedPdfBytes = await pdfDoc.save();
    await fs.writeFile(target, modifiedPdfBytes);
    res.json({ success: true, filepath: target, message: 'PDF modified successfully', pageEdited: pageIndex + 1 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Save memory
app.post('/api/memory/save', async (req, res) => {
  try {
    const { key, data } = req.body;
    if (!key) return res.status(400).json({ error: 'key required' });
    const sanitizedKey = key.replace(/[^a-zA-Z0-9_-]/g, '_');
    const memoryFile = path.join(MEMORY_DIR, `${sanitizedKey}.json`);
    await fs.writeJson(memoryFile, { key, data, updatedAt: new Date().toISOString() }, { spaces: 2 });
    res.json({ success: true, key });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Load memory
app.get('/api/memory/load/:key', async (req, res) => {
  try {
    const sanitizedKey = req.params.key.replace(/[^a-zA-Z0-9_-]/g, '_');
    const memoryFile = path.join(MEMORY_DIR, `${sanitizedKey}.json`);
    const exists = await fs.pathExists(memoryFile);
    if (!exists) return res.status(404).json({ error: 'Memory not found', key: req.params.key });
    const data = await fs.readJson(memoryFile);
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Delete memory
app.delete('/api/memory/delete/:key', async (req, res) => {
  try {
    const sanitizedKey = req.params.key.replace(/[^a-zA-Z0-9_-]/g, '_');
    const memoryFile = path.join(MEMORY_DIR, `${sanitizedKey}.json`);
    await fs.remove(memoryFile);
    res.json({ success: true, key: req.params.key });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// List all memories
app.get('/api/memory/list', async (req, res) => {
  try {
    const files = await fs.readdir(MEMORY_DIR);
    const memories = [];
    for (const f of files) {
      if (f.endsWith('.json')) {
        try { memories.push(await fs.readJson(path.join(MEMORY_DIR, f))); } catch {}
      }
    }
    memories.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    res.json({ memories });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Chat with Ollama (Streaming, Agent tool-calling, document-aware)
app.post('/api/chat', async (req, res) => {
  res.setHeader('X-Accel-Buffering', 'no');
  try {
    let { messages, system, model = 'qwen2.5-coder:1.5b', stream = true, enableTools = false, activeDocumentPath } = req.body;
    if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: 'messages array required' });

    const defaultSystem = `You are a helpful, intelligent coding and computer assistant with direct filesystem awareness running locally on Windows.
Current project workspace root directory: ${__dirname}
You have access to inspect and manage files in the workspace.

CRITICAL INSTRUCTIONS - READ CAREFULLY:
1. NEVER hallucinate or invent details about any file. Only state what is explicitly present in the file content provided in the chat context.
2. If you have not read a file, say you have not read it. Do not guess its purpose, contents, or author.
3. When analyzing an attached file, quote its actual content. Do not fabricate details not present in the file.
4. If a file is empty or minimal, say so. Do not expand it into a full system or project.
5. Be accurate, helpful, and concise. Format code blocks with language identifiers.
6. When answering code or file questions, ground every claim in the actual file content visible to you.
7. You can use read_file, list_directory, read_document_text and write_file on the workspace. Read a file before describing or editing it, and use write_file when the user asks you to save or change a file instead of only printing code.
8. Tool paths are workspace-relative: call read_file with {"filepath": "package.json"}, never an absolute or invented path such as C:\\path\\to\\file.`;

    let effectiveSystem = system ? `${defaultSystem}\n\n${system}` : defaultSystem;

    // Inject a compact workspace file listing so the model can "see" files
    try {
      const listTree = async (dir, depth, prefix = '') => {
        if (depth < 0) return [];
        const out = [];
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const e of entries.slice(0, 80)) {
          if (e.name.startsWith('.') || e.name === 'node_modules') continue;
          const rel = prefix ? prefix + '/' + e.name : e.name;
          out.push(rel + (e.isDirectory() ? '/' : ''));
          if (e.isDirectory() && depth > 0) {
            out.push(...await listTree(path.join(dir, e.name), depth - 1, rel));
          }
        }
        return out;
      };
      const tree = await listTree(__dirname, 2);
      effectiveSystem += `\n\n[Workspace files (depth 2, ${tree.length} entries)]:\n${tree.slice(0, 200).join('\n')}`;
    } catch (e) { console.warn('workspace listing failed:', e.message); }

    // Inject active document context
    if (activeDocumentPath && await fs.pathExists(activeDocumentPath)) {
      try {
        const docText = await extractDocumentText(activeDocumentPath);
        effectiveSystem += `\n\n[Active Document Content (${path.basename(activeDocumentPath)})]:\n${docText.slice(0, 8000)}`;
      } catch (e) { console.warn('Could not extract active document text:', e.message); }
    }

    const requestPayload = { model, messages, system: effectiveSystem, stream, options: { temperature: 0.7, top_p: 0.9, top_k: 40, repeat_penalty: 1.15, presence_penalty: 0.1, frequency_penalty: 0.1, seed: -1 } };
    if (req.body.options && typeof req.body.options === 'object') requestPayload.options = { ...requestPayload.options, ...req.body.options };
    if (enableTools && !stream) requestPayload.tools = FS_TOOLS;

    // Resolve tool calls before streaming, and keep going while the model asks for
    // more: reading a file then writing another needs more than one round. Every
    // executed call is reported on the stream so the chat can show what touched disk.
    const toolRuns = [];
    const ranTools = new Set();
    if (enableTools) {
      for (let round = 0; round < 4; round++) {
        const toolRes = await fetch(`${OLLAMA_URL}/api/chat`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, messages, system: effectiveSystem, stream: false, tools: FS_TOOLS, options: requestPayload.options })
        });
        if (!toolRes.ok) break;
        const toolData = await toolRes.json().catch(() => null);
        const nativeCalls = toolData && toolData.message && Array.isArray(toolData.message.tool_calls)
          ? toolData.message.tool_calls
          : [];
        let calls = nativeCalls;
        if (!calls.length) {
          const guess = parseTextToolCall(toolData && toolData.message ? toolData.message.content : '');
          if (guess) calls = [{ function: { name: guess.name, arguments: guess.args } }];
        }
        if (!calls.length) break;
        const signature = (tc) => (tc.function?.name || '') + ':' + JSON.stringify(tc.function?.arguments || {});
        // Small models can loop on the same call; one execution of it is enough.
        if (calls.every(tc => ranTools.has(signature(tc)))) break;
        const toolResults = [];
        for (const tc of calls) {
          let args = tc.function && tc.function.arguments;
          if (!args) args = {};
          if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
          const name = (tc.function && tc.function.name) || 'unknown';
          ranTools.add(name + ':' + JSON.stringify(args));
          let result;
          try {
            result = await executeTool(name, args, req);
          } catch (err) {
            result = { error: err.message };
          }
          toolResults.push({ role: 'tool', content: JSON.stringify(result) });
          toolRuns.push({
            name,
            ok: !result.error,
            path: result.filepath || args.filepath || args.dirpath || null,
            error: result.error || null,
          });
        }
        const assistantMessage = nativeCalls.length
          ? toolData.message
          : {
              role: 'assistant',
              content: '',
              tool_calls: calls.map((tc, idx) => ({
                id: 'call_' + round + '_' + idx,
                type: 'function',
                function: { name: tc.function.name, arguments: tc.function.arguments || {} },
              })),
            };
        messages = [...messages, assistantMessage, ...toolResults];
      }
    }

const ollamaResponse = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(requestPayload)
    });

    if (!ollamaResponse.ok) {
      const errText = await ollamaResponse.text();
      return res.status(ollamaResponse.status).json({ error: `Ollama error (${ollamaResponse.status}): ${errText}` });
    }

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      for (const run of toolRuns) res.write(JSON.stringify({ tool: run }) + '\n');
      for await (const chunk of ollamaResponse.body) res.write(chunk);
      res.end();
    } else {
      const data = await ollamaResponse.json();
      if (data.message && data.message.tool_calls && data.message.tool_calls.length > 0) {
        const toolCalls = data.message.tool_calls;
        const toolResults = [];
        for (const tc of toolCalls) {
          const name = tc.function.name;
          const args = tc.function.arguments || {};
          const result = await executeTool(name, args, req);
          toolResults.push({ tool_call_id: tc.id || name, role: 'tool', content: JSON.stringify(result) });
        }
        const followUpMessages = [...messages, data.message, ...toolResults];
        const followUpResponse = await fetch(`${OLLAMA_URL}/api/chat`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, messages: followUpMessages, system: effectiveSystem, stream: false })
        });
        if (followUpResponse.ok) {
          const finalData = await followUpResponse.json();
          return res.json({ ...finalData, executedTools: toolCalls.map((tc, idx) => ({ tool: tc.function.name, args: tc.function.arguments, result: JSON.parse(toolResults[idx].content) })) });
        }
      }
      res.json(data);
    }
} catch (err) { console.error('Chat error:', err); res.status(500).json({ error: err.message }); }
  });

// -------------------------------------------------------------
// Kilo API Proxy Endpoints
// -------------------------------------------------------------

// Kilo health check - try to reach the server
app.get('/api/kilo/health', async (req, res) => {
  try {
    const resp = await fetch(`${KILO_URL}/global/health`, { signal: AbortSignal.timeout(3000) });
    if (resp.ok) {
      const data = await resp.json().catch(() => ({}));
      res.json({ status: 'ok', kiloStatus: 'online', healthy: data.healthy !== false });
    } else {
      res.json({ status: 'degraded', kiloStatus: 'unhealthy', error: 'Kilo server responded with error' });
    }
  } catch (err) {
    console.error('Kilo health check exception:', err.message);
    res.status(502).json({ error: `Cannot reach Kilo at ${KILO_URL}: ${err.message}`, kiloStatus: 'offline' });
  }
});

// List Kilo Gateway models available for chat
app.get('/api/kilo/models', async (req, res) => {
  try {
    const resp = await fetch(`${KILO_URL}/api/model`, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) return res.json({ models: [] });
    const data = await resp.json();
    const models = (data.data || [])
      .filter(m => m.providerID === 'kilo')
      .map(m => ({ id: m.id, name: m.name || m.id, free: /:free$|-free$/.test(m.id) || m.id.startsWith('kilo-auto/') }));
    models.sort((a, b) => {
      if (a.id.startsWith('kilo-auto/') !== b.id.startsWith('kilo-auto/')) return a.id.startsWith('kilo-auto/') ? -1 : 1;
      if (a.free !== b.free) return a.free ? -1 : 1;
      return a.id.localeCompare(b.id);
    });
    res.json({ models: models.filter(m => m.free).slice(0, 30) });
  } catch (err) { res.json({ models: [] }); }
});

const KILO_DIRECTORY = __dirname;

// Kilo runs are owned by this process, not by the request that starts them: a
// long task keeps going when the tab closes and is re-attached after a restart.
const KILO_RUN_DIR = path.join(__dirname, 'data', 'kilo-runs');
const kiloRuns = createKiloRuns({
  kiloUrl: KILO_URL,
  directory: KILO_DIRECTORY,
  runDir: KILO_RUN_DIR,
  maxDurationMs: Number(process.env.KILO_RUN_MAX_MS || 6 * 60 * 60 * 1000),
  offlineGraceMs: Number(process.env.KILO_RUN_OFFLINE_MS || 15 * 60 * 1000),
});

function kiloModelRef(model) {
  if (!model || typeof model !== 'string') return undefined;
  const modelID = model.startsWith('kilo/') ? model.slice(5) : model;
  if (!modelID) return undefined;
  return { providerID: 'kilo', modelID };
}

function kiloHeaders() {
  return { 'Content-Type': 'application/json', 'x-kilo-directory': KILO_DIRECTORY };
}

function kiloDirectoryQuery() {
  return `directory=${encodeURIComponent(KILO_DIRECTORY)}`;
}

function messageText(msg) {
  if (!msg) return '';
  const parts = msg.parts || msg.content || [];
  return parts.filter(p => p && p.type === 'text' && typeof p.text === 'string').map(p => p.text).join('');
}

// -------------------------------------------------------------
// Fleet task execution (local engines)
// -------------------------------------------------------------
function buildTaskPrompt(task) {
  return [
    `Ops task: ${task.title}`,
    task.description ? `Details:\n${task.description}` : '',
    `Agent role: ${task.agent || 'master'} · Assignee: ${task.assignee || 'unassigned'}${task.due_date ? ' · Due: ' + task.due_date : ''}`,
    'Work on this task now. Be concise and finish with a short summary of what you produced and any next step.',
  ].filter(Boolean).join('\n\n');
}

// Fleet tasks share the run registry: a long task survives the fleet request
// that started it, and completion comes from Kilo rather than a fixed timeout.
async function runKiloTask(prompt, agent = 'master') {
  const sessionRes = await fetch(`${KILO_URL}/session`, {
    method: 'POST',
    headers: kiloHeaders(),
    body: JSON.stringify({ title: 'Fleet task', agent }),
    signal: AbortSignal.timeout(15000),
  });
  if (!sessionRes.ok) throw new Error(`Kilo session error (${sessionRes.status})`);
  const session = await sessionRes.json();
  if (!session.id) throw new Error('Kilo session id missing');
  const { run } = await kiloRuns.start({
    sessionId: session.id,
    prompt,
    agent,
    model: process.env.FLEET_KILO_MODEL || undefined,
  });
  const budget = Number(process.env.KILO_TASK_TIMEOUT_MS || 30 * 60 * 1000);
  const finished = await kiloRuns.waitFor(run.id, budget);
  if (!finished.text.trim()) throw new Error('Kilo returned an empty answer');
  return finished.text;
}

async function runOllamaTask(prompt) {
  let model = process.env.FLEET_OLLAMA_MODEL || '';
  if (!model) {
    const tagsRes = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!tagsRes.ok) throw new Error(`Ollama unavailable (${tagsRes.status})`);
    const tags = await tagsRes.json();
    model = (tags.models || [])[0]?.name || '';
  }
  if (!model) throw new Error('No Ollama model installed');
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], stream: false }),
    signal: AbortSignal.timeout(170000),
  });
  if (!res.ok) throw new Error(`Ollama error (${res.status})`);
  const data = await res.json();
  return data.message?.content || '';
}

async function runTaskOnLocalEngine(task) {
  const prompt = buildTaskPrompt(task);
  const need = task.needs || 'any';
  const caps = fleet.getCapabilities();
  const engines = [];
  if (need === 'kilo') engines.push('kilo');
  else if (need === 'ollama') engines.push('ollama');
  else {
    if (caps.ollama) engines.push('ollama');
    if (caps.kilo) engines.push('kilo');
  }
  let lastError = null;
  for (const engine of engines) {
    try {
      const text = engine === 'kilo' ? await runKiloTask(prompt, task.agent || 'master') : await runOllamaTask(prompt);
      return { ok: true, engine, text };
    } catch (err) { lastError = err; }
  }
  return { ok: false, error: lastError?.message || `no local ${need} engine available` };
}

// Create Kilo session
app.post('/api/kilo/session', async (req, res) => {
  try {
    const { title, agent = 'code', model } = req.body;
    const body = { title: title || 'Computera Task', agent };
    if (model) body.model = model;
    const resp = await fetch(`${KILO_URL}/session`, {
      method: 'POST',
      headers: kiloHeaders(),
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      return res.status(resp.status).json({ error: `Kilo error (${resp.status}): ${errText}` });
    }
    const session = await resp.json();
    res.json({ sessionId: session.id, title: session.title, agent: session.agent, id: session.id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// List Kilo sessions
app.get('/api/kilo/sessions', async (req, res) => {
  try {
    const resp = await fetch(`${KILO_URL}/session?${kiloDirectoryQuery()}`, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return res.json({ sessions: [] });
    const data = await resp.json();
    res.json({ sessions: Array.isArray(data) ? data.slice(0, 50) : [] });
  } catch (err) {
    res.json({ sessions: [] });
  }
});

// Get Kilo session state
app.get('/api/kilo/session/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const resp = await fetch(`${KILO_URL}/session/${sessionId}?${kiloDirectoryQuery()}`, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return res.status(resp.status).json({ error: 'Kilo session not found' });
    const data = await resp.json();
    res.json(data);
  } catch (err) { res.status(502).json({ error: `Cannot reach Kilo: ${err.message}` }); }
});

// Get Kilo session messages (v1: [{ info, parts }])
app.get('/api/kilo/session/:sessionId/messages', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const resp = await fetch(`${KILO_URL}/session/${sessionId}/message?${kiloDirectoryQuery()}`, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return res.status(resp.status).json({ error: 'Failed to fetch Kilo messages' });
    const data = await resp.json();
    res.json(data);
  } catch (err) { res.status(502).json({ error: `Cannot reach Kilo: ${err.message}` }); }
});

// Send prompt to Kilo session (blocking, but backed by the run registry so a
// long task is waited on rather than abandoned after two minutes).
app.post('/api/kilo/session/:sessionId/prompt', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const prompt = typeof req.body.prompt === 'string' ? req.body.prompt : req.body.prompt?.text;
    if (!prompt) return res.status(400).json({ error: 'prompt required' });
    const { run } = await kiloRuns.start({ sessionId, prompt, model: req.body.model, agent: req.body.agent });
    const budget = Number(process.env.KILO_RUN_WAIT_MS || 10 * 60 * 1000);
    const finished = await kiloRuns.waitFor(run.id, budget);
    res.json({
      success: true, sessionId, runId: run.id,
      model: finished.modelID, provider: finished.providerID, text: finished.text,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Send prompt to Kilo session (streams the run as newline-delimited JSON).
// This is only a *view* over the run registry: closing this response detaches
// the viewer, it does not stop the run.
app.post('/api/kilo/session/:sessionId/prompt_stream', async (req, res) => {
  const { sessionId } = req.params;
  const prompt = typeof req.body.prompt === 'string' ? req.body.prompt : req.body.prompt?.text;
  if (!prompt) return res.status(400).json({ error: 'prompt required' });

  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  let closed = false;
  let unsubscribe = null;
  let heartbeat = null;
  const safeWrite = (payload) => {
    if (closed || res.writableEnded) return;
    try { res.write(JSON.stringify(payload) + '\n'); } catch { closed = true; }
  };
  const cleanup = () => {
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
  };
  const end = () => {
    cleanup();
    if (!res.writableEnded) { try { res.end(); } catch { /* client gone */ } }
  };
  res.on('close', () => { closed = true; cleanup(); });

  try {
    const { run } = await kiloRuns.start({
      sessionId, prompt, model: req.body.model, agent: req.body.agent,
    });
    let sent = 0;
    const flush = () => {
      const current = kiloRuns.get(run.id);
      if (!current) return;
      if (current.text.length > sent) {
        safeWrite({ delta: current.text.slice(sent) });
        sent = current.text.length;
      }
      if (current.status !== 'running') {
        safeWrite({ done: true, text: current.text, model: current.modelID, provider: current.providerID });
        end();
      }
    };
    unsubscribe = kiloRuns.subscribe(flush);
    heartbeat = setInterval(() => {
      const current = kiloRuns.get(run.id);
      if (!current) return;
      safeWrite({ status: current.status, waiting: !!current.waiting, elapsedMs: Date.now() - (current.startedMs || Date.now()) });
    }, 5000);
    flush();
  } catch (err) {
    safeWrite({ error: err.message });
    end();
  }
});

// Start a Kilo run and answer immediately. The run continues server-side whether
// or not this browser stays connected, and it is persisted for restart recovery.
app.post('/api/kilo/session/:sessionId/run', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const prompt = typeof req.body.prompt === 'string' ? req.body.prompt : req.body.prompt?.text;
    if (!prompt) return res.status(400).json({ error: 'prompt required' });
    const { run, reused } = await kiloRuns.start({
      sessionId, prompt, model: req.body.model, agent: req.body.agent,
    });
    res.json({ ...kiloRuns.snapshot(run, 0), runId: run.id, reused });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Read a run; ?offset=N returns only the text after that many characters, so a
// poller never re-renders the whole answer.
app.get('/api/kilo/run/:runId', (req, res) => {
  const run = kiloRuns.get(req.params.runId);
  if (!run) return res.status(404).json({ error: 'run not found' });
  res.json({ ...kiloRuns.snapshot(run, Number(req.query.offset) || 0), runId: run.id });
});

// Stop a run but keep whatever text it already produced.
app.post('/api/kilo/run/:runId/stop', (req, res) => {
  const run = kiloRuns.stop(req.params.runId);
  if (!run) return res.status(404).json({ error: 'run not found' });
  res.json({ ...kiloRuns.snapshot(run, 0), runId: run.id });
});

// The run a session is working on right now — used to re-attach after a reload.
app.get('/api/kilo/session/:sessionId/active-run', (req, res) => {
  const run = kiloRuns.activeRun(req.params.sessionId);
  if (!run) return res.json({ runId: null });
  res.json({ ...kiloRuns.snapshot(run, 0), runId: run.id });
});

// Delete Kilo session
app.delete('/api/kilo/session/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const resp = await fetch(`${KILO_URL}/session/${sessionId}?${kiloDirectoryQuery()}`, {
      method: 'DELETE',
      headers: kiloHeaders(),
    });
    if (!resp.ok) return res.status(resp.status).json({ error: 'Failed to delete Kilo session' });
    res.json({ success: true, sessionId });
  } catch (err) { res.status(502).json({ error: `Cannot reach Kilo: ${err.message}` }); }
});

// -------------------------------------------------------------
// Task Manager API (SQLite)
// -------------------------------------------------------------

function handleTaskError(res, err) {
  if (err instanceof TaskError) return res.status(err.status).json({ error: err.message });
  console.error('Task API error:', err);
  res.status(500).json({ error: err.message });
}

// -------------------------------------------------------------
// Pages: Studio (chat + POV) is /, chat-only is /chat
// -------------------------------------------------------------
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'studio.html')));
app.get('/studio', (req, res) => res.sendFile(path.join(__dirname, 'public', 'studio.html')));
app.get('/chat', (req, res) => res.sendFile(path.join(__dirname, 'public', 'chat.html')));

// POV (pdfcraft) proxy: exactly the three published build files, cached on disk.
// Same origin as the app so POV's ?host=parent bridge is usable.
async function servePov(sub, res) {
  if (!POV_ASSET_RE.test(sub)) return res.status(404).json({ error: 'Not found' });
  const cacheFile = path.join(POV_CACHE_DIR, sub || 'index.html');
  const type = sub === '' ? 'text/html; charset=utf-8' : sub.endsWith('.wasm') ? 'application/wasm' : 'application/javascript; charset=utf-8';
  res.setHeader('Content-Type', type);
  res.setHeader('Cache-Control', sub === '' ? 'public, max-age=600' : 'public, max-age=31536000, immutable');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  try {
    if (await fs.pathExists(cacheFile)) {
      const fresh = sub !== '' || Date.now() - (await fs.stat(cacheFile)).mtimeMs < 600000;
      if (fresh) return res.sendFile(cacheFile);
    }
    const upstream = await fetch(POV_UPSTREAM + sub, { headers: { 'accept-encoding': 'identity' } });
    if (!upstream.ok) return res.status(502).json({ error: `POV upstream responded ${upstream.status}` });
    const buf = Buffer.from(await upstream.arrayBuffer());
    await fs.ensureDir(POV_CACHE_DIR);
    await fs.writeFile(cacheFile, buf);
    return res.send(buf);
  } catch (err) {
    if (await fs.pathExists(cacheFile).catch(() => false)) return res.sendFile(cacheFile);
    return res.status(502).json({ error: `POV proxy failed: ${err.message}` });
  }
}
app.get(['/pdfcraft', '/pdfcraft/'], (req, res) => {
  if (req.path === '/pdfcraft') return res.redirect(302, '/pdfcraft/');
  return servePov('', res);
});
app.get('/pdfcraft/*', (req, res) => servePov(String(req.params[0] || ''), res));

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/api/tasks', (req, res) => {
  try {
    res.json({ tasks: listTasks({
      status: req.query.status,
      assignee: req.query.assignee,
      agent: req.query.agent,
      worker: req.query.worker,
      needs: req.query.needs,
      from: req.query.from,
      to: req.query.to,
      q: req.query.q,
    }) });
  } catch (err) { handleTaskError(res, err); }
});

app.post('/api/tasks', (req, res) => {
  try { res.status(201).json(createTask(req.body || {})); } catch (err) { handleTaskError(res, err); }
});

app.get('/api/tasks/:id', (req, res) => {
  try {
    const task = getTask(req.params.id);
    if (!task) return res.status(404).json({ error: 'task not found' });
    res.json(task);
  } catch (err) { handleTaskError(res, err); }
});

app.patch('/api/tasks/:id', (req, res) => {
  try { res.json(updateTask(req.params.id, req.body || {})); } catch (err) { handleTaskError(res, err); }
});

app.delete('/api/tasks/:id', (req, res) => {
  try { deleteTask(req.params.id); res.json({ success: true }); } catch (err) { handleTaskError(res, err); }
});

// Tool execution endpoint
app.post('/api/tools/execute', async (req, res) => {
  try {
    const { name, args } = req.body;
    if (!name) return res.status(400).json({ error: 'tool name required' });
    const result = await executeTool(name, args || {}, req);
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// -------------------------------------------------------------
// Fleet API
// -------------------------------------------------------------
const fleet = createFleet({
  store: {
    upsertWorker, touchWorker, listWorkers, deleteWorker, getWorker,
    countActiveByWorker, recordEvent, listEvents, getRotation, saveRotation,
    getTask, updateTask,
  },
  token: FLEET_TOKEN,
  hostUrl: SELF_URL,
  selfId: SELF_ID,
  selfName: SELF_NAME,
  runLocalTask: runTaskOnLocalEngine,
  // Sprint steps name their role; only workers that serve that capability tier are
  // preferred, so a long sprint spreads work across the whole fleet.
  roleForWorker,
  onLinkToken: (token) => { activeLinkToken = token || null; },
  staleMs: 45000,
});

const fleetHits = new Map();
function fleetRateLimit(req, res, next) {
  const key = String(req.ip || req.socket?.remoteAddress || 'unknown');
  const now = Date.now();
  const bucket = fleetHits.get(key) || { start: now, count: 0 };
  if (now - bucket.start > 60000) { bucket.start = now; bucket.count = 0; }
  bucket.count += 1;
  fleetHits.set(key, bucket);
  if (bucket.count > 240) return res.status(429).json({ error: 'Too many fleet requests' });
  next();
}

// Machine-to-machine calls need the shared token once one is configured.
function requireFleetTokenStrict(req, res, next) {
  if (!FLEET_TOKEN) {
    if (isLoopbackHost(req)) return next();
    return res.status(401).json({ error: 'FLEET_TOKEN is required for remote fleet calls' });
  }
  if (hasFleetToken(req)) return next();
  return res.status(401).json({ error: 'Invalid fleet token' });
}

// Roster/calendar views plus the dashboard's own actions (dispatch, rotate) are
// available to the local browser and to anyone already unlocked by today's link.
function requireFleetRead(req, res, next) {
  if (!FLEET_TOKEN || hasFleetToken(req) || isLoopbackHost(req) || req.fleetLinkOk) return next();
  return res.status(401).json({ error: 'Fleet token required' });
}

app.post('/api/fleet/join', fleetRateLimit, requireFleetTokenStrict, (req, res) => {
  try { res.status(201).json({ ok: true, worker: fleet.join(req.body || {}) }); }
  catch (err) { res.status(err.status || 400).json({ error: err.message }); }
});

app.post('/api/fleet/heartbeat', fleetRateLimit, requireFleetTokenStrict, (req, res) => {
  try { res.json(fleet.heartbeat(req.body || {})); }
  catch (err) { res.status(err.status || 400).json({ error: err.message }); }
});

app.get('/api/fleet/workers', fleetRateLimit, requireFleetRead, (req, res) => {
  res.json({
    role: ROLE,
    self: { id: SELF_ID, name: SELF_NAME, base_url: SELF_URL, capabilities: fleet.getCapabilities() },
    workers: fleet.roster(),
    today: fleet.today(),
  });
});

app.get('/api/fleet/events', fleetRateLimit, requireFleetRead, (req, res) => {
  res.json({ events: fleet.events(req.query.limit) });
});

app.get('/api/fleet/today', fleetRateLimit, requireFleetRead, (req, res) => {
  res.json({ today: fleet.today(), role: ROLE });
});

app.post('/api/fleet/rotate', fleetRateLimit, requireFleetRead, (req, res) => {
  try { res.json({ today: fleet.today(), rotated: fleet.rotateNow() }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/fleet/workers/:id', fleetRateLimit, requireFleetTokenStrict, (req, res) => {
  try {
    const removed = fleet.removeWorker(req.params.id);
    if (!removed) return res.status(404).json({ error: 'worker not found' });
    res.json({ success: true, id: req.params.id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Capability-aware dispatch: pick the least-loaded worker that can actually run the task.
app.post('/api/fleet/dispatch/:taskId', fleetRateLimit, requireFleetRead, async (req, res) => {
  try {
    METRICS.dispatch++;
    const outcome = await fleet.dispatch(req.params.taskId);
    res.status(outcome.ok ? 200 : 409).json(outcome);
  } catch (err) {
    if (err instanceof TaskError) return handleTaskError(res, err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Called by the master on the node that should run the task (its own local engines).
app.post('/api/fleet/run/:taskId', fleetRateLimit, requireFleetTokenStrict, async (req, res) => {
  try {
    const task = req.body?.task || getTask(req.params.taskId);
    if (!task) return res.status(404).json({ error: 'task not found' });
    const result = await runTaskOnLocalEngine(task);
    res.status(result.ok ? 200 : 502).json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// -------------------------------------------------------------
// Sustained sprints (Stage 4) and automations (Stages 5-6)
// -------------------------------------------------------------
function roleOverrides() {
  try {
    const row = getSetting('automation_roles');
    const parsed = row && row.value ? JSON.parse(row.value) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}

// Every model any online node reports, so role tiers follow the real fleet.
function fleetModels() {
  const models = new Set();
  for (const worker of fleet.roster()) {
    for (const model of ((worker.capabilities || {}).models || [])) {
      if (model) models.add(String(model));
    }
  }
  return [...models];
}

// Tiers are ranked across the whole fleet, so a worker with a single model still
// serves a tier (smallest fleet-wide = pace-maker, largest = orchestrator). Cached
// briefly because dispatch asks this once per candidate.
let fleetRoleCache = { key: '', at: 0, roles: new Map() };
function fleetModelRoles() {
  const models = fleetModels();
  const key = models.join('|');
  const stamp = Date.now();
  if (fleetRoleCache.key !== key || stamp - fleetRoleCache.at > 1500) {
    const roles = assignFleetRoles(models, roleOverrides());
    fleetRoleCache = { key, at: stamp, roles: new Map(roles.map(entry => [entry.model, entry.role])) };
  }
  return fleetRoleCache.roles;
}

function roleForWorker(worker) {
  const roles = fleetModelRoles();
  const served = new Set(
    (((worker && worker.capabilities) || {}).models || [])
      .map(model => roles.get(String(model)))
      .filter(Boolean),
  );
  return ['orchestrator', 'worker', 'pace-maker'].find(role => served.has(role)) || null;
}

// A sprint step is a real child task, so it runs through the same capability-aware
// dispatch, keeps its run output, and stays in the task list as an audit trail.
async function runSprintStep(step, sprint, context = {}) {
  const prompt = buildStepPrompt(step, sprint, context);
  // Every engine is eligible; the role tier is expressed through dispatch, not by
  // excluding Ollama-only workers from orchestration stages.
  const needs = 'any';

  if (step.task_id) {
    try {
      updateTask(step.task_id, { description: prompt, status: 'in_progress', blocked_reason: null, needs });
    } catch (err) {
      return { ok: false, error: 'could not prepare the step task: ' + err.message };
    }
    const outcome = await fleet.dispatch(step.task_id);
    if (!outcome || !outcome.ok) return { ok: false, error: (outcome && outcome.error) || 'dispatch failed' };
    const task = getTask(step.task_id);
    const text = task && task.result ? String(task.result) : '';
    if (!text.trim()) return { ok: false, error: 'step produced no output' };
    return { ok: true, text };
  }

  const local = await runTaskOnLocalEngine({
    id: step.id,
    title: step.stage + ': ' + (step.source_title || sprint.goal),
    description: prompt,
    agent: step.role,
    needs,
  });
  return local.ok ? { ok: true, text: local.text } : { ok: false, error: local.error };
}

const sprints = createSprints({
  store: {
    createSprint, getSprint, listSprints, updateSprint,
    addSprintStep, listSprintSteps, getSprintStep, updateSprintStep, nextPendingStep,
    addSprintFeed, listSprintFeed, resetInterruptedSprints,
    createTask, getTask, updateTask,
  },
  runStep: runSprintStep,
  maxParallel: Math.max(1, Math.min(Number(process.env.SPRINT_PARALLEL || 3) || 3, 4)),
});

// Sprint control changes shared state, so holding today's public link is not enough.
function requireFleetAction(req, res, next) {
  if (hasFleetToken(req) || basicAuthOk(req)) return next();
  if (isLoopbackHost(req)) return next();
  return res.status(403).json({ error: 'Sprint control requires the fleet token or local access' });
}

app.get('/api/automations/roles', fleetRateLimit, requireFleetRead, (req, res) => {
  const models = fleetModels();
  const overrides = roleOverrides();
  res.json({
    models,
    overrides,
    roles: assignFleetRoles(models, overrides),
    roles_available: ROLES,
    workers: fleet.roster().map((worker) => {
      const workerRoles = assignFleetRoles(models, overrides)
        .filter(entry => ((worker.capabilities || {}).models || []).includes(entry.model));
      return {
        id: worker.id,
        name: worker.name,
        status: worker.status,
        age_ms: worker.age_ms,
        is_self: worker.id === SELF_ID,
        models: (worker.capabilities || {}).models || [],
        roles: [...new Set(workerRoles.map(entry => entry.role))],
        load: countActiveByWorker()[worker.id] || 0,
      };
    }),
    parallel: Math.max(1, Math.min(Number(process.env.SPRINT_PARALLEL || 3) || 3, 4)),
    templates: STAGE_TEMPLATES,
  });
});

app.put('/api/automations/roles', fleetRateLimit, requireFleetAction, (req, res) => {
  const input = (req.body && req.body.overrides) || {};
  const clean = {};
  for (const [model, role] of Object.entries(input)) {
    if (!model || !ROLES.includes(role)) continue;
    clean[String(model).slice(0, 120)] = role;
  }
  setSetting('automation_roles', JSON.stringify(clean));
  const models = fleetModels();
  res.json({ overrides: clean, roles: assignFleetRoles(models, clean) });
});

app.get('/api/sprints', fleetRateLimit, requireFleetRead, (req, res) => {
  const all = listSprints(Number(req.query.limit) || 20);
  res.json({
    sprints: all,
    active: all.filter(s => s.status === 'running' || s.status === 'review' || s.status === 'paused'),
  });
});

app.post('/api/sprints', fleetRateLimit, requireFleetAction, (req, res) => {
  try {
    const body = req.body || {};
    const ids = Array.isArray(body.taskIds) ? body.taskIds.map(String).filter(Boolean) : null;
    const tasks = ids
      ? ids.map(getTask).filter(Boolean)
      : (body.goalOnly ? [] : listTasks({}).filter(t => t.status === 'todo' || t.status === 'in_progress'));
    const sprint = sprints.create({
      goal: body.goal,
      tasks,
      template: body.template,
      stages: body.stages,
      durationHours: body.durationHours,
      models: fleetModels(),
      overrides: roleOverrides(),
    });
    res.status(201).json(sprints.status(sprint.id));
  } catch (err) { res.status(err.status || 400).json({ error: err.message }); }
});

app.get('/api/sprints/:id', fleetRateLimit, requireFleetRead, (req, res) => {
  try {
    const state = sprints.status(req.params.id);
    res.json({
      ...state,
      tasks: state.steps.map(s => s.task_id).filter(Boolean).map(getTask).filter(Boolean),
    });
  } catch (err) { res.status(err.status || 404).json({ error: err.message }); }
});

for (const action of ['start', 'resume', 'pause', 'stop']) {
  app.post('/api/sprints/:id/' + action, fleetRateLimit, requireFleetAction, (req, res) => {
    try { res.json({ sprint: sprints[action](req.params.id) }); }
    catch (err) { res.status(err.status || 400).json({ error: err.message }); }
  });
}

app.get('/api/sprints/:id/stream', fleetRateLimit, requireFleetRead, (req, res) => {
  const sprint = getSprint(req.params.id);
  if (!sprint) return res.status(404).json({ error: 'sprint not found' });
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  let last = '';
  const timer = setInterval(() => {
    try {
      const s = getSprint(req.params.id);
      if (!s) { res.write('event: close\ndata: {}\n\n'); clearInterval(timer); res.end(); return; }
      const snap = JSON.stringify({ status: s.status, steps: s.steps.map(x => ({ id: x.id, stage: x.stage, status: x.status, output: x.output, error: x.error })) });
      if (snap !== last) { last = snap; res.write(`data: ${snap}\n\n`); }
      if (s.status === 'done' || s.status === 'stopped' || s.status === 'cancelled') { res.write('event: close\ndata: {}\n\n'); clearInterval(timer); res.end(); }
    } catch (err) { res.write(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`); }
  }, 1500);
  req.on('close', () => clearInterval(timer));
});

app.get('/api/sprints/:id/feed', fleetRateLimit, requireFleetRead, (req, res) => {
  try {
    const sprint = getSprint(req.params.id);
    if (!sprint) return res.status(404).json({ error: 'sprint not found' });
    res.json({ feed: listSprintFeed({ sprintId: sprint.id, kind: req.query.kind, limit: req.query.limit }) });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/sprints/:id/steps/:stepId/approve', fleetRateLimit, requireFleetAction, (req, res) => {
  try {
    const body = req.body || {};
    const sprint = sprints.approve(req.params.id, req.params.stepId, {
      approve: body.approve !== false,
      note: body.note,
    });
    res.json({ sprint });
  } catch (err) { res.status(err.status || 400).json({ error: err.message }); }
});

app.post('/api/sprints/:id/steps/:stepId/retry', fleetRateLimit, requireFleetAction, (req, res) => {
  try { res.json({ sprint: sprints.retry(req.params.id, req.params.stepId) }); }
  catch (err) { res.status(err.status || 400).json({ error: err.message }); }
});

// Persisted node/exposure state plus live counts, so a restart keeps the same picture.
app.get('/api/state', fleetRateLimit, requireFleetRead, (req, res) => {
  try {
    res.json({
      role: ROLE,
      self: { id: SELF_ID, name: SELF_NAME, base_url: SELF_URL },
      settings: listSettings(),
      today: fleet.today(),
      counts: { tasks: listTasks({}).length, workers: fleet.roster().length },
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Shared calendar: day -> entries, plus who hosts each day.
app.get('/api/calendar', fleetRateLimit, (req, res) => {
  try {
    const tasks = listTasks({
      worker: req.query.worker,
      needs: req.query.needs,
      from: req.query.from,
      to: req.query.to,
      q: req.query.q,
    });
    const days = {};
    for (const task of tasks) {
      if (!task.due_date) continue;
      (days[task.due_date] = days[task.due_date] || []).push(task);
    }
    const today = fleet.today();
    res.json({ days, hosts: { [today.date]: today }, today, workers: fleet.roster() });
  } catch (err) { handleTaskError(res, err); }
});

// Stable entry point: always send people to today's host.
app.get('/today', (req, res) => {
  if (ROLE === 'worker' && MASTER_URL) return res.redirect(302, `${MASTER_URL}/today`);
  const info = fleet.today();
  res.redirect(302, info.link || '/dashboard');
});

// Worker onboarding: serves a bootstrap script that writes .env and starts npm start.
// Token must match FLEET_TOKEN (or today's link token) to prevent open enrollment.
app.get('/join/:token', (req, res) => {
  const supplied = String(req.params.token || '');
  const ok = (FLEET_TOKEN && sameSecret(supplied, FLEET_TOKEN)) || sameSecret(supplied, activeLinkToken);
  if (!ok) return res.status(401).type('text/plain').send('invalid or expired token');
  const master = PUBLIC_URL || `http://localhost:${PORT}`;
  const script = `#!/usr/bin/env bash
set -e
MASTER_URL="${master}"
FLEET_TOKEN="${supplied}"
cat > .env <<EOF
NODE_ROLE=worker
MASTER_URL=\${MASTER_URL}
FLEET_TOKEN=\${FLEET_TOKEN}
KILO_URL=http://127.0.0.1:7777
OLLAMA_URL=http://127.0.0.1:11434
# Set PUBLIC_URL to a reachable address (tunnel or LAN IP) before starting,
# otherwise this worker registers as relay_only and will not receive tasks.
EOF
echo "Wrote .env. Set PUBLIC_URL, then run: npm install && npm start"
`;
  res.type('text/plain').send(script);
});

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// -------------------------------------------------------------
// Fleet boot
// -------------------------------------------------------------
fleet.registerSelf();
probeCapabilities({ ollamaUrl: OLLAMA_URL, kiloUrl: KILO_URL })
  .then((caps) => {
    fleet.setCapabilities(caps);
// Auto-tunnel: if no PUBLIC_URL, spawn cloudflared and adopt its URL.
const CLOUDFLARED = process.env.CLOUDFLARED_BIN || 'C:\\Users\\molel\\tools\\cloudflared.exe';
if (ROLE === 'worker' && !PUBLIC_URL) {
  (async () => {
    try {
      const { spawn } = await import('child_process');
      const cf = spawn(CLOUDFLARED, ['tunnel', '--url', `http://localhost:${PORT}`, '--http-host-header', `localhost:${PORT}`], { stdio: ['ignore', 'pipe', 'pipe'] });
      const capture = (chunk) => {
        const m = String(chunk).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (m && !PUBLIC_URL) {
          PUBLIC_URL = m[0];
          SELF_URL = PUBLIC_URL;
          console.log('Auto-tunnel URL:', PUBLIC_URL);
          try { fleet.registerSelf(); } catch {}
        }
      };
      cf.stdout.on('data', capture);
      cf.stderr.on('data', capture);
      cf.on('exit', (code) => console.warn('cloudflared exited:', code));
      console.log('Auto-tunnel starting...');
    } catch (err) {
      console.warn('Auto-tunnel failed to start:', err.message);
    }
  })();
}

fleet.registerSelf();
    const label = [caps.kilo ? 'kilo' : null, caps.ollama ? `ollama (${caps.models.length} models)` : null]
      .filter(Boolean).join(' + ') || 'no local engines';
    console.log(`Fleet ${ROLE} as ${SELF_ID}: ${label}`);
  })
  .catch((err) => console.warn('Capability probe failed:', err.message));

if (ROLE === 'master') {
  const rotateTimer = setInterval(() => {
    try { fleet.expireStale(); } catch (err) { console.warn('Rotation check failed:', err.message); }
  }, 30000);
  rotateTimer.unref?.();

  // Sprint loop: one step per sprint per tick, resumed from the SQLite checkpoint
  // after a restart. Never blocks the HTTP server.
  try { sprints.resetInterrupted(); } catch (err) { console.warn('Sprint recovery failed:', err.message); }
  const sprintTimer = setInterval(() => {
    sprints.tick().catch(err => console.warn('Sprint tick failed:', err.message));
  }, 5000);
  sprintTimer.unref?.();
} else if (MASTER_URL) {
  if (!PUBLIC_URL) console.warn('Fleet worker has no PUBLIC_URL: registering as relay_only (not dispatchable). Set PUBLIC_URL to a reachable address.');
  startWorkerHeartbeat({
    masterUrl: MASTER_URL,
    token: FLEET_TOKEN,
    intervalMs: 15000,
    info: async () => ({
      id: SELF_ID,
      name: SELF_NAME,
      base_url: SELF_URL,
      capabilities: { ...fleet.getCapabilities(), public_url: PUBLIC_URL, relay_only: !PUBLIC_URL },
      max_concurrency: Number(process.env.MAX_CONCURRENCY || 1),
    }),
    onToday: (today) => { activeLinkToken = today?.is_host ? today.link_token : null; },
    onError: (err) => console.warn('Fleet heartbeat failed:', err.message),
  });
  console.log(`Fleet worker ${SELF_ID} reporting to ${MASTER_URL}`);
} else {
  console.warn('NODE_ROLE=worker without MASTER_URL: running standalone');
}

// Every role re-probes its own engines: a Kilo/Ollama that starts (or finishes
// installing a model) after boot must become dispatchable without a restart.
const capabilityProbeTimer = setInterval(() => {
  probeCapabilities({ ollamaUrl: OLLAMA_URL, kiloUrl: KILO_URL })
    .then((caps) => {
      const before = fleet.getCapabilities();
      const changed = before.kilo !== caps.kilo
        || before.ollama !== caps.ollama
        || (before.models || []).length !== (caps.models || []).length;
      fleet.setCapabilities(caps);
      if (changed) {
        const label = [caps.kilo ? 'kilo' : null, caps.ollama ? `ollama (${caps.models.length} models)` : null]
          .filter(Boolean).join(' + ') || 'no local engines';
        console.log(`Capabilities now: ${label}`);
      }
    })
    .catch(() => {});
}, 60000);
capabilityProbeTimer.unref?.();

// -------------------------------------------------------------
// Persisted state
// -------------------------------------------------------------
// Exposure and identity settings live in the database so a restart (or another
// node reading the master) can see how this machine is currently serving the team.
try {
  setSetting('role', ROLE);
  setSetting('node', SELF_ID);
  setSetting('public_url', PUBLIC_URL);
  setSetting('public_mode', PUBLIC_MODE ? 'on' : 'off');
  setSetting('pov_mode', POV_MODE);
  setSetting('workspace_share', WORKSPACE_SHARE);
  setSetting('shared_fs_root', SHARED_FS_ROOT);
  setSetting('allowed_fs_roots', ALLOWED_FS_ROOTS.join(';'));
  setSetting('last_boot', new Date().toISOString());
} catch (err) {
  console.warn('Could not persist fleet state:', err.message);
}

// Ensure Kilo serve is running; start it if needed.
async function ensureKilo() {
  try {
    const r = await fetch(`${KILO_URL}/global/health`, { signal: AbortSignal.timeout(2000) });
    if (r.ok) return;
  } catch {}
  try {
const exe = process.env.KILO_EXE || 'kilo';
    spawn(exe, ['serve', '--port', '7777', '--hostname', '127.0.0.1'], { detached: true, stdio: 'ignore', shell: true }).unref();
    console.log('Kilo: started kilo serve');
  } catch (err) {
    console.warn('Kilo: could not start kilo serve:', err.message);
  }
}
ensureKilo();
setInterval(ensureKilo, 30000);

// Runs a previous process left mid-flight are re-attached here (crash restart):
// Kilo keeps its own session state, so the answer is not lost.
kiloRuns.restore()
  .then((count) => { if (count) console.log(`Kilo: re-attached ${count} running task(s) after restart`); })
  .catch((err) => console.warn('Kilo run restore failed:', err.message));

const server = createServer(app);
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Another Computera instance is probably running; stop it or set PORT.`);
    process.exit(1);
  }
  console.error('HTTP server error:', err.message);
});
server.listen(PORT, '0.0.0.0', () => {
  const { port } = server.address();
  console.log(`Web app running on http://0.0.0.0:${port}`);
  console.log(`Local: http://localhost:${port}`);
  console.log(`Ollama: ${OLLAMA_URL}`);
  console.log(`Workspace root: ${__dirname}`);
  console.log(`Kilo: ${KILO_URL}`);
  console.log(`Fleet role: ${ROLE} as ${SELF_ID}${PUBLIC_MODE ? ' (public link mode)' : ''}`);
  console.log(`Uploads dir: ${UPLOADS_DIR}`);
  console.log(`Workspace sharing: ${WORKSPACE_SHARE} (root ${SHARED_FS_ROOT})`);
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}, shutting down gracefully...`);
  try { kiloRuns.close(); } catch {}
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
  setTimeout(() => {
    console.log('Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// A long task must not take the whole app down with it: log the failure, keep
// serving, and let the run registry report what happened on its next poll.
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (process kept alive):', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection (process kept alive):', reason);
});
