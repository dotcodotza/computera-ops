#!/usr/bin/env node
/* Start a Cloudflare quick tunnel for this node and store the URL in .env.
 *
 *   npm run tunnel              start cloudflared against this node's port
 *   npm run tunnel -- --port 3000
 *   npm run tunnel -- --no-write   print the URL but leave .env alone
 *
 * A quick tunnel gives a new hostname every time. For a stable address use a
 * named tunnel (`cloudflared tunnel create` + `cloudflared tunnel run`) and put
 * that hostname in PUBLIC_URL instead; the app only ever reads PUBLIC_URL.
 */
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs-extra';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ENV_FILE = path.join(ROOT, '.env');

function argValue(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/** --port wins, then PORT, then .env, then 3000. Never 0: that tunnels to nothing. */
function resolvePort() {
  const raw = argValue('--port', undefined) ?? process.env.PORT ?? readEnv('PORT') ?? 3000;
  const port = Number(raw);
  return Number.isFinite(port) && port > 0 ? port : 3000;
}

function readEnv(name) {
  try {
    const line = fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)
      .find((l) => l.trim().startsWith(name + '='));
    return line ? line.slice(line.indexOf('=') + 1).trim() : undefined;
  } catch {
    return undefined;
  }
}

function cloudflaredPath() {
  const candidates = [
    process.env.CLOUDFLARED_EXE,
    path.join(ROOT, '.tools', process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'),
    'cloudflared',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate === 'cloudflared') return candidate;
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'cloudflared';
}

async function writePublicUrl(url, port) {
  let lines = [];
  try { lines = (await fs.readFile(ENV_FILE, 'utf8')).split(/\r?\n/); } catch { lines = []; }
  const index = lines.findIndex((l) => l.trim().startsWith('PUBLIC_URL='));
  const entry = `PUBLIC_URL=${url}`;
  if (index > -1) lines[index] = entry;
  else lines.push(entry);
  await fs.writeFile(ENV_FILE, lines.join('\n'));
  await fs.ensureDir(path.join(ROOT, 'data'));
  await fs.writeJson(path.join(ROOT, 'data', 'tunnel.json'), {
    url, port, startedAt: new Date().toISOString(),
  }, { spaces: 2 });
}

const port = resolvePort();
const noWrite = process.argv.includes('--no-write');
const exe = cloudflaredPath();

console.log(`Starting Cloudflare tunnel to http://127.0.0.1:${port} with ${exe}`);
const child = spawn(exe, ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'], {
  stdio: ['ignore', 'pipe', 'pipe'],
});

let found = false;
const onData = (chunk) => {
  const text = chunk.toString();
  process.stderr.write(text);
  if (found) return;
  const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
  if (!match) return;
  found = true;
  console.log(`\nPublic URL: ${match[0]}`);
  if (noWrite) {
    console.log('--no-write: .env was not changed.');
    return;
  }
  writePublicUrl(match[0], port)
    .then(() => console.log(`Saved PUBLIC_URL in .env. Restart the app to advertise ${match[0]}.`))
    .catch((err) => console.error('Could not write .env:', err.message));
};

child.stdout.on('data', onData);
child.stderr.on('data', onData);
child.on('error', (err) => {
  console.error(`Could not start cloudflared (${exe}): ${err.message}`);
  console.error('Set CLOUDFLARED_EXE to the binary, or download cloudflared into .tools/.');
  process.exit(1);
});
child.on('exit', (code) => {
  if (!found) console.error('cloudflared exited before reporting a URL.');
  process.exit(code ?? 0);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    child.kill();
    setTimeout(() => process.exit(0), 500);
  });
}
