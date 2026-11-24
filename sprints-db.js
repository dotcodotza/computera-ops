// Persistence for sustained sprints (Stage 4) and the automation feed (Stage 5).
// Shares the single SQLite connection owned by tasks-db.js so there is one writer.
import { randomUUID } from 'crypto';
import { db } from './tasks-db.js';

const SPRINT_STATUSES = ['planning', 'running', 'paused', 'review', 'done', 'stopped'];
const STEP_STATUSES = ['pending', 'running', 'done', 'failed', 'rejected'];

db.exec(`
  CREATE TABLE IF NOT EXISTS sprints (
    id TEXT PRIMARY KEY,
    goal TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'planning',
    template TEXT NOT NULL DEFAULT 'generic',
    stages TEXT NOT NULL DEFAULT '[]',
    duration_ms INTEGER NOT NULL DEFAULT 0,
    overrides TEXT NOT NULL DEFAULT '{}',
    checkpoint TEXT NOT NULL DEFAULT '{}',
    started_at TEXT,
    ends_at TEXT,
    finished_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sprints_created ON sprints(created_at);

  CREATE TABLE IF NOT EXISTS sprint_steps (
    id TEXT PRIMARY KEY,
    sprint_id TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    source_task_id TEXT,
    task_id TEXT,
    source_title TEXT NOT NULL DEFAULT '',
    stage TEXT NOT NULL,
    role TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    prompt TEXT NOT NULL DEFAULT '',
    output TEXT,
    error TEXT,
    requires_approval INTEGER NOT NULL DEFAULT 0,
    approved_at TEXT,
    applied_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sprint_steps_sprint ON sprint_steps(sprint_id, position);

  CREATE TABLE IF NOT EXISTS sprint_feed (
    id TEXT PRIMARY KEY,
    sprint_id TEXT,
    kind TEXT NOT NULL,
    message TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sprint_feed_sprint ON sprint_feed(sprint_id, created_at);
`);

