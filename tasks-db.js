import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { DatabaseSync } from 'node:sqlite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'app.db');

const STATUSES = ['todo', 'in_progress', 'review', 'done'];
const PRIORITIES = ['low', 'medium', 'high'];
const AGENTS = ['master', 'it', 'admin', 'marketing'];
const NEEDS = ['any', 'kilo', 'ollama'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const AGENT_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

fs.ensureDirSync(DATA_DIR);

export const SQLITE_PRAGMAS = [
  'PRAGMA journal_mode = WAL;',
  'PRAGMA busy_timeout = 30000;',
];

// One place that knows how this app opens SQLite: WAL plus a busy timeout, so a
// second process writing the same file waits instead of failing with "database is locked".
export function openSqlite(file = DB_FILE) {
  const conn = new DatabaseSync(file);
  for (const pragma of SQLITE_PRAGMAS) conn.exec(pragma);
  return conn;
}

const db = openSqlite();
db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'todo',
    priority TEXT NOT NULL DEFAULT 'medium',
    agent TEXT NOT NULL DEFAULT 'master',
    assignee TEXT NOT NULL DEFAULT '',
    due_date TEXT,
    tags TEXT NOT NULL DEFAULT '',
    kilo_session_id TEXT,
    kilo_run_id TEXT,
    last_message_id TEXT,
    last_run_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON tasks(due_date);
  CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

  // Add kilo_run_id column to existing databases (no-op if already present).
  try { db.exec('ALTER TABLE tasks ADD COLUMN kilo_run_id TEXT'); } catch { /* column exists */ }

  CREATE TABLE IF NOT EXISTS workers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL DEFAULT '',
    capabilities TEXT NOT NULL DEFAULT '{}',
    max_concurrency INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'online',
    last_seen TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS fleet_events (
    id TEXT PRIMARY KEY,
    worker_id TEXT,
    kind TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_fleet_events_created ON fleet_events(created_at);

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS host_rotation (
    date TEXT PRIMARY KEY,
    worker_id TEXT,
    host_url TEXT,
    link_token TEXT,
    assigned_at TEXT NOT NULL
  );
`);

const existingColumns = new Set(db.prepare('PRAGMA table_info(tasks)').all().map(c => c.name));
for (const [name, ddl] of [
  ['agent', "ALTER TABLE tasks ADD COLUMN agent TEXT NOT NULL DEFAULT 'master'"],
  ['last_message_id', 'ALTER TABLE tasks ADD COLUMN last_message_id TEXT'],
  ['last_run_at', 'ALTER TABLE tasks ADD COLUMN last_run_at TEXT'],
  ['needs', "ALTER TABLE tasks ADD COLUMN needs TEXT NOT NULL DEFAULT 'any'"],
  ['assigned_worker', 'ALTER TABLE tasks ADD COLUMN assigned_worker TEXT'],
  ['attempts', 'ALTER TABLE tasks ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0'],
  ['blocked_reason', 'ALTER TABLE tasks ADD COLUMN blocked_reason TEXT'],
  ['result', 'ALTER TABLE tasks ADD COLUMN result TEXT'],
  ['parent_id', 'ALTER TABLE tasks ADD COLUMN parent_id TEXT'],
  ['sprint_id', 'ALTER TABLE tasks ADD COLUMN sprint_id TEXT'],
]) {
  if (!existingColumns.has(name)) db.exec(ddl);
}

export class TaskError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function normalizeTags(tags) {
  if (Array.isArray(tags)) return tags.map(t => String(t).trim()).filter(Boolean).join(',');
  return String(tags || '').split(',').map(t => t.trim()).filter(Boolean).join(',');
}

function rowToTask(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    agent: row.agent,
    assignee: row.assignee,
    due_date: row.due_date || null,
    tags: row.tags ? row.tags.split(',') : [],
    kilo_session_id: row.kilo_session_id || null,
    last_message_id: row.last_message_id || null,
    last_run_at: row.last_run_at || null,
    needs: row.needs || 'any',
    assigned_worker: row.assigned_worker || null,
    attempts: Number(row.attempts || 0),
    blocked_reason: row.blocked_reason || null,
    result: row.result || null,
    parent_id: row.parent_id || null,
    sprint_id: row.sprint_id || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function validateTitle(title) {
  const value = String(title || '').trim();
  if (!value) throw new TaskError('title is required');
  if (value.length > 200) throw new TaskError('title must be 200 characters or fewer');
  return value;
}

function validateEnum(value, allowed, field, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (!allowed.includes(value)) throw new TaskError(`${field} must be one of: ${allowed.join(', ')}`);
  return value;
}

// Agents are no longer restricted to the four defaults: any worker may declare a role slug.
function validateAgent(value, fallback = 'master') {
  if (value === undefined || value === null || value === '') return fallback;
  const slug = String(value).trim().toLowerCase();
  if (!AGENT_RE.test(slug)) throw new TaskError('agent must be a lowercase slug (a-z, 0-9, -, _)');
  return slug;
}

function validateNeeds(value, fallback = 'any') {
  if (value === undefined || value === null || value === '') return fallback;
  const need = String(value).trim().toLowerCase();
  if (!NEEDS.includes(need)) throw new TaskError(`needs must be one of: ${NEEDS.join(', ')}`);
  return need;
}

function validateDueDate(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (!DATE_RE.test(value)) throw new TaskError('due_date must be YYYY-MM-DD');
  return value;
}

export function listTasks(filters = {}) {
  const clauses = [];
  const params = {};
  if (filters.status) {
    validateEnum(filters.status, STATUSES, 'status');
    clauses.push('status = :status');
    params.status = filters.status;
  }
  if (filters.assignee) {
    clauses.push('assignee = :assignee');
    params.assignee = filters.assignee;
  }
  if (filters.agent) {
    clauses.push('agent = :agent');
    params.agent = validateAgent(filters.agent);
  }
  if (filters.worker) {
    clauses.push('assigned_worker = :worker');
    params.worker = filters.worker;
  }
  if (filters.needs) {
    clauses.push('needs = :needs');
    params.needs = validateNeeds(filters.needs);
  }
  if (filters.from) {
    if (!DATE_RE.test(filters.from)) throw new TaskError('from must be YYYY-MM-DD');
    clauses.push('due_date >= :from');
    params.from = filters.from;
  }
  if (filters.to) {
    if (!DATE_RE.test(filters.to)) throw new TaskError('to must be YYYY-MM-DD');
    clauses.push('due_date <= :to');
    params.to = filters.to;
  }
  if (filters.q) {
    clauses.push('(title LIKE :q OR description LIKE :q OR assignee LIKE :q OR tags LIKE :q)');
    params.q = `%${filters.q}%`;
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db.prepare(`
    SELECT * FROM tasks ${where}
    ORDER BY (due_date IS NULL), due_date ASC,
             CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
             created_at DESC
  `).all(params);
  return rows.map(rowToTask);
}

export function getTask(id) {
  return rowToTask(db.prepare('SELECT * FROM tasks WHERE id = ?').get(id));
}

export function createTask(input = {}) {
  const now = new Date().toISOString();
  const task = {
    id: randomUUID(),
    title: validateTitle(input.title),
    description: String(input.description || ''),
    status: validateEnum(input.status, STATUSES, 'status', 'todo'),
    priority: validateEnum(input.priority, PRIORITIES, 'priority', 'medium'),
    agent: validateAgent(input.agent, 'master'),
    assignee: String(input.assignee || '').trim(),
    due_date: validateDueDate(input.due_date) ?? null,
    tags: normalizeTags(input.tags),
    kilo_session_id: input.kilo_session_id ? String(input.kilo_session_id) : null,
    last_message_id: input.last_message_id ? String(input.last_message_id) : null,
    last_run_at: input.last_run_at ? String(input.last_run_at) : null,
    needs: validateNeeds(input.needs),
    assigned_worker: input.assigned_worker ? String(input.assigned_worker) : null,
    attempts: 0,
    blocked_reason: null,
    result: null,
    parent_id: input.parent_id ? String(input.parent_id) : null,
    sprint_id: input.sprint_id ? String(input.sprint_id) : null,
    created_at: now,
    updated_at: now,
  };
  db.prepare(`
    INSERT INTO tasks (id, title, description, status, priority, agent, assignee, due_date, tags,
                       kilo_session_id, last_message_id, last_run_at, needs, assigned_worker,
                       attempts, blocked_reason, result, parent_id,
                       sprint_id, created_at, updated_at)
    VALUES (:id, :title, :description, :status, :priority, :agent, :assignee, :due_date, :tags,
            :kilo_session_id, :last_message_id, :last_run_at, :needs, :assigned_worker,
            :attempts, :blocked_reason, :result, :parent_id,
            :sprint_id, :created_at, :updated_at)
  `).run(task);
  return getTask(task.id);
}

export function updateTask(id, patch = {}) {
  const current = getTask(id);
  if (!current) throw new TaskError('task not found', 404);

  const next = { ...current };
  if ('title' in patch) next.title = validateTitle(patch.title);
  if ('description' in patch) next.description = String(patch.description || '');
  if ('status' in patch) next.status = validateEnum(patch.status, STATUSES, 'status', current.status);
  if ('priority' in patch) next.priority = validateEnum(patch.priority, PRIORITIES, 'priority', current.priority);
  if ('agent' in patch) next.agent = validateAgent(patch.agent, current.agent);
  if ('assignee' in patch) next.assignee = String(patch.assignee || '').trim();
  if ('due_date' in patch) next.due_date = validateDueDate(patch.due_date) ?? null;
  if ('tags' in patch) next.tags = normalizeTags(patch.tags);
  if ('kilo_session_id' in patch) next.kilo_session_id = patch.kilo_session_id ? String(patch.kilo_session_id) : null;
  if ('last_message_id' in patch) next.last_message_id = patch.last_message_id ? String(patch.last_message_id) : null;
  if ('last_run_at' in patch) next.last_run_at = patch.last_run_at ? String(patch.last_run_at) : null;
  if ('needs' in patch) next.needs = validateNeeds(patch.needs, current.needs || 'any');
  if ('assigned_worker' in patch) next.assigned_worker = patch.assigned_worker ? String(patch.assigned_worker) : null;
  if ('attempts' in patch) {
    const attempts = Number(patch.attempts);
    next.attempts = Number.isFinite(attempts) ? Math.max(0, Math.trunc(attempts)) : current.attempts;
  }
  if ('blocked_reason' in patch) next.blocked_reason = patch.blocked_reason ? String(patch.blocked_reason) : null;
  if ('result' in patch) next.result = patch.result ? String(patch.result) : null;
  if ('parent_id' in patch) next.parent_id = patch.parent_id ? String(patch.parent_id) : null;
  if ('sprint_id' in patch) next.sprint_id = patch.sprint_id ? String(patch.sprint_id) : null;

  db.prepare(`
    UPDATE tasks SET title = :title, description = :description, status = :status, priority = :priority,
      agent = :agent, assignee = :assignee, due_date = :due_date, tags = :tags,
      kilo_session_id = :kilo_session_id, last_message_id = :last_message_id, last_run_at = :last_run_at,
      needs = :needs, assigned_worker = :assigned_worker, attempts = :attempts,
      blocked_reason = :blocked_reason, result = :result,
      parent_id = :parent_id, sprint_id = :sprint_id, updated_at = :updated_at
    WHERE id = :id
  `).run({
    id,
    title: next.title,
    description: next.description,
    status: next.status,
    priority: next.priority,
    agent: next.agent,
    assignee: next.assignee,
    due_date: next.due_date,
    tags: normalizeTags(next.tags),
    kilo_session_id: next.kilo_session_id,
    last_message_id: next.last_message_id,
    last_run_at: next.last_run_at,
    needs: next.needs || 'any',
    assigned_worker: next.assigned_worker || null,
    attempts: Number(next.attempts || 0),
    blocked_reason: next.blocked_reason || null,
    result: next.result || null,
    parent_id: next.parent_id || null,
    sprint_id: next.sprint_id || null,
    updated_at: new Date().toISOString(),
  });
  return getTask(id);
}

export function deleteTask(id) {
  const result = db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  if (!result.changes) throw new TaskError('task not found', 404);
  return true;
}

// -------------------------------------------------------------
// Fleet registry
// -------------------------------------------------------------

function rowToWorker(row) {
  if (!row) return null;
  let capabilities = {};
  try { capabilities = row.capabilities ? JSON.parse(row.capabilities) : {}; } catch { capabilities = {}; }
  return {
    id: row.id,
    name: row.name,
    base_url: row.base_url || '',
    capabilities,
    max_concurrency: Number(row.max_concurrency || 1),
    status: row.status,
    last_seen: row.last_seen || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function listWorkers({ staleMs = 45000 } = {}) {
  const now = Date.now();
  return db.prepare('SELECT * FROM workers ORDER BY created_at ASC').all()
    .map(rowToWorker)
    .map((w) => {
      const seen = w.last_seen ? Date.parse(w.last_seen) : 0;
      const age = seen ? now - seen : null;
      const online = !!seen && age !== null && age <= staleMs;
      return { ...w, status: online ? 'online' : 'offline', age_ms: age };
    });
}

export function getWorker(id) {
  return rowToWorker(db.prepare('SELECT * FROM workers WHERE id = ?').get(id));
}

export function upsertWorker(input = {}) {
  const id = String(input.id || randomUUID());
  const now = new Date().toISOString();
  const existing = db.prepare('SELECT * FROM workers WHERE id = ?').get(id);
  const capabilities = JSON.stringify(input.capabilities || {});
  if (existing) {
    db.prepare(`
      UPDATE workers SET name = :name, base_url = :base_url, capabilities = :capabilities,
        max_concurrency = :max_concurrency, last_seen = :last_seen, updated_at = :updated_at
      WHERE id = :id
    `).run({
      id,
      name: input.name ? String(input.name) : existing.name,
      base_url: input.base_url === undefined ? existing.base_url : String(input.base_url || ''),
      capabilities,
      max_concurrency: Number(input.max_concurrency || existing.max_concurrency || 1),
      last_seen: now,
      updated_at: now,
    });
  } else {
    db.prepare(`
      INSERT INTO workers (id, name, base_url, capabilities, max_concurrency, status, last_seen, created_at, updated_at)
      VALUES (:id, :name, :base_url, :capabilities, :max_concurrency, 'online', :last_seen, :created_at, :updated_at)
    `).run({
      id,
      name: String(input.name || id),
      base_url: String(input.base_url || ''),
      capabilities,
      max_concurrency: Number(input.max_concurrency || 1),
      last_seen: now,
      created_at: now,
      updated_at: now,
    });
  }
  return getWorker(id);
}

export function touchWorker(id, patch = {}) {
  if (!id) return null;
  const existing = db.prepare('SELECT * FROM workers WHERE id = ?').get(id);
  if (!existing) return null;
  const capabilities = patch.capabilities ? JSON.stringify(patch.capabilities) : existing.capabilities;
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE workers SET capabilities = :capabilities, last_seen = :last_seen, updated_at = :updated_at
    WHERE id = :id
  `).run({ id, capabilities, last_seen: now, updated_at: now });
  return getWorker(id);
}

