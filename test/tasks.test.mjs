import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createTask, getTask, listTasks, updateTask, deleteTask,
  TaskError, STATUSES, PRIORITIES, countActiveByWorker,
  recordEvent, listEvents, setSetting, getSetting, listSettings,
  getRotation, saveRotation,
} from '../tasks-db.js';

const createdIds = [];

function uniqueTitle(suffix) {
  return `test-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

test('createTask then getTask round trip', () => {
  const title = uniqueTitle('create');
  const task = createTask({
    title,
    description: 'a test task',
    priority: 'high',
    agent: 'it',
    assignee: 'Jonathan Ramalobela',
    due_date: '2026-11-20',
    tags: ['it', 'test'],
    needs: 'any',
  });
  assert.ok(task.id);
  assert.strictEqual(task.title, title);
  assert.strictEqual(task.description, 'a test task');
  assert.strictEqual(task.status, 'todo');
  assert.strictEqual(task.priority, 'high');
  assert.strictEqual(task.agent, 'it');
  assert.strictEqual(task.assignee, 'Jonathan Ramalobela');
  assert.strictEqual(task.due_date, '2026-11-20');
  assert.deepStrictEqual(task.tags, ['it', 'test']);
  assert.strictEqual(task.needs, 'any');
  assert.strictEqual(task.attempts, 0);
  assert.strictEqual(task.blocked_reason, null);
  assert.strictEqual(task.result, null);
  createdIds.push(task.id);

  const fetched = getTask(task.id);
  assert.ok(fetched);
  assert.strictEqual(fetched.title, title);
});

test('createTask validation errors', () => {
  assert.throws(() => createTask({}), TaskError);
  assert.throws(() => createTask({ title: '' }), TaskError);
  assert.throws(() => createTask({ title: '   ' }), TaskError);
  assert.throws(() => createTask({ title: 'x'.repeat(201) }), TaskError);
  assert.throws(() => createTask({ title: 't', status: 'bogus' }), TaskError);
  assert.throws(() => createTask({ title: 't', priority: 'bogus' }), TaskError);
  assert.throws(() => createTask({ title: 't', due_date: '20-11-2026' }), TaskError);
  assert.throws(() => createTask({ title: 't', agent: 'Bad Agent!' }), TaskError);
  assert.throws(() => createTask({ title: 't', needs: 'bogus' }), TaskError);
});

test('listTasks filters', () => {
  const t1 = createTask({ title: uniqueTitle('list1'), assignee: 'Alice', status: 'todo', agent: 'it' });
  const t2 = createTask({ title: uniqueTitle('list2'), assignee: 'Alice', status: 'done', agent: 'admin' });
  const t3 = createTask({ title: uniqueTitle('list3'), assignee: 'Bob', status: 'in_progress', agent: 'it' });
  const mine = [t1.id, t2.id, t3.id];
  createdIds.push(...mine);

  // Filter by this test's own ids only (createdIds also holds tasks from earlier tests).
  assert.strictEqual(listTasks({ status: 'todo' }).filter(t => mine.includes(t.id)).length, 1);
  assert.strictEqual(listTasks({ assignee: 'Alice' }).filter(t => mine.includes(t.id)).length, 2);
  assert.strictEqual(listTasks({ agent: 'it' }).filter(t => mine.includes(t.id)).length, 2);
  assert.strictEqual(listTasks({ q: 'list1' }).filter(t => mine.includes(t.id)).length, 1);
});

test('updateTask', () => {
  const task = createTask({ title: uniqueTitle('update'), status: 'todo' });
  createdIds.push(task.id);

  const updated = updateTask(task.id, { status: 'in_progress', priority: 'low', result: 'done result' });
  assert.strictEqual(updated.status, 'in_progress');
  assert.strictEqual(updated.priority, 'low');
  assert.strictEqual(updated.result, 'done result');
  assert.ok(updated.updated_at >= task.updated_at);

  assert.throws(() => updateTask('nope-id', { status: 'done' }), TaskError);
});

test('deleteTask', () => {
  const task = createTask({ title: uniqueTitle('delete') });
  assert.strictEqual(deleteTask(task.id), true);
  assert.strictEqual(getTask(task.id), null);
  assert.throws(() => deleteTask(task.id), TaskError);
});

test('countActiveByWorker', () => {
  const before = countActiveByWorker();
  const task = createTask({ title: uniqueTitle('active'), status: 'in_progress', assigned_worker: 'master' });
  createdIds.push(task.id);
  const after = countActiveByWorker();
  assert.ok(after.master >= (before.master || 0) + 1);
});

test('recordEvent and listEvents', () => {
  const before = listEvents(1).length;
  recordEvent('test_kind', 'test detail for computera tests', 'master');
  const events = listEvents(5);
  assert.ok(events.some(e => e.kind === 'test_kind' && e.detail === 'test detail for computera tests'));
  assert.ok(listEvents(1).length >= before);
});

test('settings get/set/list', () => {
  const key = `test_setting_${Date.now()}`;
  const saved = setSetting(key, 'hello');
  assert.strictEqual(saved.value, 'hello');
  const got = getSetting(key);
  assert.strictEqual(got.value, 'hello');
  const all = listSettings();
  assert.ok(all[key]);
  assert.strictEqual(all[key].value, 'hello');
});

test('rotation save and get', () => {
  const date = '2026-11-20';
  const saved = saveRotation({ date, worker_id: 'master', host_url: 'http://localhost:3000', link_token: 'tok123' });
  assert.strictEqual(saved.worker_id, 'master');
  assert.strictEqual(saved.link_token, 'tok123');
  const got = getRotation(date);
  assert.ok(got);
  assert.strictEqual(got.worker_id, 'master');
});

test('STATUSES and PRIORITIES constants', () => {
  assert.deepStrictEqual(STATUSES, ['todo', 'in_progress', 'review', 'done']);
  assert.deepStrictEqual(PRIORITIES, ['low', 'medium', 'high']);
});

test.after(async () => {
  for (const id of createdIds) {
    try { deleteTask(id); } catch {}
  }
});
