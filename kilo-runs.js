/* Kilo run registry.
 *
 * A long-running Kilo task belongs to the server, not to the browser tab or to
 * the HTTP request that started it. Each run is a small record that is polled
 * from Kilo (authoritative) and written to data/kilo-runs/<id>.json, so:
 *   - closing/reloading the page only detaches a viewer, it does not stop the run
 *   - a missed SSE delta cannot lose output (we read Kilo's message state)
 *   - "done" comes from Kilo itself (message time.completed, or session.idle),
 *     never from text going quiet for a moment during a long tool step
 *   - after a server restart, runs still marked "running" are re-attached and
 *     finish from Kilo's own session state
 */
import path from 'path';
import fs from 'fs-extra';
import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';

const DEFAULTS = {
  pollActiveMs: 900,        // text is still growing
  pollIdleMs: 2500,         // Kilo is silent (a long tool step)
  maxDurationMs: 6 * 60 * 60 * 1000,
  offlineGraceMs: 15 * 60 * 1000,
  persistEveryMs: 2000,
  keepRuns: 60,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function modelRef(model) {
  if (!model || typeof model !== 'string') return undefined;
  const modelID = model.startsWith('kilo/') ? model.slice(5) : model;
  return modelID ? { providerID: 'kilo', modelID } : undefined;
}

function errorText(err) {
  if (!err) return 'Kilo reported an error';
  if (typeof err === 'string') return err;
  return err.message || err.data?.message || err.name || 'Kilo reported an error';
}

function isComplete(info) {
  if (!info) return false;
  if (info.time && info.time.completed) return true;
  if (info.finish === 'stop' || info.finish === 'end') return true;
  return info.status === 'completed';
}

/** The newest assistant message that this run produced (not one from before it). */
function latestAssistant(messages, run) {
  if (!Array.isArray(messages) || !messages.length) return null;
  const known = new Set(run.knownIds || []);
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] || {};
    const info = m.info || m;
    if ((info.role || m.role) !== 'assistant') continue;
    if (info.id && known.has(info.id)) continue;
    const parts = m.parts || m.content || [];
    const text = Array.isArray(parts)
      ? parts.filter((p) => p && p.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('')
      : '';
    return { text, info };
  }
  return null;
}

