import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSprints,
  assignFleetRoles,
  modelSizeB,
  planSprintSteps,
  templateForTask,
  buildStepPrompt,
  STAGE_TEMPLATES,
} from '../sprint.js';

const iso = () => new Date().toISOString();

// In-memory twin of sprints-db.js + the task store, so the lifecycle runs without
// SQLite or any engine.
function memoryStore() {
  const tasks = new Map();
  const sprints = new Map();
  const steps = [];
  const feed = [];
  let seq = 0;

  return {
    tasks, sprints, steps, feed,
    createTask(input = {}) {
      const task = {
        id: 'task-' + (++seq),
        title: input.title,
        description: input.description || '',
        status: input.status || 'todo',
        agent: input.agent || 'master',
        needs: input.needs || 'any',
        tags: input.tags || [],
        parent_id: input.parent_id || null,
        sprint_id: input.sprint_id || null,
        result: null,
        created_at: iso(),
      };
      tasks.set(task.id, task);
      return task;
    },
    getTask(id) { return tasks.get(String(id)) || null; },
    updateTask(id, patch = {}) {
      const task = tasks.get(String(id));
      if (!task) return null;
      Object.assign(task, patch);
      return task;
    },
    createSprint(input = {}) {
      const sprint = {
        id: 'sprint-' + (++seq),
        goal: input.goal,
        status: input.status || 'planning',
        template: input.template,
        stages: input.stages || [],
        duration_ms: input.duration_ms || 0,
        overrides: input.overrides || {},
        checkpoint: {},
        started_at: null,
        ends_at: null,
        finished_at: null,
        created_at: iso(),
        updated_at: iso(),
      };
      sprints.set(sprint.id, sprint);
      return sprint;
    },
    getSprint(id) { return sprints.get(String(id)) || null; },
    listSprints(limit = 20) { return [...sprints.values()].slice(0, limit); },
    updateSprint(id, patch = {}) {
      const sprint = sprints.get(String(id));
      if (!sprint) return null;
      Object.assign(sprint, patch);
      sprint.updated_at = iso();
      return sprint;
    },
    addSprintStep(sprintId, step = {}) {
      const row = {
        id: 'step-' + (++seq),
        sprint_id: sprintId,
        position: step.position || 0,
        source_task_id: step.source_task_id || null,
        task_id: step.task_id || null,
        source_title: step.source_title || '',
        stage: step.stage,
        role: step.role,
        status: step.status || 'pending',
        prompt: step.prompt || '',
        output: null,
        error: null,
        requires_approval: !!step.requires_approval,
        approved_at: null,
        applied_at: null,
        created_at: iso(),
        updated_at: iso(),
      };
      steps.push(row);
      return row;
    },
    listSprintSteps(sprintId) {
      return steps.filter(s => s.sprint_id === sprintId).sort((a, b) => a.position - b.position);
    },
    getSprintStep(id) { return steps.find(s => s.id === id) || null; },
    updateSprintStep(id, patch = {}) {
      const row = steps.find(s => s.id === id);
      if (!row) return null;
      Object.assign(row, patch);
      row.updated_at = iso();
      return row;
    },
    nextPendingStep(sprintId) {
      return steps
        .filter(s => s.sprint_id === sprintId && s.status === 'pending')
        .sort((a, b) => a.position - b.position)[0] || null;
    },
    addSprintFeed(sprintId, kind, message) {
      feed.push({ id: 'feed-' + (++seq), sprint_id: sprintId, kind, message, created_at: iso() });
    },
    listSprintFeed({ sprintId, kind, limit = 100 } = {}) {
      return feed
        .filter(f => (!sprintId || f.sprint_id === sprintId) && (!kind || f.kind === kind))
        .slice(-limit)
        .reverse();
    },
    resetInterruptedSprints() {
      let count = 0;
      for (const row of steps) {
        if (row.status === 'running') { row.status = 'pending'; count += 1; }
      }
      return count;
    },
  };
}

function stubRunner(text = step => `${step.stage} output`) {
  const calls = [];
  const runStep = async (step) => {
    calls.push(step);
    return { ok: true, text: text(step) };
  };
  return { runStep, calls };
}

test('model size and role tiers follow the installed fleet', () => {
  assert.equal(modelSizeB('llama3:8b'), 8);
  assert.equal(modelSizeB('qwen2.5:1.5b'), 1.5);
  assert.equal(modelSizeB('kilo-auto/free'), null);

  const roles = assignFleetRoles(['tiny:1b', 'mid:8b', 'big:70b']);
  assert.deepEqual(roles.map(r => r.role), ['pace-maker', 'worker', 'orchestrator']);

  const single = assignFleetRoles(['only:8b']);
  assert.equal(single[0].role, 'worker');

  const overridden = assignFleetRoles(['tiny:1b', 'big:70b'], { 'tiny:1b': 'orchestrator' });
  assert.equal(overridden[0].role, 'orchestrator');
  assert.equal(overridden[1].role, 'orchestrator');
});