export function deleteWorker(id) {
  const result = db.prepare('DELETE FROM workers WHERE id = ?').run(id);
  return !!result.changes;
}

export function countActiveByWorker() {
  const rows = db.prepare(`
    SELECT assigned_worker AS worker, COUNT(*) AS n
    FROM tasks
    WHERE assigned_worker IS NOT NULL AND status IN ('todo', 'in_progress')
    GROUP BY assigned_worker
  `).all();
  const counts = {};
  for (const row of rows) counts[row.worker] = Number(row.n);
  return counts;
}

// -------------------------------------------------------------
// Fleet events
// -------------------------------------------------------------

export function recordEvent(kind, detail = '', workerId = null) {
  db.prepare('INSERT INTO fleet_events (id, worker_id, kind, detail, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(randomUUID(), workerId, String(kind), String(detail).slice(0, 500), new Date().toISOString());
  db.prepare(`
    DELETE FROM fleet_events WHERE id NOT IN (
      SELECT id FROM fleet_events ORDER BY created_at DESC LIMIT 500
    )
  `).run();
}

export function listEvents(limit = 30) {
  const n = Math.min(Math.max(Number(limit) || 30, 1), 200);
  return db.prepare('SELECT * FROM fleet_events ORDER BY created_at DESC LIMIT ?').all(n);
}

// -------------------------------------------------------------
// Persisted node/exposure settings
// -------------------------------------------------------------

export function setSetting(key, value) {
  db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(String(key), String(value ?? ''), new Date().toISOString());
  return getSetting(key);
}

export function getSetting(key) {
  return db.prepare('SELECT key, value, updated_at FROM settings WHERE key = ?').get(String(key)) || null;
}

export function listSettings() {
  const out = {};
  for (const row of db.prepare('SELECT key, value, updated_at FROM settings ORDER BY key').all()) {
    out[row.key] = { value: row.value, updated_at: row.updated_at };
  }
  return out;
}

// -------------------------------------------------------------
// Host of the day rotation
// -------------------------------------------------------------

export function getRotation(date) {
  return db.prepare('SELECT * FROM host_rotation WHERE date = ?').get(date) || null;
}

export function saveRotation({ date, worker_id = null, host_url = '', link_token = null }) {
  db.prepare(`
    INSERT INTO host_rotation (date, worker_id, host_url, link_token, assigned_at)
    VALUES (:date, :worker_id, :host_url, :link_token, :assigned_at)
    ON CONFLICT(date) DO UPDATE SET
      worker_id = excluded.worker_id,
      host_url = excluded.host_url,
      link_token = excluded.link_token,
      assigned_at = excluded.assigned_at
  `).run({
    date,
    worker_id,
    host_url,
    link_token,
    assigned_at: new Date().toISOString(),
  });
  return getRotation(date);
}

export { STATUSES, PRIORITIES, AGENTS, NEEDS };

export { db };
