// Pluggable execution runners for sustained sprints.
//
// A runner is a plain object:
//
//   {
//     name: 'dsh',
//     kind: 'harness',
//     available(): boolean,
//     describe(): string,
//     run({ step, sprint, prompt, onEvent, signal }): Promise<{ ok, text, engine, error? }>
//   }
//
// `onEvent` receives normalised progress records ({ kind, message, detail }) so the
// sprint feed can show the work as it happens instead of only the final answer.
//
// Two runners ship:
//   dsh   — DeepSeek Harness headless (`dsh --profile headless --json`). This is the
//           sprint engine: one task per process, no listening port, loopback by
//           construction. Chat and ad-hoc tasks keep their own engines.
//   fleet — capability-aware dispatch to the worker that serves the step's role.
//
// Runners are selected by name (SPRINT_RUNNER=auto|dsh|fleet); `auto` prefers dsh
// and falls back to the fleet so a machine without the harness keeps working.

import { spawn, spawnSync } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_STEP_TIMEOUT_MS = 10 * 60 * 60 * 1000;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function clip(value, max = 4000) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}\n… [${text.length - max} chars cut]` : text;
}

function firstLine(value, max = 160) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max) + '…' : text;
}

function previewOf(value) {
  if (value === undefined || value === null || value === '') return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return firstLine(text, 220);
}

// dsh --profile headless --json vocabulary:
//   session · status · text · thinking · tool_call · tool_result · error · final
// Everything else is kept as a system line so an unknown projection never
// disappears from the feed.
export function normalizeDshEvent(record = {}) {
  const type = String(record.type || record.kind || '').toLowerCase();
  switch (type) {
    case 'session':
      return {
        kind: 'system',
        message: `session ${firstLine(record.sessionId || record.session_id || '', 80)}`.trim(),
        detail: '',
      };
    case 'status': {
      const reason = record.reason && record.reason.error ? record.reason.error.message : '';
      const bits = [record.phase, record.status, record.state, record.message, reason ? firstLine(reason, 180) : '']
        .filter(Boolean)
        .map(value => (typeof value === 'string' ? value : previewOf(value)));
      return {
        kind: reason ? 'error' : 'status',
        message: bits.join(' · ') || 'status',
        detail: reason ? String(reason) : '',
      };
    }
    case 'thinking':
    case 'reasoning': {
      const text = String(record.thinking ?? record.text ?? record.content ?? '');
      return { kind: 'thinking', message: firstLine(text, 200), detail: clip(text, 8000) };
    }
    case 'text':
    case 'message': {
      const text = String(record.text ?? record.content ?? '');
      return { kind: 'agent', message: firstLine(text, 200), detail: clip(text, 20000) };
    }
    case 'tool_call':
    case 'tool_use': {
      const tool = record.tool || record.function || {};
      const name = String(record.name || record.toolName || tool.name || 'tool');
      const args = record.arguments ?? record.input ?? tool.arguments ?? tool.input ?? {};
      return {
        kind: 'tool',
        message: `${name} ${previewOf(args)}`.trim(),
        detail: clip(args, 8000),
      };
    }
    case 'tool_result': {
      const tool = record.tool || {};
      const name = String(record.name || record.toolName || tool.name || 'tool');
      const status = String(record.status || '');
      const output = record.output ?? record.result ?? record.content ?? record.text ?? '';
      const error = record.error;
      return {
        kind: error ? 'tool_error' : 'tool_result',
        message: `${name}${status ? ' · ' + status : ''}${error ? ' · ' + firstLine(previewOf(error), 120) : ''}`.trim(),
        detail: clip(error || output, 8000),
      };
    }
    case 'error':
      return {
        kind: 'error',
        message: firstLine(record.message || record.error || record.reason || 'runner error', 300),
        detail: clip(record.message || record.error || '', 4000),
      };
    case 'final': {
      const reason = record.reason && typeof record.reason === 'object' ? record.reason.kind || record.reason : record.reason;
      const reasonError = record.reason && record.reason.error ? record.reason.error.message : '';
      return {
        kind: reasonError ? 'error' : 'result',
        message: reasonError
          ? `final · ${firstLine(reasonError, 240)}`
          : (reason ? `final · ${firstLine(reason, 120)}` : 'final'),
        detail: clip(record.text || reasonError || '', 20000),
      };
    }
    default: {
      const detail = record.message || record.text || '';
      const fallback = type || 'event';
      return {
        kind: 'system',
        message: detail ? firstLine(detail, 200) : firstLine(JSON.stringify(record), 200),
        detail: detail ? clip(detail, 4000) : clip(record, 4000),
        note: fallback,
      };
    }
  }
}

// Keeps the preview stable while a long harness run is happening: the app's own
// health endpoint is checked before and during the run. Repeated failures abort the
// run instead of letting an unattended 10-hour step hammer a broken node.
export function createPreviewGuard({
  url = 'http://127.0.0.1:3000/api/health',
  timeoutMs = 8000,
  failuresToAbort = 3,
  fetchImpl = (...args) => fetch(...args),
} = {}) {
  let failures = 0;
  return {
    url,
    failuresToAbort,
    get failures() { return failures; },
    async check() {
      try {
        const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
        failures = res.ok ? 0 : failures + 1;
      } catch {
        failures += 1;
      }
      return { ok: failures === 0, failures };
    },
    reset() { failures = 0; },
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// One dsh process at a time by default: several parallel sprint stages must not
// spawn several full harnesses on the same machine.
function createSemaphore(limit = 1) {
  let active = 0;
  const waiters = [];
  return {
    get active() { return active; },
    async acquire(signal) {
      while (active >= limit) {
        if (signal?.aborted) throw Object.assign(new Error('run aborted'), { name: 'AbortError' });
        await new Promise((resolve, reject) => {
          const waiter = () => { cleanup(); resolve(); };
          const abort = () => { cleanup(); reject(Object.assign(new Error('run aborted'), { name: 'AbortError' })); };
          const cleanup = () => {
            const at = waiters.indexOf(waiter);
            if (at >= 0) waiters.splice(at, 1);
            signal?.removeEventListener?.('abort', abort);
          };
          waiters.push(waiter);
          signal?.addEventListener?.('abort', abort, { once: true });
        });
      }
      active += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        active -= 1;
        const next = waiters.shift();
        if (next) next();
      };
    },
  };
}

function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-pid, 'SIGTERM');
  } catch { /* already gone */ }
}

function localBin(name) {
  const candidates = process.platform === 'win32'
    ? [path.join(__dirname, 'node_modules', '.bin', `${name}.cmd`), path.join(__dirname, 'node_modules', '.bin', `${name}`)]
    : [path.join(__dirname, 'node_modules', '.bin', name)];
  return candidates.find(candidate => existsSync(candidate)) || '';
}

export function resolveDshCommand({ bin = process.env.DSH_BIN, allowNpx = String(process.env.DSH_NPX || '') === '1' } = {}) {
  if (bin) return { command: bin, prefix: [], via: 'DSH_BIN' };
  const local = localBin('dsh');
  if (local) return { command: local, prefix: [], via: 'node_modules' };
  // npm links .bin on completion; run the published bin directly if a partial or
  // pnpm-style install left the launcher unlinked.
  const packageBin = path.join(__dirname, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  if (existsSync(packageBin)) return { command: process.execPath, prefix: [packageBin], via: 'node_modules' };
  if (allowNpx) return { command: 'npx', prefix: ['--yes', '@deepseek-ai/dsh'], via: 'npx' };
  return { command: 'dsh', prefix: [], via: 'PATH' };
}

export function createDshRunner(options = {}) {
  const {
    command: explicitCommand = '',
    commandArgs = null,
    profile = process.env.DSH_PROFILE || 'headless',
    workdir = process.env.DSH_WORKDIR || __dirname,
    // dsh refuses DSH_HOME from a .env file (it is a launch-environment choice),
    // so the project keeps its harness home local and the runner exports it.
    home = process.env.DSH_HOME || path.join(__dirname, 'data', 'dsh-home'),
    permissionMode = process.env.DSH_PERMISSION_MODE || 'workspace-write',
    approvalPolicy = process.env.DSH_APPROVAL_POLICY || '',
    taskTimeoutMs = Number(process.env.DSH_STEP_TIMEOUT_MS || DEFAULT_STEP_TIMEOUT_MS),
    maxConcurrency = Number(process.env.DSH_MAX_CONCURRENCY || 1),
    guardIntervalMs = 15000,
    env = process.env,
    log = console,
    previewGuard = null,
    spawnImpl = spawn,
    healthImpl = null,
  } = options;

  const resolved = commandArgs
    ? { command: explicitCommand || process.execPath, prefix: [], via: 'custom' }
    : resolveDshCommand({ bin: explicitCommand || process.env.DSH_BIN });
  const slots = createSemaphore(Math.max(1, Math.min(Number(maxConcurrency) || 1, 4)));
  const webHost = String((options.env || process.env).DSH_HOST || '127.0.0.1');
  let availability = null;

  function baseArgs() {
    return [
      ...resolved.prefix,
      '--profile', profile,
      '--json',
      '--permission-mode', permissionMode,
      ...(approvalPolicy ? ['--approval-policy', approvalPolicy] : []),
      // The web profile is the only one that listens. Pin it to loopback; the
      // preview belongs to Computera, not to a second exposed surface.
      ...(profile === 'web' ? ['--host', webHost] : []),
    ];
  }

  // A harness that binds a port must bind loopback only. Headless opens no port at
  // all; this guard exists for an operator who points DSH_PROFILE at the web app.
  function assertLoopbackOnly(extraArgs = []) {
    const all = [...baseArgs(), ...extraArgs];
    const hostAt = all.indexOf('--host');
    if (hostAt === -1) return null;
    const host = String(all[hostAt + 1] || '');
    if (LOOPBACK_HOSTS.has(host.toLowerCase())) return null;
    return `refusing to start dsh bound to ${host || '(empty)'}; the preview guardrail allows loopback only`;
  }

  function available() {
    if (availability !== null) return availability.ok;
    try {
      const probe = (healthImpl || spawnSync)(resolved.command, [...resolved.prefix, '--version'], {
        timeout: 20000,
        windowsHide: true,
        stdio: 'ignore',
        // A .cmd launcher needs cmd.exe even for the availability probe.
        shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(resolved.command),
      });
      availability = { ok: probe && probe.status === 0 };
      if (!availability.ok) availability.reason = `\`${resolved.command}\` is not runnable`;
    } catch (err) {
      availability = { ok: false, reason: err.message };
    }
    if (!availability.ok && log?.warn) {
      log.warn(`dsh runner unavailable: ${availability.reason}. Install @deepseek-ai/dsh or set DSH_BIN; sprints fall back to the fleet.`);
    }
    return availability.ok;
  }

  function describe() {
    return `dsh ${profile} · ${resolved.via}${workdir ? ' · ' + workdir : ''}`;
  }

  async function run({ prompt, onEvent, signal, step, sprint } = {}) {
    const emit = (event) => {
      try { onEvent?.(event); } catch { /* feed is best effort */ }
    };

    if (previewGuard) {
      const before = await previewGuard.check();
      if (!before.ok) {
        return {
          ok: false,
          engine: 'dsh',
          error: `preview guardrail: ${previewGuard.url} was unhealthy before the run`,
        };
      }
    }

    const guardrail = assertLoopbackOnly();
    if (guardrail) return { ok: false, engine: 'dsh', error: guardrail };

    let release;
    try {
      release = await slots.acquire(signal);
    } catch (err) {
      return { ok: false, engine: 'dsh', error: err.message };
    }

    const startedMs = Date.now();
    mkdirSync(workdir, { recursive: true });
    const args = [...(commandArgs || []), ...baseArgs(), '-'];
    const childEnv = { ...env };
    if (home) childEnv.DSH_HOME = home;

    emit({ kind: 'runner', message: describe(), detail: `step ${step?.stage || '?'} · role ${step?.role || '?'}` });

    return await new Promise((resolve) => {
      let text = '';
      let finalText = null;
      let sessionId = null;
      let finalReason = null;
      let stderr = '';
      let lastError = '';
      let buffer = '';
      let settled = false;
      let abortedBy = '';

      let child;
      try {
        child = spawnImpl(resolved.command, args, {
          cwd: workdir,
          env: childEnv,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(resolved.command),
        });
      } catch (err) {
        release();
        return resolve({ ok: false, engine: 'dsh', error: `could not start dsh: ${err.message}` });
      }

      const finish = (outcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(guardTimer);
        release();
        resolve({
          ...outcome,
          engine: 'dsh',
          sessionId,
          exitCode: child.exitCode,
          ms: Date.now() - startedMs,
        });
      };

      const stop = (why) => {
        if (settled) return;
        abortedBy = why;
        emit({ kind: 'error', message: `stopping dsh: ${why}` });
        killTree(child.pid);
      };

      const timer = setTimeout(() => stop(`step exceeded ${Math.round(taskTimeoutMs / 60000)} min`), Math.max(1000, taskTimeoutMs));

      const guardTimer = previewGuard
        ? setInterval(async () => {
            if (settled) return;
            const check = await previewGuard.check();
            if (check.failures >= (previewGuard.failuresToAbort || 3)) {
              stop(`preview guardrail tripped (${check.failures} failed health checks)`);
            }
          }, guardIntervalMs)
        : null;
      guardTimer?.unref?.();

      const onAbort = () => stop('operator paused or stopped the sprint');
      signal?.addEventListener?.('abort', onAbort, { once: true });

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let record;
          try { record = JSON.parse(trimmed); } catch {
            emit({ kind: 'system', message: firstLine(trimmed, 300), detail: trimmed });
            continue;
          }
          if (record.type === 'session' && (record.sessionId || record.session_id)) {
            sessionId = String(record.sessionId || record.session_id);
          }
          if (record.type === 'final') {
            finalText = String(record.text ?? '');
            finalReason = record.reason && typeof record.reason === 'object'
              ? record.reason.kind || null
              : (record.reason || null);
            if (record.reason && record.reason.error && record.reason.error.message) {
              lastError = String(record.reason.error.message);
            }
          }
          if (record.type === 'error' && (record.message || record.error)) {
            lastError = String(record.message || record.error);
          }
          if (record.type === 'text' && record.text) {
            // Committed assistant messages, not token deltas: replace on overlap
            // instead of duplicating a re-committed message.
            const next = String(record.text);
            text = text && next.startsWith(text) ? next : (text ? `${text}\n${next}` : next);
          }
          const event = normalizeDshEvent(record);
          if (event && (event.message || event.detail)) emit(event);
        }
      });

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
        if (stderr.length > 20000) stderr = stderr.slice(-20000);
      });

      child.on('error', (err) => {
        finish({ ok: false, error: `dsh process error: ${err.message}` });
      });

      child.on('close', (code) => {
        signal?.removeEventListener?.('abort', onAbort);
        if (buffer.trim()) {
          const event = normalizeDshEvent({ type: 'system', message: buffer.trim() });
          emit(event);
        }
        const answer = (finalText ?? text).trim();
        const completed = code === 0 && (!finalReason || finalReason === 'completed');
        if (completed) {
          finish({ ok: true, text: answer, reason: finalReason });
          return;
        }
        const detail = abortedBy
          || lastError
          || (stderr.trim().split('\n').filter(Boolean).slice(-3).join(' · '))
          || (finalReason ? `turn ended: ${finalReason}` : `dsh exited ${code}`);
        finish({ ok: false, text: answer, error: detail });
      });

      // The task goes in on stdin, so long sprint prompts never hit the Windows
      // command-line length limit.
      try {
        child.stdin.write(String(prompt || ''));
        child.stdin.end();
      } catch { /* the child may already be gone */ }
    });
  }

  return {
    name: 'dsh',
    kind: 'harness',
    loopbackOnly: true,
    available,
    describe,
    run,
    command: resolved.command,
    profile,
    workdir,
  };
}