test('stage templates follow the task kind and stage roles stay fixed', () => {
  assert.equal(templateForTask({ title: 'Fix the deploy bug', tags: ['code'] }), 'code');
  assert.equal(templateForTask({ title: 'Q4 newsletter', agent: 'marketing' }), 'marketing');
  assert.equal(templateForTask({ title: 'Competitor research' }), 'research');
  assert.equal(templateForTask({ title: 'Unrelated errand' }), 'generic');

  const steps = planSprintSteps({
    tasks: [{ id: 'a', title: 'Task A' }],
    stages: STAGE_TEMPLATES.generic,
  });
  assert.deepEqual(steps.map(s => s.role), ['worker', 'worker', 'orchestrator', 'worker']);
  assert.deepEqual(steps.filter(s => s.requires_approval).map(s => s.stage), ['polish']);
  assert.equal(steps[0].source_task_id, 'a');
});

test('a sprint plans child tasks linked to their source and stays in planning', () => {
  const store = memoryStore();
  const source = store.createTask({ title: 'Ship the launch page' });
  const sprints = createSprints({ store, runStep: async () => ({ ok: true, text: 'x' }) });

  const sprint = sprints.create({ goal: 'Make the launch page better', tasks: [source] });
  assert.equal(sprint.status, 'planning');

  const steps = store.listSprintSteps(sprint.id);
  assert.equal(steps.length, 4);
  assert.ok(steps.every(s => s.task_id), 'each step owns a child task');
  assert.ok(steps.every(s => s.source_task_id === source.id), 'each step keeps the source task');

  const child = store.getTask(steps[0].task_id);
  assert.equal(child.parent_id, source.id);
  assert.equal(child.sprint_id, sprint.id);
  assert.ok(child.tags.includes('sprint'));

  assert.ok(store.listSprintFeed({ sprintId: sprint.id, kind: 'pace' }).length >= 1);
});

test('each tick runs one step, checkpoints, and keeps pace chatter separate', async () => {
  const store = memoryStore();
  const source = store.createTask({ title: 'Improve onboarding' });
  const runner = stubRunner();
  const sprints = createSprints({ store, runStep: runner.runStep });

  const sprint = sprints.create({ goal: 'Better onboarding', tasks: [source] });
  sprints.start(sprint.id);

  const first = await sprints.tick();
  assert.equal(first.ran, 1);
  assert.equal(runner.calls.length, 1, 'one step per tick');

  const steps = store.listSprintSteps(sprint.id);
  assert.equal(steps.filter(s => s.status === 'done').length, 1);
  assert.equal(store.getSprint(sprint.id).checkpoint.position, 0);

  await sprints.tick();
  assert.equal(store.listSprintSteps(sprint.id).filter(s => s.status === 'done').length, 2);
  assert.equal(store.getSprint(sprint.id).checkpoint.position, 1);

  const pace = store.listSprintFeed({ sprintId: sprint.id, kind: 'pace' });
  const stage = store.listSprintFeed({ sprintId: sprint.id, kind: 'stage' });
  assert.ok(pace.length >= 2);
  assert.ok(stage.length >= 2);
  assert.ok(!pace.some(f => f.kind !== 'pace'), 'pace feed holds only pace-maker chatter');
});

test('the final result waits for approval before touching the source task', async () => {
  const store = memoryStore();
  const source = store.createTask({ title: 'Draft the ops runbook' });
  const sprints = createSprints({ store, runStep: stubRunner().runStep });

  const sprint = sprints.create({ goal: 'Improve the runbook', tasks: [source] });
  sprints.start(sprint.id);
  for (let i = 0; i < 4; i += 1) await sprints.tick();

  const afterRun = store.getSprint(sprint.id);
  assert.equal(afterRun.status, 'review', 'a sprint with an approval pending is in review');
  assert.equal(source.result, null, 'nothing is applied before approval');

  const approvalStep = store.listSprintSteps(sprint.id).find(s => s.requires_approval);
  assert.ok(approvalStep.applied_at === null);

  const finished = sprints.approve(sprint.id, approvalStep.id, { approve: true });
  assert.equal(finished.status, 'done');
  assert.ok(store.getSprintStep(approvalStep.id).applied_at);
  assert.match(source.result, /Improved by sprint/);
  assert.ok(store.listSprintFeed({ sprintId: sprint.id, kind: 'approval' }).length >= 1);
});

test('rejecting the final step finishes the sprint without changing the task', async () => {
  const store = memoryStore();
  const source = store.createTask({ title: 'Rewrite the FAQ' });
  const sprints = createSprints({ store, runStep: stubRunner().runStep });

  const sprint = sprints.create({ goal: 'Sharper FAQ', tasks: [source] });
  sprints.start(sprint.id);
  for (let i = 0; i < 4; i += 1) await sprints.tick();

  const approvalStep = store.listSprintSteps(sprint.id).find(s => s.requires_approval);
  const finished = sprints.approve(sprint.id, approvalStep.id, { approve: false, note: 'off tone' });
  assert.equal(finished.status, 'done');
  assert.equal(source.result, null);
  assert.equal(store.getSprintStep(approvalStep.id).status, 'rejected');
});

