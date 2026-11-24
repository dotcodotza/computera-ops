import test from 'node:test';
import assert from 'node:assert/strict';
import { todayKey, createFleet } from '../fleet.js';

test('todayKey returns YYYY-MM-DD', () => {
  const d = new Date(2026, 10, 20);
  assert.strictEqual(todayKey(d), '2026-11-20');
  const now = todayKey();
  assert.match(now, /^\d{4}-\d{2}-\d{2}$/);
});

test('createFleet with in-memory store', () => {
  const workers = {};
  const rotations = {};
  const events = [];

  const store = {
    upsertWorker(input) {
      workers[input.id] = { ...input, last_seen: new Date().toISOString(), updated_at: new Date().toISOString() };
      return { ...workers[input.id] };
    },
    getWorker(id) { return workers[id] || null; },
    touchWorker(id, patch) {
      if (!workers[id]) return null;
      if (patch.capabilities) workers[id].capabilities = patch.capabilities;
      workers[id].last_seen = new Date().toISOString();
      return { ...workers[id] };
    },
    deleteWorker(id) {
      const had = workers[id] !== undefined;
      delete workers[id];
      return had;
    },
    listWorkers() { return Object.values(workers); },
    countActiveByWorker() { return {}; },
    recordEvent(kind, detail, workerId) { events.push({ kind, detail, workerId }); },
    listEvents() { return events; },
    getRotation(date) { return rotations[date] || null; },
    saveRotation({ date, worker_id, host_url, link_token }) {
      rotations[date] = { date, worker_id, host_url, link_token, assigned_at: new Date().toISOString() };
      return rotations[date];
    },
  };

  const fleet = createFleet({
    store,
    token: 'secret',
    hostUrl: 'http://localhost:3000',
    selfId: 'master',
    selfName: 'masternode',
    log: console,
  });

  // registerSelf + roster
  fleet.setCapabilities({ kilo: true, ollama: false, models: [] });
  const self = fleet.registerSelf();
  assert.strictEqual(self.id, 'master');
  assert.strictEqual(self.name, 'masternode');
  assert.deepStrictEqual(self.capabilities, { kilo: true, ollama: false, models: [] });

  const roster = fleet.roster();
  assert.ok(roster.some(w => w.id === 'master'));

  // join a worker
  const w = fleet.join({ id: 'worker-a', name: 'Worker A', base_url: 'http://localhost:3001', capabilities: { kilo: false, ollama: true }, max_concurrency: 1 });
  assert.strictEqual(w.id, 'worker-a');
  assert.strictEqual(events.filter(e => e.kind === 'join').length, 1);

  // heartbeat
  const hb = fleet.heartbeat({ id: 'worker-a', base_url: 'http://localhost:3001', capabilities: { kilo: false, ollama: true } });
  assert.strictEqual(hb.ok, true);
  assert.ok(hb.today.date);

  // today
  const tod = fleet.today();
  assert.strictEqual(tod.date, todayKey());
  assert.ok(tod.link_token);

  // rotateNow forces a new host
  const rotated = fleet.rotateNow();
  assert.strictEqual(rotated.date, todayKey());

  // capable helper via roster
  const roster2 = fleet.roster();
  const wa = roster2.find(x => x.id === 'worker-a');
  assert.ok(wa.capabilities.ollama);
  assert.strictEqual(wa.capabilities.kilo, false);

  // removeWorker
  const removed = fleet.removeWorker('worker-a');
  assert.strictEqual(removed, true);
  assert.strictEqual(store.getWorker('worker-a'), null);
  assert.ok(events.some(e => e.kind === 'leave'));
});

test('today follows this node\'s current public url without rotating the token', () => {
  const rotations = {
    [todayKey()]: {
      date: todayKey(),
      worker_id: 'master',
      host_url: 'http://localhost:3000',
      link_token: 'tok-123',
      assigned_at: new Date().toISOString(),
    },
  };
  const store = {
    upsertWorker(input) { return { ...input, status: 'online', created_at: new Date().toISOString() }; },
    touchWorker() { return null; },
    listWorkers() {
      return [{ id: 'master', name: 'masternode', base_url: 'https://new-tunnel.example', status: 'online', capabilities: {}, created_at: new Date().toISOString() }];
    },
    recordEvent() {},
    getRotation(date) { return rotations[date] || null; },
    saveRotation({ date, worker_id, host_url, link_token }) {
      rotations[date] = { date, worker_id, host_url, link_token, assigned_at: new Date().toISOString() };
      return rotations[date];
    },
  };

  const fleet = createFleet({ store, selfId: 'master', selfName: 'masternode', hostUrl: 'https://new-tunnel.example' });
  const today = fleet.today();
  assert.ok(today.link.startsWith('https://new-tunnel.example/dashboard'), 'the link lands on the ops dashboard');
  assert.ok(today.link.endsWith('?t=' + today.link_token), 'the link carries today\'s token or it would 401');
  assert.equal(today.link_token, 'tok-123', 'the daily token must not rotate just because the url changed');
});

test('createFleet getCapabilities returns defaults', () => {
  const fleet = createFleet({
    store: {
      upsertWorker() { return {}; },
      touchWorker() { return null; },
      listWorkers() { return []; },
    },
  });
  assert.deepStrictEqual(fleet.getCapabilities(), { kilo: false, ollama: false, models: [] });
});