function parseJson(value, fallback) {
  try {
    const parsed = JSON.parse(value || '');
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch { return fallback; }
}

function rowToSprint(row) {
  if (!row) return null;
  return {
    id: row.id,
    goal: row.goal,
    status: row.status,
    template: row.template,
    stages: parseJson(row.stages, []),
    duration_ms: Number(row.duration_ms || 0),
    overrides: parseJson(row.overrides, {}),
    checkpoint: parseJson(row.checkpoint, {}),
    started_at: row.started_at || null,
    ends_at: row.ends_at || null,
    finished_at: row.finished_at || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function rowToStep(row) {
  if (!row) return null;
  return {
    id: row.id,
    sprint_id: row.sprint_id,
    position: Number(row.position || 0),
    source_task_id: row.source_task_id || null,
    task_id: row.task_id || null,
    source_title: row.source_title || '',
    stage: row.stage,
    role: row.role,
    status: row.status,
    prompt: row.prompt || '',
    output: row.output || null,
    error: row.error || null,
    requires_approval: !!row.requires_approval,
    approved_at: row.approved_at || null,
    applied_at: row.applied_at || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function rowToFeed(row) {
  return {
    id: row.id,
    sprint_id: row.sprint_id,
    kind: row.kind,
    message: row.message,
    created_at: row.created_at,
  };
}

export function createSprint(input = {}) {
  const now = new Date().toISOString();
  const sprint = {
    id: randomUUID(),
    goal: String(input.goal || '').slice(0, 500),
    status: SPRINT_STATUSES.includes(input.status) ? input.status : 'planning',
    template: String(input.template || 'generic'),
    stages: JSON.stringify(Array.isArray(input.stages) ? input.stages : []),
    duration_ms: Number(input.duration_ms || 0),
    overrides: JSON.stringify(input.overrides && typeof input.overrides === 'object' ? input.overrides : {}),
    checkpoint: JSON.stringify(input.checkpoint && typeof input.checkpoint === 'object' ? input.checkpoint : {}),
    started_at: input.started_at || null,
    ends_at: input.ends_at || null,
    finished_at: null,
    created_at: now,
    updated_at: now,
  };
  db.prepare(`
    INSERT INTO sprints (id, goal, status, template, stages, duration_ms, overrides, checkpoint,
                         started_at, ends_at, finished_at, created_at, updated_at)
    VALUES (:id, :goal, :status, :template, :stages, :duration_ms, :overrides, :checkpoint,
            :started_at, :ends_at, :finished_at, :created_at, :updated_at)
  `).run(sprint);
  return getSprint(sprint.id);
}

export function getSprint(id) {
  return rowToSprint(db.prepare('SELECT * FROM sprints WHERE id = ?').get(String(id)));
}

export function listSprints(limit = 20) {
  const n = Math.min(Math.max(Number(limit) || 20, 1), 100);
  return db.prepare('SELECT * FROM sprints ORDER BY created_at DESC LIMIT ?').all(n).map(rowToSprint);
}

export function updateSprint(id, patch = {}) {
  const current = getSprint(id);
  if (!current) return null;
  const next = { ...current };
  if ('goal' in patch) next.goal = String(patch.goal || '').slice(0, 500);
  if ('status' in patch && SPRINT_STATUSES.includes(patch.status)) next.status = patch.status;
  if ('template' in patch) next.template = String(patch.template || current.template);
  if ('stages' in patch) next.stages = Array.isArray(patch.stages) ? patch.stages : current.stages;
  if ('duration_ms' in patch) next.duration_ms = Number(patch.duration_ms) || current.duration_ms;
  if ('overrides' in patch) next.overrides = patch.overrides || {};
  if ('checkpoint' in patch) next.checkpoint = patch.checkpoint || {};
  if ('started_at' in patch) next.started_at = patch.started_at || null;
  if ('ends_at' in patch) next.ends_at = patch.ends_at || null;
  if ('finished_at' in patch) next.finished_at = patch.finished_at || null;

  db.prepare(`
    UPDATE sprints SET goal = :goal, status = :status, template = :template, stages = :stages,
      duration_ms = :duration_ms, overrides = :overrides, checkpoint = :checkpoint,
      started_at = :started_at, ends_at = :ends_at, finished_at = :finished_at, updated_at = :updated_at
    WHERE id = :id
  `).run({
    id: current.id,
    goal: next.goal,
    status: next.status,
    template: next.template,
    stages: JSON.stringify(next.stages || []),
    duration_ms: Number(next.duration_ms || 0),
    overrides: JSON.stringify(next.overrides || {}),
    checkpoint: JSON.stringify(next.checkpoint || {}),
    started_at: next.started_at || null,
    ends_at: next.ends_at || null,
    finished_at: next.finished_at || null,
    updated_at: new Date().toISOString(),
  });
  return getSprint(current.id);
}

export function addSprintStep(sprintId, step = {}) {
  const now = new Date().toISOString();
  const row = {
    id: randomUUID(),
    sprint_id: String(sprintId),
    position: Number(step.position || 0),
    source_task_id: step.source_task_id ? String(step.source_task_id) : null,
    task_id: step.task_id ? String(step.task_id) : null,
    source_title: String(step.source_title || '').slice(0, 200),
    stage: String(step.stage || 'draft'),
    role: String(step.role || 'worker'),
    status: STEP_STATUSES.includes(step.status) ? step.status : 'pending',
    prompt: String(step.prompt || ''),
    output: null,
    error: null,
    requires_approval: step.requires_approval ? 1 : 0,
    approved_at: null,
    applied_at: null,
    created_at: now,
    updated_at: now,
  };
  db.prepare(`
    INSERT INTO sprint_steps (id, sprint_id, position, source_task_id, task_id, source_title, stage, role,
                              status, prompt, output, error, requires_approval, approved_at, applied_at,
                              created_at, updated_at)
    VALUES (:id, :sprint_id, :position, :source_task_id, :task_id, :source_title, :stage, :role,
            :status, :prompt, :output, :error, :requires_approval, :approved_at, :applied_at,
            :created_at, :updated_at)
  `).run(row);
  return getSprintStep(row.id);
}

export function listSprintSteps(sprintId) {
  return db.prepare('SELECT * FROM sprint_steps WHERE sprint_id = ? ORDER BY position ASC, created_at ASC')
    .all(String(sprintId))
    .map(rowToStep);
}

export function getSprintStep(id) {
  return rowToStep(db.prepare('SELECT * FROM sprint_steps WHERE id = ?').get(String(id)));
}

export function updateSprintStep(id, patch = {}) {
  const current = getSprintStep(id);
  if (!current) return null;
  const next = { ...current };
  if ('status' in patch && STEP_STATUSES.includes(patch.status)) next.status = patch.status;
  if ('output' in patch) next.output = patch.output === null ? null : String(patch.output).slice(0, 20000);
  if ('error' in patch) next.error = patch.error ? String(patch.error).slice(0, 500) : null;
  if ('approved_at' in patch) next.approved_at = patch.approved_at || null;
  if ('applied_at' in patch) next.applied_at = patch.applied_at || null;
  if ('task_id' in patch) next.task_id = patch.task_id ? String(patch.task_id) : null;
  if ('prompt' in patch) next.prompt = String(patch.prompt || '');

  db.prepare(`
    UPDATE sprint_steps SET status = :status, output = :output, error = :error,
      approved_at = :approved_at, applied_at = :applied_at, task_id = :task_id, prompt = :prompt,
      updated_at = :updated_at
    WHERE id = :id
  `).run({
    id: current.id,
    status: next.status,
    output: next.output || null,
    error: next.error || null,
    approved_at: next.approved_at || null,
    applied_at: next.applied_at || null,
    task_id: next.task_id || null,
    prompt: next.prompt || '',
    updated_at: new Date().toISOString(),
  });
  return getSprintStep(current.id);
}

export function nextPendingStep(sprintId) {
  return rowToStep(db.prepare(`
    SELECT * FROM sprint_steps WHERE sprint_id = ? AND status = 'pending'
    ORDER BY position ASC LIMIT 1
  `).get(String(sprintId)));
}

export function addSprintFeed(sprintId, kind, message = '') {
  db.prepare('INSERT INTO sprint_feed (id, sprint_id, kind, message, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(randomUUID(), sprintId ? String(sprintId) : null, String(kind || 'system'), String(message).slice(0, 500), new Date().toISOString());
  db.prepare(`
    DELETE FROM sprint_feed WHERE sprint_id IS :sprint_id AND id NOT IN (
      SELECT id FROM sprint_feed WHERE sprint_id IS :sprint_id ORDER BY created_at DESC LIMIT 500
    )
  `).run({ sprint_id: sprintId ? String(sprintId) : null });
}

export function listSprintFeed({ sprintId, kind, limit = 100 } = {}) {
  const n = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const clauses = [];
  const params = { limit: n };
  if (sprintId) { clauses.push('sprint_id = :sprint_id'); params.sprint_id = String(sprintId); }
  if (kind) { clauses.push('kind = :kind'); params.kind = String(kind); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM sprint_feed ${where} ORDER BY created_at DESC LIMIT :limit`)
    .all(params)
    .map(rowToFeed);
}

// A crash can leave steps marked running. They never resolved, so put them back in
// the queue; the sprint checkpoint itself is untouched.
export function resetInterruptedSprints() {
  const result = db.prepare("UPDATE sprint_steps SET status = 'pending', updated_at = ? WHERE status = 'running'")
    .run(new Date().toISOString());
  return Number(result.changes || 0);
}

export { SPRINT_STATUSES, STEP_STATUSES };
