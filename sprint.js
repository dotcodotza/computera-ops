// Stages 4-6: sustained sprint mode.
//
// A sprint improves existing tasks (or a free-standing goal) by splitting the work
// into role-specific stages. Roles come from the fleet's installed model sizes with
// an explicit override map, the sprint is checkpointed after every step so a restart
// resumes where it stopped, and the final result is applied to the source task only
// after a human approves it.

export const ROLES = ['pace-maker', 'worker', 'orchestrator'];
export const DEFAULT_DURATION_MS = 10 * 60 * 60 * 1000;

export const STAGE_TEMPLATES = {
  generic: ['research', 'draft', 'review', 'polish'],
  code: ['research', 'draft', 'review', 'polish'],
  docs: ['research', 'outline', 'draft', 'polish'],
  marketing: ['research', 'outline', 'draft', 'polish'],
  research: ['research', 'outline', 'draft', 'review'],
};

export const STAGE_ROLE = {
  research: 'worker',
  outline: 'worker',
  draft: 'worker',
  review: 'orchestrator',
  polish: 'worker',
};

export const STAGE_INSTRUCTIONS = {
  research: 'Collect the facts, constraints and open questions that matter for this task. Short bullets, no filler.',
  outline: 'Propose a concrete structure or plan for the deliverable. List the sections or steps in order.',
  draft: 'Write the first complete draft of the deliverable. It must be usable as-is, not a sketch.',
  review: 'Review the work so far against the sprint goal. Say what is weak, then rewrite the weak parts into one stronger version. Do not produce parallel variants.',
  polish: 'Produce the final improved version. Fix quality, clarity, style and consistency. Reply with the finished work product only.',
};

const PACE_LINES = {
  research: ['is digging up the context for', 'collected the facts on'],
  outline: ['sketched a plan for', 'laid out the structure of'],
  draft: ['is drafting', 'is writing the first pass of'],
  review: ['is reviewing', 'is tightening'],
  polish: ['is polishing', 'is finishing'],
};

// "llama3:8b" -> 8, "qwen2.5:1.5b" -> 1.5, "mixtral" -> null
export function modelSizeB(name) {
  const match = String(name || '').toLowerCase().match(/(\d+(?:\.\d+)?)\s*b(?!\w)/);
  if (!match) return null;
  const size = Number(match[1]);
  return Number.isFinite(size) && size > 0 ? size : null;
}

// Rank based so it works with whatever the fleet actually has installed: the
// smallest model announces progress, the largest reviews and delegates, the rest
// do the work. An explicit override always wins.
export function assignFleetRoles(models = [], overrides = {}) {
  const list = (Array.isArray(models) ? models : [])
    .map(model => String(model || '').trim())
    .filter(Boolean)
    .map(model => ({ model, size: modelSizeB(model) }));

  const sizes = [...new Set(list.map(m => m.size).filter(size => size !== null))].sort((a, b) => a - b);
  const bySize = new Map();
  if (sizes.length === 1) bySize.set(sizes[0], 'worker');
  else if (sizes.length >= 2) {
    bySize.set(sizes[0], 'pace-maker');
    bySize.set(sizes[sizes.length - 1], 'orchestrator');
    for (const size of sizes.slice(1, -1)) bySize.set(size, 'worker');
  }

  return list.map(({ model, size }) => ({
    model,
    size,
    role: ROLES.includes(overrides?.[model]) ? overrides[model] : (bySize.get(size) || 'worker'),
  }));
}

export function roleForModel(model, { models = [], overrides = {} } = {}) {
  const entry = assignFleetRoles(models, overrides).find(r => r.model === model);
  return entry ? entry.role : 'worker';
}

// Which stage template fits a task, from its agent, tags and title.
export function templateForTask(task = {}) {
  const hay = [task.agent, (task.tags || []).join(' '), task.title].join(' ').toLowerCase();
  if (/code|dev|bug|refactor|test|api|deploy/.test(hay)) return 'code';
  if (/market|newsletter|campaign|copy|social|launch|seo|brand/.test(hay)) return 'marketing';
  if (/research|analy|report|study|survey|competitor/.test(hay)) return 'research';
  if (/doc|readme|guide|manual|spec|plan/.test(hay)) return 'docs';
  return 'generic';
}

