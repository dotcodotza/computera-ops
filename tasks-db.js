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
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

fs.ensureDirSync(DATA_DIR);

const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL;');
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
    last_message_id TEXT,
    last_run_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON tasks(due_date);
  CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
`);

const existingColumns = new Set(db.prepare('PRAGMA table_info(tasks)').all().map(c => c.name));
for (const [name, ddl] of [
  ['agent', "ALTER TABLE tasks ADD COLUMN agent TEXT NOT NULL DEFAULT 'master'"],
  ['last_message_id', 'ALTER TABLE tasks ADD COLUMN last_message_id TEXT'],
  ['last_run_at', 'ALTER TABLE tasks ADD COLUMN last_run_at TEXT'],
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
    validateEnum(filters.agent, AGENTS, 'agent');
    clauses.push('agent = :agent');
    params.agent = filters.agent;
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
    agent: validateEnum(input.agent, AGENTS, 'agent', 'master'),
    assignee: String(input.assignee || '').trim(),
    due_date: validateDueDate(input.due_date) ?? null,
    tags: normalizeTags(input.tags),
    kilo_session_id: input.kilo_session_id ? String(input.kilo_session_id) : null,
    last_message_id: input.last_message_id ? String(input.last_message_id) : null,
    last_run_at: input.last_run_at ? String(input.last_run_at) : null,
    created_at: now,
    updated_at: now,
  };
  db.prepare(`
    INSERT INTO tasks (id, title, description, status, priority, agent, assignee, due_date, tags,
                       kilo_session_id, last_message_id, last_run_at, created_at, updated_at)
    VALUES (:id, :title, :description, :status, :priority, :agent, :assignee, :due_date, :tags,
            :kilo_session_id, :last_message_id, :last_run_at, :created_at, :updated_at)
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
  if ('agent' in patch) next.agent = validateEnum(patch.agent, AGENTS, 'agent', current.agent);
  if ('assignee' in patch) next.assignee = String(patch.assignee || '').trim();
  if ('due_date' in patch) next.due_date = validateDueDate(patch.due_date) ?? null;
  if ('tags' in patch) next.tags = normalizeTags(patch.tags);
  if ('kilo_session_id' in patch) next.kilo_session_id = patch.kilo_session_id ? String(patch.kilo_session_id) : null;
  if ('last_message_id' in patch) next.last_message_id = patch.last_message_id ? String(patch.last_message_id) : null;
  if ('last_run_at' in patch) next.last_run_at = patch.last_run_at ? String(patch.last_run_at) : null;

  db.prepare(`
    UPDATE tasks SET title = :title, description = :description, status = :status, priority = :priority,
      agent = :agent, assignee = :assignee, due_date = :due_date, tags = :tags,
      kilo_session_id = :kilo_session_id, last_message_id = :last_message_id, last_run_at = :last_run_at,
      updated_at = :updated_at
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
    tags: Array.isArray(next.tags) ? normalizeTags(next.tags) : normalizeTags(next.tags),
    kilo_session_id: next.kilo_session_id,
    last_message_id: next.last_message_id,
    last_run_at: next.last_run_at,
    updated_at: new Date().toISOString(),
  });
  return getTask(id);
}

export function deleteTask(id) {
  const result = db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  if (!result.changes) throw new TaskError('task not found', 404);
  return true;
}

export { STATUSES, PRIORITIES, AGENTS };
