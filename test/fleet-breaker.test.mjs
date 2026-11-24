/* Dispatch circuit breaker: a repeatedly failing worker is taken out of rotation
 * for a cooldown instead of being retried on every dispatch, and it comes back
 * once the cooldown expires. Run with: node --test test/fleet-breaker.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFleet } from '../fleet.js';

function makeStore(task) {
  const workers = {};
  const events = [];
  return {
    workers,
    events,
    upsertWorker(input) {
      workers[input.id] = { ...input, status: 'online', last_seen: new Date().toISOString(), created_at: input.created_at || new Date().toISOString() };
      return { ...workers[input.id] };
    },
    getWorker(id) { return workers[id] || null; },
    touchWorker(id) {
      if (workers[id]) workers[id].last_seen = new Date().toISOString();
      return workers[id] || null;
    },
    deleteWorker(id) { const had = !!workers[id]; delete workers[id]; return had; },
    listWorkers() { return Object.values(workers); },
    countActiveByWorker() { return {}; },
    recordEvent(kind, detail, workerId) { events.push({ kind, detail, workerId }); },
    listEvents() { return events; },
    getRotation() { return null; },
    saveRotation({ date, worker_id, host_url, link_token }) {
      return { date, worker_id, host_url, link_token };
    },
    getTask() { return { ...task }; },
    updateTask(id, patch) { Object.assign(task, patch); return { ...task }; },
  };
}

test('a failing worker opens its circuit and is skipped until the cooldown ends', async () => {
  const task = { id: 'task-1', title: 'Ops', needs: 'ollama', status: 'todo', attempts: 0 };
  const store = makeStore(task);
  let clock = 1_000_000;
  let calls = 0;

  const fleet = createFleet({
    store,
    selfId: 'master',
    selfName: 'master',
    token: 'secret',
    breakerThreshold: 1,
    breakerCooldownMs: 5_000,
    now: () => clock,
    runLocalTask: undefined,
  });
  fleet.setCapabilities({ kilo: false, ollama: false, models: [] });
  fleet.join({ id: 'w1', name: 'Worker 1', base_url: 'http://w1.invalid', capabilities: { ollama: true, models: ['m'] } });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { calls += 1; throw new Error('connection refused'); };
  try {
    const first = await fleet.dispatch(task.id);
    assert.equal(first.ok, false);
    assert.equal(calls, 1, 'the first dispatch should try the worker');
    assert.equal(fleet.health().w1.open, true, 'the circuit should be open after the failure');
    assert.ok(store.events.some(e => e.kind === 'circuit_open'));

    const second = await fleet.dispatch(task.id);
    assert.equal(second.ok, false);
    assert.equal(calls, 1, 'an open circuit must not be retried');
    assert.match(second.blocked.blocked_reason, /cooling down/);
    assert.ok(store.events.some(e => e.kind === 'dispatch_skipped'));

    // Cooldown expires: the worker is healthy to try again.
    clock += 6_000;
    assert.equal(fleet.health().w1.open, false);
    await fleet.dispatch(task.id);
    assert.equal(calls, 2, 'after the cooldown the worker gets another chance');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a successful dispatch resets the breaker', async () => {
  const task = { id: 'task-2', title: 'Ops', needs: 'kilo', status: 'todo', attempts: 0 };
  const store = makeStore(task);
  const fleet = createFleet({
    store,
    selfId: 'master',
    selfName: 'master',
    token: 'secret',
    breakerThreshold: 1,
    breakerCooldownMs: 1_000,
    runLocalTask: undefined,
  });
  fleet.setCapabilities({ kilo: false, ollama: false, models: [] });
  fleet.join({ id: 'w2', name: 'Worker 2', base_url: 'http://w2.invalid', capabilities: { kilo: true } });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, engine: 'kilo', text: 'done' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
  try {
    const outcome = await fleet.dispatch(task.id);
    assert.equal(outcome.assigned_worker, 'w2');
    assert.equal(outcome.status, 'review');
    assert.equal(fleet.health().w2.failures, 0);
    assert.equal(fleet.health().w2.open, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