export function planSprintSteps({ tasks = [], stages, models = [], overrides = {} } = {}) {
  const stageList = (Array.isArray(stages) ? stages : []).filter(stage => STAGE_ROLE[stage]);
  const effective = stageList.length ? stageList : STAGE_TEMPLATES.generic;
  const sources = (Array.isArray(tasks) ? tasks : []).filter(Boolean);
  const planned = [];
  let position = 0;

  for (const source of sources) {
    effective.forEach((stage, index) => {
      planned.push({
        position: position++,
        source_task_id: source.id || null,
        source_title: String(source.title || '').slice(0, 200),
        stage,
        role: STAGE_ROLE[stage],
        requires_approval: index === effective.length - 1,
        model: assignFleetRoles(models, overrides).find(r => r.role === STAGE_ROLE[stage])?.model || null,
      });
    });
  }
  return planned;
}

export function buildStepPrompt(step = {}, sprint = {}, context = {}) {
  const previous = Array.isArray(context.previous) ? context.previous.filter(s => s && s.output) : [];
  const title = step.source_title || step.sourceTitle || '';
  return [
    `Sustained sprint: ${sprint.goal || 'improve the assigned work'}`,
    `Stage: ${step.stage} · role: ${step.role}`,
    title ? `Task: ${title}` : '',
    previous.length
      ? 'Work so far:\n' + previous
        .map(s => `### ${s.stage} (${s.role})\n${String(s.output).slice(0, 6000)}`)
        .join('\n\n')
      : '',
    STAGE_INSTRUCTIONS[step.stage] || STAGE_INSTRUCTIONS.draft,
    'Reply with the work product only. No preamble, no questions.',
  ].filter(Boolean).join('\n\n');
}

// Deterministic momentum line for the separate pace-maker feed. No model call:
// announcing progress must never compete with the work for engine slots.
export function paceLine(step = {}, sprint = {}) {
  const lines = PACE_LINES[step.stage] || ['is moving on with'];
  const seed = [...String(step.id || step.stage || '')].reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
  const subject = step.source_title || step.sourceTitle || sprint.goal || 'the sprint';
  return `${step.role} ${lines[seed % lines.length]} ${subject}`;
}

