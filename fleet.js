import { randomBytes } from 'crypto';

const DEFAULT_STALE_MS = 45000;
const WORKER_RUN_TIMEOUT_MS = 180000;

export function todayKey(date = new Date()) {
  return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
}

// Detects what this node can actually do. A node with neither engine is still usable
// as a calendar host / relay, it just never becomes a task target.
export async function probeCapabilities({ ollamaUrl, kiloUrl, timeoutMs = 3000 } = {}) {
  const capabilities = { kilo: false, ollama: false, models: [] };
  if (kiloUrl) {
    try {
      const res = await fetch(`${kiloUrl}/global/health`, { signal: AbortSignal.timeout(timeoutMs) });
      capabilities.kilo = res.ok;
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        if (data && data.healthy === false) capabilities.kilo = false;
      }
    } catch { capabilities.kilo = false; }
  }
  if (ollamaUrl) {
    try {
      const res = await fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        capabilities.ollama = true;
        capabilities.models = (data.models || []).map(m => m.name).filter(Boolean).slice(0, 20);
      }
    } catch { capabilities.ollama = false; }
  }
  return capabilities;
}

export function createFleet(options = {}) {
  const {
    store,
    token = '',
    hostUrl = '',
    selfId = 'master',
    selfName = 'masternode',
    runLocalTask,
    onLinkToken,
    staleMs = DEFAULT_STALE_MS,
    log = console,
  } = options;

  let selfCapabilities = { kilo: false, ollama: false, models: [] };

  function setCapabilities(capabilities) {
    selfCapabilities = capabilities || {};
  }

  function getCapabilities() {
    return selfCapabilities;
  }

  function registerSelf() {
    return store.upsertWorker({
      id: selfId,
      name: selfName,
      base_url: hostUrl,
      capabilities: selfCapabilities,
      max_concurrency: 1,
    });
  }

  function capable(worker, need) {
    const caps = (worker && worker.capabilities) || {};
    if (need === 'kilo') return !!caps.kilo;
    if (need === 'ollama') return !!caps.ollama;
    return !!(caps.kilo || caps.ollama);
  }

  function roster() {
    store.touchWorker(selfId, { capabilities: selfCapabilities });
    return store.listWorkers({ staleMs });
  }

  function registerWorker(payload = {}) {
    const worker = store.upsertWorker({
      id: payload.id,
      name: payload.name,
      base_url: payload.base_url,
      capabilities: payload.capabilities,
      max_concurrency: payload.max_concurrency,
    });
    return worker;
  }

  function join(payload = {}) {
    const id = String(payload.id || '').trim();
    if (!id) throw Object.assign(new Error('worker id required'), { status: 400 });
    const worker = registerWorker({ ...payload, id });
    store.recordEvent('join', `${worker.name} joined (${worker.base_url || 'no url'})`, worker.id);
    return worker;
  }

  function heartbeat(payload = {}) {
    const id = String(payload.id || '').trim();
    if (!id) throw Object.assign(new Error('worker id required'), { status: 400 });
    const worker = registerWorker({ ...payload, id });
    store.touchWorker(selfId, { capabilities: selfCapabilities });
    const entry = ensureRotation();
    const isHost = !!entry && entry.worker_id === id;
    return {
      ok: true,
      worker,
      server_time: new Date().toISOString(),
      today: {
        date: entry?.date || todayKey(),
        worker_id: entry?.worker_id || null,
        host_url: entry?.host_url || '',
        link_token: isHost ? entry.link_token : null,
        is_host: isHost,
      },
    };
  }

  function nextHost(workers, dateStr, excludeIds = []) {
    const online = workers.filter(w => w.status === 'online' && !excludeIds.includes(w.id));
    if (!online.length) return null;
    const ordered = [...online].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    const withPublicUrl = ordered.filter(w => (w.capabilities || {}).public_url);
    const pool = withPublicUrl.length ? withPublicUrl : ordered;
    const days = Math.floor(new Date(`${dateStr}T00:00:00`).getTime() / 86400000);
    return pool[((days % pool.length) + pool.length) % pool.length];
  }

  function ensureRotation({ force = false } = {}) {
    const date = todayKey();
    store.touchWorker(selfId, { capabilities: selfCapabilities });
    const workers = store.listWorkers({ staleMs });
    let entry = store.getRotation(date);
    const current = entry ? workers.find(w => w.id === entry.worker_id) : null;
    const hostOffline = !!entry && (!current || current.status !== 'online');
    let kind = null;

    if (!entry) kind = 'host_assign';
    else if (hostOffline) kind = 'failover';
    else if (force) kind = 'rotate';

    if (kind) {
      const exclude = force && entry ? [entry.worker_id] : (hostOffline ? [entry.worker_id] : []);
      const next = nextHost(workers, date, exclude);
      const hostUrlValue = next
        ? String((next.capabilities || {}).public_url || next.base_url || '')
        : hostUrl;
      entry = store.saveRotation({
        date,
        worker_id: next ? next.id : selfId,
        host_url: hostUrlValue,
        link_token: randomBytes(16).toString('hex'),
      });
      const label = next ? next.name : selfName;
      store.recordEvent(kind, `${kind.replace('_', ' ')}: ${label} (${hostUrlValue || 'no url'})`, next ? next.id : selfId);
    }

    if (onLinkToken) onLinkToken(entry && entry.worker_id === selfId ? entry.link_token : null);
    return entry;
  }

  function today() {
    const entry = ensureRotation();
    const workers = store.listWorkers({ staleMs });
    const worker = entry ? workers.find(w => w.id === entry.worker_id) : null;
    return {
      date: entry?.date || todayKey(),
      worker: worker ? { id: worker.id, name: worker.name, base_url: worker.base_url, status: worker.status } : null,
      host_url: entry?.host_url || '',
      link: entry?.host_url || '',
      link_token: entry?.link_token || null,
      is_self: !!entry && entry.worker_id === selfId,
    };
  }

  async function callWorker(worker, task) {
    const base = String(worker.base_url || '').replace(/\/$/, '');
    if (!base) return { ok: false, error: 'worker has no base_url' };
    try {
      const res = await fetch(`${base}/api/fleet/run/${encodeURIComponent(task.id)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Fleet-Token': token } : {}) },
        body: JSON.stringify({ task }),
        signal: AbortSignal.timeout(WORKER_RUN_TIMEOUT_MS),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) return { ok: true, engine: data.engine, text: data.text || '' };
      return { ok: false, error: data.error || `worker responded ${res.status}` };
    } catch (err) {
      return { ok: false, error: `unreachable: ${err.message}` };
    }
  }

  function finish(taskId, { workerId, engine, text }) {
    const updated = store.updateTask(taskId, {
      assigned_worker: workerId,
      status: 'review',
      blocked_reason: null,
      result: text,
      last_run_at: new Date().toISOString(),
    });
    store.recordEvent('dispatch_ok', `${taskId.slice(0, 8)} finished on ${workerId} via ${engine || 'engine'}`, workerId);
    return updated;
  }

  async function dispatch(taskId) {
    const task = store.getTask(taskId);
    if (!task) throw Object.assign(new Error('task not found'), { status: 404 });

    const need = task.needs || 'any';
    const load = store.countActiveByWorker();
    const candidates = roster()
      .filter(w => w.id !== selfId && capable(w, need))
      .sort((a, b) => (load[a.id] || 0) - (load[b.id] || 0) || String(a.id).localeCompare(String(b.id)));

    // Deterministic tie-break so identical loads do not always favour the same worker.
    const offset = candidates.length ? taskId.charCodeAt(0) % candidates.length : 0;
    const ordered = [...candidates.slice(offset), ...candidates.slice(0, offset)];

    store.updateTask(taskId, { needs: task.needs, blocked_reason: null });

    for (const worker of ordered.slice(0, Math.max(1, Math.min(2, ordered.length)))) {
      store.updateTask(taskId, { assigned_worker: worker.id, status: 'in_progress' });
      store.recordEvent('dispatch', `${taskId.slice(0, 8)} → ${worker.name}`, worker.id);
      const result = await callWorker(worker, task);
      if (result.ok) return finish(taskId, { workerId: worker.id, engine: result.engine, text: result.text });
      store.updateTask(taskId, { attempts: (store.getTask(taskId)?.attempts || 0) + 1 });
      store.recordEvent('dispatch_failed', `${worker.name}: ${result.error}`, worker.id);
    }

    // Master fallback: the workspace node is always the last resort provider.
    if (typeof runLocalTask === 'function' && capable({ capabilities: selfCapabilities }, need)) {
      store.updateTask(taskId, { assigned_worker: selfId, status: 'in_progress' });
      store.recordEvent('dispatch_local', `${taskId.slice(0, 8)} → ${selfName} (local fallback)`, selfId);
      const local = await runLocalTask(task);
      if (local && local.ok) return finish(taskId, { workerId: selfId, engine: local.engine, text: local.text });
      store.updateTask(taskId, { attempts: (store.getTask(taskId)?.attempts || 0) + 1 });
      store.recordEvent('dispatch_failed', `${selfName}: ${local?.error || 'local run failed'}`, selfId);
      const blocked = store.updateTask(taskId, {
        status: 'todo',
        blocked_reason: `local fallback failed: ${local?.error || 'unknown error'}`,
      });
      return { ok: false, blocked, error: local?.error || 'local run failed' };
    }

    const reason = need === 'any'
      ? 'no worker with kilo or ollama is online'
      : `no ${need}-capable worker is online`;
    const blocked = store.updateTask(taskId, { status: 'todo', blocked_reason: reason });
    store.recordEvent('blocked', `${taskId.slice(0, 8)} blocked: ${reason}`);
    return { ok: false, blocked, error: reason };
  }

  return {
    setCapabilities,
    getCapabilities,
    registerSelf,
    join,
    heartbeat,
    roster,
    removeWorker(id) {
      const worker = store.getWorker(id);
      const removed = store.deleteWorker(id);
      if (removed) store.recordEvent('leave', `${worker ? worker.name : id} removed`, id);
      ensureRotation();
      return removed;
    },
    today,
    rotateNow() {
      const entry = ensureRotation({ force: true });
      return {
        date: entry.date,
        worker_id: entry.worker_id,
        host_url: entry.host_url,
        link_token: entry.link_token,
      };
    },
    ensureRotation,
    dispatch,
    events(limit) {
      return store.listEvents(limit);
    },
    expireStale() {
      return ensureRotation();
    },
  };
}

// Worker-side loop: announce ourselves, then heartbeat on an interval and learn
// whether we are today's host (and therefore which link token to enforce).
export function startWorkerHeartbeat({ masterUrl, token = '', intervalMs = 15000, info, onToday, onError }) {
  if (!masterUrl) return { stop() {} };
  let timer = null;
  let stopped = false;

  async function beat() {
    if (stopped) return;
    try {
      const payload = typeof info === 'function' ? await info() : info;
      const res = await fetch(`${masterUrl}/api/fleet/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Fleet-Token': token } : {}) },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `master responded ${res.status}`);
      if (data.today && onToday) onToday(data.today);
    } catch (err) {
      if (onError) onError(err);
    } finally {
      if (!stopped) timer = setTimeout(beat, intervalMs);
    }
  }

  beat();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