// Plain chat against Ollama's native API: no tool schemas, so a small local model
// answers with prose instead of imitating tool-call JSON. This is the local
// fallback for sprints when the harness has no capable model behind it.
export function createOllamaRunner(options = {}) {
  const {
    url = 'http://127.0.0.1:11434',
    model = '',
    timeoutMs = 20 * 60 * 1000,
    requestOptions = {},
    fetchImpl = (...args) => fetch(...args),
  } = options;

  return {
    name: 'ollama',
    kind: 'engine',
    available: () => true,
    describe: () => `ollama · ${model || 'first installed model'}`,
    async run({ prompt, onEvent, signal } = {}) {
      let chosen = model;
      if (!chosen) {
        try {
          const tagsRes = await fetchImpl(`${url}/api/tags`);
          const tags = await tagsRes.json();
          chosen = (tags.models || [])[0]?.name || '';
        } catch { /* reported below */ }
      }
      if (!chosen) return { ok: false, engine: 'ollama', error: 'no Ollama model installed' };

      onEvent?.({ kind: 'runner', message: `ollama · ${chosen}` });
      let res;
      try {
        res = await fetchImpl(`${url}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: chosen,
            messages: [{ role: 'user', content: String(prompt || '') }],
            stream: true,
            ...(requestOptions && Object.keys(requestOptions).length ? { options: requestOptions } : {}),
          }),
          signal: signal || AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        return { ok: false, engine: 'ollama', error: `ollama unreachable: ${err.message}` };
      }
      if (!res.ok) return { ok: false, engine: 'ollama', error: `Ollama error (${res.status})` };

      let text = '';
      const decoder = new TextDecoder();
      let buffer = '';
      const reader = res.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            let chunk;
            try { chunk = JSON.parse(trimmed); } catch { continue; }
            const piece = chunk.message?.content || '';
            if (piece) {
              text += piece;
              onEvent?.({ kind: 'agent', message: piece.slice(-180), detail: text.slice(-12000) });
            }
            if (chunk.error) return { ok: false, engine: 'ollama', error: String(chunk.error) };
          }
        }
      } catch (err) {
        return { ok: false, engine: 'ollama', error: err.message };
      } finally {
        try { reader.releaseLock(); } catch { /* stream already closed */ }
      }

      if (!text.trim()) return { ok: false, engine: 'ollama', error: 'ollama returned an empty answer' };
      return { ok: true, engine: 'ollama', text };
    },
  };
}

export function createFleetRunner({ dispatch, name = 'fleet' } = {}) {
  return {
    name,
    kind: 'fleet',
    available: () => typeof dispatch === 'function',
    describe: () => 'capability-aware fleet dispatch',
    async run({ step, onEvent } = {}) {
      if (!step?.task_id) return { ok: false, engine: name, error: 'fleet runner needs a step with a task_id' };
      onEvent?.({ kind: 'status', message: `dispatching to the fleet as ${step.role || 'worker'}` });
      const outcome = await dispatch(step.task_id);
      if (outcome && outcome.ok) return { ok: true, engine: name, text: outcome.text || '' };
      return { ok: false, engine: name, error: (outcome && outcome.error) || 'dispatch failed' };
    },
  };
}

export function createRunnerRegistry({ log = console } = {}) {
  const runners = new Map();
  return {
    register(runner) {
      if (!runner || !runner.name || typeof runner.run !== 'function') {
        throw new Error('a runner needs a name and a run() function');
      }
      runners.set(runner.name, runner);
      return runner;
    },
    get(name) { return runners.get(String(name)) || null; },
    names() { return [...runners.keys()]; },
    describe() {
      return [...runners.values()].map(runner => {
        let available = true;
        try { available = typeof runner.available === 'function' ? !!runner.available() : true; } catch { available = false; }
        return {
          name: runner.name,
          kind: runner.kind || 'engine',
          available,
          detail: typeof runner.describe === 'function' ? runner.describe() : '',
        };
      });
    },
    // Resolve by preference, then by order, and never fail silently: the last
    // entry in the order is the one that has to accept the step.
    resolve(preferred = 'auto', order = ['dsh', 'fleet']) {
      const wanted = String(preferred || 'auto').toLowerCase();
      if (wanted !== 'auto') {
        const runner = runners.get(wanted);
        if (runner && (typeof runner.available !== 'function' || runner.available())) return runner;
        return runners.get(order[order.length - 1]) || null;
      }
      for (const name of order) {
        const runner = runners.get(name);
        if (runner && (typeof runner.available !== 'function' || runner.available())) return runner;
      }
      log?.warn?.(`No preferred runner available (${order.join(', ')}); using ${order[order.length - 1]}`);
      return runners.get(order[order.length - 1]) || null;
    },
  };
}

export { DEFAULT_STEP_TIMEOUT_MS, sleep };