export function createSprints(options = {}) {
  const {
    store,
    runStep,
    now = () => Date.now(),
    log = console,
    defaultDurationMs = DEFAULT_DURATION_MS,
    maxParallel = 1,
  } = options;
  if (!store) throw new Error('createSprints needs a store');

  const inFlight = new Set();
  // One controller per sprint, so pause/stop interrupts a step that is already
  // running (a harness step can be hours long) instead of waiting for it.
  const aborts = new Map();
  let ticking = false;
  // Steps of different source tasks are independent, so several can run at once on
  // different workers. Stages of the same task stay sequential.
  const parallel = Math.max(1, Math.min(Number(maxParallel) || 1, 4));

  const iso = () => new Date(now()).toISOString();
  const idOf = (value) => (value && typeof value.id === 'string' ? value.id : null);

  function fail(message, status = 400) {
    return Object.assign(new Error(message), { status });
  }

  function requireSprint(id) {
    const sprint = store.getSprint(id);
    if (!sprint) throw fail('sprint not found', 404);
    return sprint;
  }

  function feed(sprintId, kind, message) {
    if (typeof store.addSprintFeed === 'function') store.addSprintFeed(sprintId, kind, message);
  }

  function checkpoint(sprint, step) {
    store.updateSprint(sprint.id, {
      checkpoint: { step_id: step.id, position: step.position, at: iso() },
    });
  }

  // A sprint is only finished when nothing is left to run and every approval has
  // been decided. Failures hold it in review so a human can retry or reject.
  function evaluate(sprintId) {
    const sprint = store.getSprint(sprintId);
    if (!sprint || sprint.status === 'stopped' || sprint.status === 'paused') return sprint;
    const steps = store.listSprintSteps(sprintId);
    if (!steps.length) return sprint;
    const failed = steps.some(s => s.status === 'failed');
    if (!failed && steps.some(s => s.status === 'pending' || s.status === 'running')) return sprint;

    let status = 'done';
    if (failed) status = 'review';
    else if (steps.some(s => s.requires_approval && !s.applied_at && s.status !== 'rejected')) status = 'review';

    if (status === sprint.status) return sprint;
    const updated = store.updateSprint(sprintId, {
      status,
      finished_at: status === 'done' ? iso() : null,
    });
    feed(sprintId, 'system', status === 'done' ? 'Sprint complete' : 'Sprint is waiting for review');
    return updated || sprint;
  }

  function create(input = {}) {
    const goal = String(input.goal || '').trim();
    if (!goal) throw fail('goal is required');
    if (goal.length > 500) throw fail('goal must be 500 characters or fewer');

    const template = STAGE_TEMPLATES[input.template] ? input.template : 'generic';
    const stageList = (Array.isArray(input.stages) && input.stages.length ? input.stages : STAGE_TEMPLATES[template])
      .filter(stage => STAGE_ROLE[stage]);
    const durationHours = Number(input.durationHours);
    const durationMs = Number.isFinite(durationHours) && durationHours > 0
      ? Math.min(durationHours, 24 * 7) * 3600000
      : (Number(input.durationMs) > 0 ? Number(input.durationMs) : defaultDurationMs);

    const sources = (Array.isArray(input.tasks) ? input.tasks : []).filter(Boolean);
    const taskSources = sources.length ? sources : [{ id: null, title: goal, tags: [], agent: 'master' }];
    const overrides = input.overrides && typeof input.overrides === 'object' ? input.overrides : {};
    const planned = planSprintSteps({
      tasks: taskSources,
      stages: stageList,
      models: input.models,
      overrides,
    });

    const sprint = store.createSprint({
      goal,
      template,
      stages: stageList,
      duration_ms: durationMs,
      overrides,
      status: 'planning',
    });

    for (const step of planned) {
      let taskId = null;
      if (typeof store.createTask === 'function') {
        try {
          const child = store.createTask({
            title: `${step.stage}: ${step.source_title || goal}`.slice(0, 200),
            description: buildStepPrompt(step, sprint, {}),
            status: 'todo',
            agent: step.role,
            needs: step.role === 'orchestrator' ? 'kilo' : 'any',
            parent_id: step.source_task_id || null,
            sprint_id: sprint.id,
            tags: ['sprint', step.stage],
          });
          taskId = idOf(child);
        } catch (err) {
          log.warn?.(`Sprint step task could not be created: ${err.message}`);
        }
      }
      store.addSprintStep(sprint.id, {
        ...step,
        task_id: taskId,
        prompt: buildStepPrompt(step, sprint, {}),
      });
    }

    feed(sprint.id, 'system', `Sprint planned: ${planned.length} step(s) across ${stageList.join(' → ')}`);
    feed(sprint.id, 'pace', `pace-maker: ${goal}`);
    return store.getSprint(sprint.id);
  }

  function start(id, { resumed = false } = {}) {
    const sprint = requireSprint(id);
    if (sprint.status === 'running') return sprint;
    if (sprint.status === 'done' || sprint.status === 'stopped') {
      throw fail('this sprint has already finished; create a new one');
    }
    if (!store.listSprintSteps(sprint.id).length) throw fail('sprint has no steps');

    aborts.get(sprint.id)?.abort();
    aborts.set(sprint.id, new AbortController());
    const updated = store.updateSprint(sprint.id, {
      status: 'running',
      started_at: sprint.started_at || iso(),
      ends_at: sprint.ends_at || new Date(now() + (Number(sprint.duration_ms) || defaultDurationMs)).toISOString(),
      finished_at: null,
    });
    feed(sprint.id, 'system', resumed ? `Sprint resumed from step ${sprint.checkpoint?.position ?? 0}` : 'Sprint started');
    return updated || sprint;
  }

  function pause(id) {
    const sprint = requireSprint(id);
    if (sprint.status !== 'running') throw fail(`cannot pause a ${sprint.status} sprint`);
    const updated = store.updateSprint(sprint.id, { status: 'paused' });
    aborts.get(sprint.id)?.abort();
    feed(sprint.id, 'system', 'Sprint paused');
    return updated || sprint;
  }

  function resume(id) {
    const sprint = requireSprint(id);
    if (sprint.status !== 'paused' && sprint.status !== 'planning') {
      throw fail(`cannot resume a ${sprint.status} sprint`);
    }
    return start(sprint.id, { resumed: true });
  }

  function stop(id) {
    const sprint = requireSprint(id);
    if (sprint.status === 'done' || sprint.status === 'stopped') return sprint;
    const updated = store.updateSprint(sprint.id, { status: 'stopped', finished_at: iso() });
    aborts.get(sprint.id)?.abort();
    feed(sprint.id, 'system', 'Sprint stopped by operator');
    return updated || sprint;
  }

  // Runs one step and records its outcome, so parallel steps share bookkeeping.
  async function runStepNow(sprint, step) {
    inFlight.add(step.id);
    store.updateSprintStep(step.id, { status: 'running', error: null });
    if (step.task_id && typeof store.updateTask === 'function') {
      try { store.updateTask(step.task_id, { status: 'in_progress' }); } catch { /* task may be gone */ }
    }
    feed(sprint.id, 'system', `${step.stage} started (${step.role})`);

    const signal = aborts.get(sprint.id)?.signal;
    try {
      const previous = store.listSprintSteps(sprint.id).filter(s =>
        s.source_task_id === step.source_task_id
        && s.status === 'done'
        && s.position < step.position);
      const result = await runStep(step, sprint, { previous, sprint, signal });
      if (signal?.aborted) {
        // Interrupted, not failed: put the stage back so resume re-runs it.
        store.updateSprintStep(step.id, { status: 'pending', error: null });
        feed(sprint.id, 'system', `${step.stage} interrupted — queued for the next run`);
      } else if (result && result.ok && String(result.text || '').trim()) {
        store.updateSprintStep(step.id, { status: 'done', output: String(result.text), error: null });
        feed(sprint.id, 'stage', `${step.stage} finished (${step.role})`);
        feed(sprint.id, 'pace', paceLine(step, sprint));
        checkpoint(sprint, step);
      } else {
        const error = (result && result.error) || 'step produced no output';
        store.updateSprintStep(step.id, { status: 'failed', error });
        feed(sprint.id, 'error', `${step.stage} failed: ${error}`);
      }
    } catch (err) {
      if (signal?.aborted) {
        store.updateSprintStep(step.id, { status: 'pending', error: null });
        feed(sprint.id, 'system', `${step.stage} interrupted — queued for the next run`);
      } else {
        store.updateSprintStep(step.id, { status: 'failed', error: err.message });
        feed(sprint.id, 'error', `${step.stage} failed: ${err.message}`);
      }
    } finally {
      inFlight.delete(step.id);
    }
  }

  // Up to `parallel` steps of different source tasks, so the fleet's workers are
  // pooled instead of one engine doing everything in sequence.
  function nextBatch(sprintId) {
    const steps = store.listSprintSteps(sprintId);
    // Stages of one source task form a pipeline, so they stay sequential. A
    // goal-only sprint is a single pipeline, pooled across workers by role but
    // never running review against a draft that has not finished.
    const chain = step => step.source_task_id || 'sprint:' + sprintId;
    const busySources = new Set(steps.filter(s => s.status === 'running').map(chain));
    const batch = [];
    for (const step of steps) {
      if (batch.length >= parallel) break;
      if (step.status !== 'pending' || inFlight.has(step.id)) continue;
      if (busySources.has(chain(step))) continue;
      batch.push(step);
      busySources.add(chain(step));
    }
    return batch;
  }

  async function tick() {
    if (ticking) return { ran: 0 };
    ticking = true;
    let ran = 0;
    try {
      const running = store.listSprints(100).filter(s => s.status === 'running');
      for (const sprint of running) {
        if (sprint.ends_at && Date.parse(sprint.ends_at) <= now()) {
          store.updateSprint(sprint.id, { status: 'review', finished_at: iso() });
          feed(sprint.id, 'system', 'Sprint time budget reached; stopping at the last checkpoint');
          continue;
        }

        // A failed stage blocks the stages that depend on it: hold the sprint in
        // review until a human retries or rejects it.
        if (store.listSprintSteps(sprint.id).some(s => s.status === 'failed')) {
          evaluate(sprint.id);
          continue;
        }

        const batch = nextBatch(sprint.id);
        if (!batch.length) { evaluate(sprint.id); continue; }
        ran += batch.length;
        await Promise.all(batch.map(step => runStepNow(sprint, step)));
        evaluate(sprint.id);
      }
      return { ran };
    } finally {
      ticking = false;
    }
  }

  function approve(id, stepId, { approve = true, note = '' } = {}) {
    const sprint = requireSprint(id);
    const step = store.getSprintStep(stepId);
    if (!step || step.sprint_id !== sprint.id) throw fail('step not found', 404);
    if (step.status !== 'done') throw fail(`only a finished step can be approved (it is ${step.status})`);
    if (!step.requires_approval) throw fail('this step does not need approval');
    if (!approve) {
      store.updateSprintStep(step.id, { status: 'rejected', approved_at: iso() });
      feed(sprint.id, 'approval', `${step.stage} rejected${note ? ': ' + note : ''}`);
      return evaluate(sprint.id);
    }

    const source = step.source_task_id && typeof store.getTask === 'function'
      ? store.getTask(step.source_task_id)
      : null;
    if (source && typeof store.updateTask === 'function') {
      const prior = source.result ? String(source.result).trim() : '';
      const improved = [
        '---',
        `Improved by sprint ${sprint.id} (${step.stage}, ${step.role})`,
        String(step.output || '').trim(),
      ].join('\n');
      store.updateTask(source.id, { result: [prior, improved].filter(Boolean).join('\n\n') });
    }
    store.updateSprintStep(step.id, { approved_at: iso(), applied_at: iso() });
    feed(sprint.id, 'approval', `${step.stage} approved${source ? ' and applied to ' + source.title : ''}`);
    return evaluate(sprint.id);
  }

  function retry(id, stepId) {
    const sprint = requireSprint(id);
    const step = store.getSprintStep(stepId);
    if (!step || step.sprint_id !== sprint.id) throw fail('step not found', 404);
    if (step.status !== 'failed') throw fail('only a failed step can be retried');
    store.updateSprintStep(step.id, { status: 'pending', error: null });
    store.updateSprint(sprint.id, { status: 'running', finished_at: null });
    feed(sprint.id, 'system', `${step.stage} queued for retry`);
    return store.getSprint(sprint.id);
  }

  // Called once at boot: steps left "running" by a crash go back to the queue, and
  // the next tick picks the sprint up from its checkpoint.
  function resetInterrupted() {
    if (typeof store.resetInterruptedSprints !== 'function') return 0;
    const count = store.resetInterruptedSprints() || 0;
    if (count) log.log?.(`Sprints: re-queued ${count} interrupted step(s)`);
    return count;
  }

  function status(id) {
    const sprint = requireSprint(id);
    return {
      sprint,
      steps: store.listSprintSteps(sprint.id),
      // A long sprint's transcript is the point, so return the recent tail of the
      // verbatim feed rather than the default page.
      feed: typeof store.listSprintFeed === 'function' ? store.listSprintFeed({ sprintId: sprint.id, limit: 500 }) : [],
    };
  }

  return {
    create,
    start,
    pause,
    resume,
    stop,
    tick,
    approve,
    retry,
    status,
    resetInterrupted,
    list: (limit) => store.listSprints(limit),
  };
}