export function createKiloRuns({ kiloUrl, directory, runDir, ...overrides }) {
  const cfg = { ...DEFAULTS, ...overrides };
  const log = cfg.log || console;
  const runs = new Map();
  const bus = new EventEmitter();
  bus.setMaxListeners(0);

  const headers = { 'Content-Type': 'application/json', 'x-kilo-directory': directory };
  const dirQuery = `directory=${encodeURIComponent(directory)}`;
  const now = () => Date.now();

  const messagesUrl = (sessionId) =>
    `${kiloUrl}/session/${encodeURIComponent(sessionId)}/message?${dirQuery}`;
  const sessionUrl = (sessionId, sub = '') =>
    `${kiloUrl}/session/${encodeURIComponent(sessionId)}${sub}?${dirQuery}`;

  // ---------- shape / persistence ----------
  function view(run) {
    return {
      id: run.id,
      sessionId: run.sessionId,
      status: run.status,
      agent: run.agent,
      model: run.model,
      text: run.text,
      fullLength: run.text.length,
      modelID: run.modelID || null,
      providerID: run.providerID || null,
      error: run.error || null,
      startedAt: run.startedAt,
      updatedAt: run.updatedAt,
      lastTextAt: run.lastTextAt || 0,
      waiting: !!run.waiting,
      elapsedMs: now() - (run.startedMs || now()),
      done: run.status !== 'running',
    };
  }

  /** Incremental read: text after `offset` characters. */
  function snapshot(run, offset = 0) {
    const from = Math.max(0, Math.min(Number(offset) || 0, run.text.length));
    return { ...view(run), text: run.text.slice(from), offset: run.text.length };
  }

  function publicRecord(run) {
    const { _worker, _persistedAt, _lastLen, ...rest } = run;
    return { ...rest, knownIds: (rest.knownIds || []).slice(-200) };
  }

  async function persist(run, force) {
    const t = now();
    if (!force && run._persistedAt && t - run._persistedAt < cfg.persistEveryMs) return;
    run._persistedAt = t;
    try {
      await fs.ensureDir(runDir);
      const file = path.join(runDir, run.id + '.json');
      const tmp = file + '.tmp';
      await fs.writeFile(tmp, JSON.stringify(publicRecord(run)));
      await fs.move(tmp, file, { overwrite: true });
    } catch (err) {
      log.warn?.(`Kilo run ${run.id}: could not persist (${err.message})`);
    }
  }

  function emit(run) {
    bus.emit('update', run);
  }

  function finish(run, status, error) {
    if (run.status !== 'running') {
      if (error && !run.error) run.error = error;
      return run;
    }
    run.status = status;
    run.error = error || null;
    run.waiting = false;
    run.updatedAt = new Date().toISOString();
    run.completedAt = run.updatedAt;
    emit(run);
    persist(run, true).catch(() => {});
    return run;
  }

  // ---------- Kilo event pump (idle/error hints only; polling stays authoritative) ----------
  let pumpRunning = false;

  async function startEventPump() {
    if (pumpRunning) return;
    pumpRunning = true;
    (async () => {
      let backoff = 1000;
      while (pumpRunning) {
        const ctrl = new AbortController();
        try {
          const res = await fetch(`${kiloUrl}/event?${dirQuery}`, {
            headers: { Accept: 'text/event-stream' },
            signal: ctrl.signal,
          });
          if (!res.ok || !res.body) throw new Error(`Kilo event stream ${res.status}`);
          backoff = 1000;
          const decoder = new TextDecoder();
          let buffer = '';
          for await (const chunk of res.body) {
            if (!pumpRunning) { ctrl.abort(); break; }
            buffer += decoder.decode(chunk, { stream: true });
            const frames = buffer.split('\n\n');
            buffer = frames.pop();
            for (const frame of frames) {
              for (const line of frame.split('\n')) {
                if (!line.startsWith('data:')) continue;
                let evt;
                try { evt = JSON.parse(line.slice(5).trim()); } catch { continue; }
                const sid = evt?.properties?.sessionID;
                if (!sid) continue;
                for (const run of runs.values()) {
                  if (run.sessionId !== sid || run.status !== 'running') continue;
                  if (evt.type === 'session.idle') run.idleAt = now();
                  if (evt.type === 'session.error') run.errorSignal = errorText(evt.properties?.error);
                }
              }
            }
          }
        } catch {
          if (!pumpRunning) break;
        }
        if (!pumpRunning) break;
        await sleep(backoff);
        backoff = Math.min(30000, backoff * 2);
      }
    })().catch(() => { pumpRunning = false; });
  }

  // ---------- the worker ----------
  function attach(run) {
    if (run._worker) return run._worker;
    run._worker = (async () => {
      let failures = 0;
      let offlineSince = 0;
      while (run.status === 'running') {
        if (now() - (run.startedMs || now()) > cfg.maxDurationMs) {
          finish(run, 'error', `Run exceeded the ${Math.round(cfg.maxDurationMs / 60000)} min limit`);
          break;
        }
        let keepGoing = true;
        try {
          const res = await fetch(messagesUrl(run.sessionId), {
            headers: { 'x-kilo-directory': directory, Accept: 'application/json' },
            signal: AbortSignal.timeout(15000),
          });
          if (!res.ok) throw new Error(`Kilo responded ${res.status}`);
          const messages = await res.json();
          failures = 0;
          offlineSince = 0;
          if (run.waiting) { run.waiting = false; emit(run); }

          const latest = latestAssistant(messages, run);
          if (latest) {
            const text = latest.text || '';
            const grew = text.length > (run._lastLen || 0);
            if (text !== run.text) {
              run.text = text;
              run.lastTextAt = now();
              run.updatedAt = new Date().toISOString();
              emit(run);
            }
            run._lastLen = text.length;
            run.growing = grew;
            if (latest.info.modelID) run.modelID = latest.info.modelID;
            if (latest.info.providerID) run.providerID = latest.info.providerID;

            if (latest.info.error) {
              finish(run, 'error', errorText(latest.info.error));
              keepGoing = false;
            } else if (isComplete(latest.info)) {
              finish(run, 'done', null);
              keepGoing = false;
            } else if (run.errorSignal) {
              finish(run, 'error', run.errorSignal);
              keepGoing = false;
            } else if (run.idleAt && run.idleAt >= (run.lastTextAt || 0) && now() - run.idleAt > 1500) {
              // Kilo said idle after our text landed but did not stamp time.completed.
              finish(run, 'done', null);
              keepGoing = false;
            }
          }
        } catch (err) {
          failures++;
          if (!offlineSince) offlineSince = now();
          run.waiting = true;
          run.updatedAt = new Date().toISOString();
          emit(run);
          if (now() - offlineSince > cfg.offlineGraceMs) {
            finish(run, 'error', `Kilo unreachable for ${Math.round(cfg.offlineGraceMs / 60000)} min: ${err.message}`);
            break;
          }
          await persist(run, false);
          await sleep(Math.min(15000, 750 * failures));
          continue;
        }

        await persist(run, false);
        if (!keepGoing) break;
        if (run._stopRequested) break;
        // Poll briskly until the answer starts, then adapt: fast while text is
        // growing, slow while Kilo sits in a long tool step.
        const delay = !run.lastTextAt
          ? Math.min(500, cfg.pollActiveMs)
          : (run.growing ? cfg.pollActiveMs : cfg.pollIdleMs);
        await sleep(delay);
      }
      run._worker = null;
      await persist(run, true);
      emit(run);
      return run;
    })().catch((err) => {
      log.error?.(`Kilo run ${run.id} worker failed: ${err?.message || err}`);
      finish(run, 'error', err?.message || 'Kilo run worker failed');
      run._worker = null;
    });
    return run._worker;
  }

  // ---------- public API ----------
  async function start({ sessionId, prompt, model, agent }) {
    if (!sessionId) throw new Error('sessionId required');
    if (!prompt || typeof prompt !== 'string') throw new Error('prompt required');

    const existing = activeRun(sessionId);
    if (existing) return { run: existing, reused: true };

    const run = {
      id: 'run_' + randomUUID(),
      sessionId,
      prompt,
      agent: agent || 'master',
      model: model || null,
      status: 'running',
      text: '',
      modelID: null,
      providerID: null,
      error: null,
      startedAt: new Date().toISOString(),
      startedMs: now(),
      updatedAt: new Date().toISOString(),
      lastTextAt: 0,
      waiting: false,
      knownIds: [],
    };
    runs.set(run.id, run);
    await startEventPump();

    // Remember what is already in the session: an earlier answer must never be
    // mistaken for this run's output.
    try {
      const res = await fetch(messagesUrl(sessionId), {
        headers: { 'x-kilo-directory': directory },
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        const messages = await res.json();
        if (Array.isArray(messages)) {
          run.knownIds = messages.map((m) => (m.info || m)?.id).filter(Boolean).slice(-200);
        }
      }
    } catch { /* Kilo may be waking up; the run still starts */ }

    await persist(run, true);

    try {
      const resp = await fetch(sessionUrl(sessionId, '/prompt_async'), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          parts: [{ type: 'text', text: prompt }],
          model: modelRef(model),
          agent: agent || 'master',
        }),
        signal: AbortSignal.timeout(20000),
      });
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        throw new Error(`Kilo error (${resp.status}): ${errText.slice(0, 300)}`);
      }
    } catch (err) {
      const message = /^Kilo error/.test(err.message || '')
        ? err.message
        : `Kilo unreachable: ${err.message}`;
      finish(run, 'error', message);
      throw new Error(message);
    }

    attach(run);
    return { run, reused: false };
  }

  function get(id) {
    return runs.get(id) || null;
  }

  function activeRun(sessionId) {
    for (const run of runs.values()) {
      if (run.sessionId === sessionId && run.status === 'running') return run;
    }
    return null;
  }

  function stop(id) {
    const run = runs.get(id);
    if (!run) return null;
    if (run.status === 'running') {
      run._stopRequested = true;
      finish(run, 'stopped', null);
      fetch(`${kiloUrl}/session/${encodeURIComponent(run.sessionId)}/abort`, {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(5000),
      }).catch(() => {});
    }
    return run;
  }

  async function waitFor(id, timeoutMs = 30 * 60 * 1000) {
    const run = runs.get(id);
    if (!run) throw new Error('run not found');
    const started = now();
    while (run.status === 'running') {
      if (now() - started > timeoutMs) throw new Error('Kilo run timed out');
      await sleep(500);
    }
    if (run.status === 'error') throw new Error(run.error || 'Kilo run failed');
    if (run.status === 'stopped') throw new Error('Kilo run stopped');
    return run;
  }

  /** Re-attach runs a previous process left running (crash/restart recovery). */
  async function restore() {
    let files = [];
    try {
      await fs.ensureDir(runDir);
      files = await fs.readdir(runDir);
    } catch {
      return 0;
    }
    const jsonFiles = files.filter((f) => f.endsWith('.json'));
    let reattached = 0;
    for (const file of jsonFiles) {
      const full = path.join(runDir, file);
      try {
      const run = await fs.readJson(full);
      if (!run?.id || run.status !== 'running') continue;
      if (now() - (run.startedMs || 0) > cfg.maxDurationMs) {
        run.status = 'error';
        run.error = 'Interrupted: older than the run limit';
        run.completedAt = new Date().toISOString();
        await fs.writeFile(full, JSON.stringify(publicRecord(run)));
        continue;
      }
      // Verify the Kilo session still exists; otherwise mark failed.
      try {
        const sres = await fetch(sessionUrl(run.sessionId), { headers: { 'x-kilo-directory': directory }, signal: AbortSignal.timeout(5000) });
        if (sres.status === 404) {
          run.status = 'error';
          run.error = 'Kilo session no longer exists';
          run.completedAt = new Date().toISOString();
          await fs.writeFile(full, JSON.stringify(publicRecord(run)));
          continue;
        }
      } catch { /* Kilo may be waking; proceed to re-attach */ }
      run.growing = false;
        run.waiting = false;
        runs.set(run.id, run);
        await startEventPump();
        attach(run);
        reattached++;
      } catch { /* skip unreadable run files */ }
    }
    await prune();
    return reattached;
  }

  async function prune() {
    try {
      const files = (await fs.readdir(runDir)).filter((f) => f.endsWith('.json'));
      if (files.length <= cfg.keepRuns) return;
      const stats = await Promise.all(files.map(async (f) => ({
        f,
        m: (await fs.stat(path.join(runDir, f))).mtimeMs,
      })));
      stats.sort((a, b) => b.m - a.m);
      for (const entry of stats.slice(cfg.keepRuns)) {
        await fs.remove(path.join(runDir, entry.f)).catch(() => {});
      }
    } catch { /* pruning is best effort */ }
  }

  /** Progress notifications for streaming views. Returns an unsubscribe function. */
  function subscribe(fn) {
    bus.on('update', fn);
    return () => bus.off('update', fn);
  }

  function close() {
    pumpRunning = false;
    for (const run of runs.values()) {
      if (run.status === 'running') {
        // Leave them marked running on disk so the next boot re-attaches them.
        persist(run, true).catch(() => {});
      }
    }
  }

  function activeRuns() {
    return [...runs.values()].filter((r) => r.status === 'running').map(view);
  }

  return { start, get, snapshot, view, activeRun, activeRuns, stop, waitFor, restore, subscribe, close };
}

export default { createKiloRuns };