test('pause stops progress and resume continues from the checkpoint', async () => {
  const store = memoryStore();
  const source = store.createTask({ title: 'Improve docs' });
  const runner = stubRunner();
  const sprints = createSprints({ store, runStep: runner.runStep });

  const sprint = sprints.create({ goal: 'Docs sprint', tasks: [source] });
  sprints.start(sprint.id);
  await sprints.tick();
  sprints.pause(sprint.id);

  const before = runner.calls.length;
  await sprints.tick();
  assert.equal(runner.calls.length, before, 'a paused sprint never runs steps');

  sprints.resume(sprint.id);
  await sprints.tick();
  assert.equal(runner.calls.length, before + 1);
  assert.equal(store.getSprint(sprint.id).checkpoint.position, 1);
});

test('an interrupted step is re-queued after a restart and resumed', async () => {
  const store = memoryStore();
  const source = store.createTask({ title: 'Improve the incident postmortem' });
  const sprints = createSprints({ store, runStep: stubRunner().runStep });

  const sprint = sprints.create({ goal: 'Postmortem sprint', tasks: [source] });
  sprints.start(sprint.id);
  await sprints.tick();
  await sprints.tick();

  // Simulate a crash mid-step: the step is running and the process is gone.
  const interrupted = store.nextPendingStep(sprint.id);
  store.updateSprintStep(interrupted.id, { status: 'running' });

  const restarted = createSprints({ store, runStep: stubRunner().runStep });
  assert.equal(restarted.resetInterrupted(), 1);

  await restarted.tick();
  assert.equal(store.getSprintStep(interrupted.id).status, 'done');
  assert.equal(store.getSprint(sprint.id).checkpoint.position, 2);
});

test('a failed step holds the sprint until it is retried', async () => {
  const store = memoryStore();
  const source = store.createTask({ title: 'Improve the pricing page' });
  let failNext = true;
  const sprints = createSprints({
    store,
    runStep: async (step) => {
      if (step.stage === 'draft' && failNext) {
        failNext = false;
        return { ok: false, error: 'engine went away' };
      }
      return { ok: true, text: `${step.stage} output` };
    },
  });

  const sprint = sprints.create({ goal: 'Pricing sprint', tasks: [source] });
  sprints.start(sprint.id);
  await sprints.tick(); // research ok
  await sprints.tick(); // draft fails

  const failed = store.listSprintSteps(sprint.id).find(s => s.status === 'failed');
  assert.equal(failed.stage, 'draft');
  assert.equal(store.getSprint(sprint.id).status, 'review');

  const later = store.listSprintSteps(sprint.id).filter(s => s.position > failed.position);
  await sprints.tick();
  assert.ok(later.every(s => s.status === 'pending'), 'later stages wait for the failed one');

  sprints.retry(sprint.id, failed.id);
  assert.equal(store.getSprint(sprint.id).status, 'running');
  await sprints.tick();
  assert.equal(store.getSprintStep(failed.id).status, 'done');
});

test('the sprint stops at its time budget', async () => {
  const store = memoryStore();
  let clock = 1_000_000;
  const sprints = createSprints({
    store,
    now: () => clock,
    runStep: stubRunner().runStep,
  });

  const sprint = sprints.create({ goal: 'Timed sprint', tasks: [], durationMs: 5000 });
  sprints.start(sprint.id);
  assert.equal(store.listSprintSteps(sprint.id).length, 4, 'a goal-only sprint still plans stages');

  clock += 6000;
  await sprints.tick();
  const stopped = store.getSprint(sprint.id);
  assert.equal(stopped.status, 'review');
  assert.ok(store.listSprintFeed({ sprintId: sprint.id }).some(f => /time budget/.test(f.message)));
});

test('prompts carry the sprint goal and earlier stages', () => {
  const prompt = buildStepPrompt(
    { stage: 'polish', role: 'worker', source_title: 'Ops runbook' },
    { goal: 'Make the runbook usable' },
    { previous: [{ stage: 'draft', role: 'worker', output: 'draft body' }] },
  );
  assert.match(prompt, /Make the runbook usable/);
  assert.match(prompt, /Ops runbook/);
  assert.match(prompt, /draft body/);
  assert.match(prompt, /final improved version/i);
});

test('invalid sprint requests are rejected', () => {
  const store = memoryStore();
  const sprints = createSprints({ store, runStep: async () => ({ ok: true, text: 'x' }) });
  assert.throws(() => sprints.create({ goal: '   ' }), /goal is required/);
  assert.throws(() => sprints.status('missing'), /sprint not found/);
});
