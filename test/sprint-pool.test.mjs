/* Sprint pooling: stages are routed to workers that serve their role tier, and
 * independent source tasks run at the same time. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFleet } from '../fleet.js';
import { createSprints, assignFleetRoles } from '../sprint.js';

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
    touchWorker(id) { return workers[id] || null; },
    deleteWorker(id) { const had = !!workers[id]; delete workers[id]; return had; },
    listWorkers() { return Object.values(workers); },
    countActiveByWorker() { return {}; },
    recordEvent(kind, detail, workerId) { events.push({ kind, detail, workerId }); },
    listEvents() { return events; },
    getRotation() { return null; },
    saveRotation() { return null; },
    getTask() { return { ...task }; },
    updateTask(id, patch) { Object.assign(task, patch); return { ...task }; },
  };
}

test('a sprint stage is routed to the worker that serves its role tier', async () => {
  const task = { id: 'stage-1', title: 'polish: Runbook', needs: 'any', agent: 'orchestrator', status: 'todo', attempts: 0 };
  const store = makeStore(task);
  const fleet = createFleet({
    store,
    selfId: 'master',
    selfName: 'master',
    token: 'secret',
    runLocalTask: undefined,
    // Same rule the server wires in: tiers are ranked fleet-wide, then each worker
    // serves the tier of the models it reports.
    roleForWorker: (worker) => {
      const fleetRoles = new Map(assignFleetRoles(['tiny:1b', 'huge:70b']).map(entry => [entry.model, entry.role]));
      const served = new Set(((worker.capabilities || {}).models || []).map(model => fleetRoles.get(model)).filter(Boolean));
      return ['orchestrator', 'worker', 'pace-maker'].find(role => served.has(role)) || null;
    },
  });
  fleet.setCapabilities({ kilo: false, ollama: false, models: [] });
  fleet.join({ id: 'w-small', name: 'Small', base_url: 'http://small.invalid', capabilities: { ollama: true, models: ['tiny:1b'] } });
  fleet.join({ id: 'w-big', name: 'Big', base_url: 'http://big.invalid', capabilities: { ollama: true, models: ['huge:70b'] } });

  const hits = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    hits.push(String(url));
    return new Response(JSON.stringify({ ok: true, engine: 'ollama', text: 'polished' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    const outcome = await fleet.dispatch(task.id);
    assert.equal(outcome.assigned_worker, 'w-big', 'the orchestrator tier worker takes the review stage');
    assert.ok(hits[0].includes('big.invalid') || hits[0].includes('big'), 'only the matching worker was called');
    assert.ok(store.events.some(e => e.kind === 'dispatch_pool' && /orchestrator/.test(e.detail)));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a fallback keeps every capable worker when no worker serves the role', async () => {
  const task = { id: 'stage-2', title: 'draft: FAQ', needs: 'any', agent: 'orchestrator', status: 'todo', attempts: 0 };
  const store = makeStore(task);
  const fleet = createFleet({
    store,
    selfId: 'master',
    runLocalTask: undefined,
    roleForWorker: () => 'worker',
  });
  fleet.setCapabilities({ kilo: false, ollama: false, models: [] });
  fleet.join({ id: 'w-only', name: 'Only', base_url: 'http://only.invalid', capabilities: { ollama: true, models: ['mid:8b'] } });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, engine: 'ollama', text: 'draft' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
  try {
    const outcome = await fleet.dispatch(task.id);
    assert.equal(outcome.assigned_worker, 'w-only', 'a tier gap must not block the sprint');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function sprintStore() {
  const tasks = new Map();
  const sprints = new Map();
  const steps = [];
  const feed = [];
  let seq = 0;
  return {
    tasks,
    createTask(input = {}) {
      const task = { id: 't' + (++seq), result: null, ...input };
      tasks.set(task.id, task);
      return task;
    },
    getTask(id) { return tasks.get(id) || null; },
    updateTask(id, patch) { const t = tasks.get(id); if (t) Object.assign(t, patch); return t || null; },
    createSprint(input = {}) {
      const sprint = { id: 's' + (++seq), status: 'planning', checkpoint: {}, duration_ms: 0, ...input };
      sprints.set(sprint.id, sprint);
      return sprint;
    },
    getSprint(id) { return sprints.get(id) || null; },
    listSprints() { return [...sprints.values()]; },
    updateSprint(id, patch) { const s = sprints.get(id); if (s) Object.assign(s, patch); return s || null; },
    addSprintStep(sprintId, step = {}) {
      const row = { id: 'st' + (++seq), sprint_id: sprintId, output: null, error: null, status: 'pending', requires_approval: false, ...step };
      steps.push(row);
      return row;
    },
    listSprintSteps(sprintId) { return steps.filter(s => s.sprint_id === sprintId).sort((a, b) => a.position - b.position); },
    getSprintStep(id) { return steps.find(s => s.id === id) || null; },
    updateSprintStep(id, patch) { const s = steps.find(x => x.id === id); if (s) Object.assign(s, patch); return s || null; },
    nextPendingStep(sprintId) { return steps.filter(s => s.sprint_id === sprintId && s.status === 'pending')[0] || null; },
    addSprintFeed(sprintId, kind, message) { feed.push({ sprint_id: sprintId, kind, message }); },
    listSprintFeed({ sprintId } = {}) { return feed.filter(f => f.sprint_id === sprintId); },
    resetInterruptedSprints() { return 0; },
  };
}

test('a goal-only sprint runs its stages in order, one at a time', async () => {
  const store = sprintStore();
  const started = [];
  const sprints = createSprints({
    store,
    maxParallel: 3,
    runStep: async (step) => {
      started.push(step.stage);
      await new Promise(resolve => setTimeout(resolve, 5));
      return { ok: true, text: `${step.stage} output` };
    },
  });

  const sprint = sprints.create({ goal: 'Only a goal, no source tasks', stages: ['research', 'draft', 'review'] });
  sprints.start(sprint.id);

  const first = await sprints.tick();
  assert.equal(first.ran, 1, 'a single pipeline must not fan out its own stages');
  await sprints.tick();
  await sprints.tick();
  assert.deepEqual(started, ['research', 'draft', 'review'], 'stages run in pipeline order');
});

test('independent source tasks run in parallel while one task keeps stage order', async () => {
  const store = sprintStore();
  const a = store.createTask({ title: 'Task A' });
  const b = store.createTask({ title: 'Task B' });
  const started = [];
  let active = 0;
  let peak = 0;

  const sprints = createSprints({
    store,
    maxParallel: 3,
    runStep: async (step) => {
      started.push({ source: step.source_task_id, stage: step.stage });
      active += 1;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active -= 1;
      return { ok: true, text: `${step.stage} for ${step.source_task_id}` };
    },
  });

  const sprint = sprints.create({ goal: 'Pool the fleet', tasks: [a, b], stages: ['research', 'polish'] });
  sprints.start(sprint.id);

  const first = await sprints.tick();
  assert.equal(first.ran, 2, 'one stage per source task');
  assert.equal(new Set(started.map(s => s.source)).size, 2, 'different tasks, not two stages of one');
  assert.equal(peak, 2, 'both ran at the same time');

  await sprints.tick();
  const steps = store.listSprintSteps(sprint.id);
  const perTask = new Map();
  for (const step of steps.filter(s => s.status === 'done')) {
    perTask.set(step.source_task_id, (perTask.get(step.source_task_id) || 0) + 1);
  }
  assert.equal(perTask.get(a.id), 2, 'stages of one task stay sequential');
  assert.equal(perTask.get(b.id), 2);
});
