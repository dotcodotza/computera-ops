import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Worker } from 'worker_threads';
import { SQLITE_PRAGMAS, openSqlite } from '../tasks-db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '..', 'data');
const dbFile = path.join(dataDir, `lock-test-${process.pid}.db`);
const workerFile = path.join(dataDir, `lock-test-worker-${process.pid}.cjs`);

const WORKER_SOURCE = `
const { parentPort, workerData } = require('worker_threads');
const { DatabaseSync } = require('node:sqlite');

const conn = new DatabaseSync(workerData.file);
for (const pragma of workerData.pragmas) conn.exec(pragma);
const insert = conn.prepare('INSERT INTO events (id, detail, created_at) VALUES (?, ?, ?)');
const errors = [];
const sleeper = new Int32Array(new SharedArrayBuffer(4));

for (let i = 0; i < 120; i++) {
  try {
    insert.run(workerData.id + '-' + i, 'row ' + i, new Date().toISOString());
  } catch (err) {
    errors.push(err.message);
  }
  if (i % 5 === 0) Atomics.wait(sleeper, 0, 0, 1);
}

conn.close();
parentPort.postMessage({ errors });
`;

function runWorker(id) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerFile, {
      workerData: { id, file: dbFile, pragmas: SQLITE_PRAGMAS },
    });
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', (code) => { if (code !== 0) reject(new Error(`worker exited ${code}`)); });
  });
}

test('the configured pragmas let two connections write the same file without "database is locked"', async () => {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.rmSync(dbFile, { force: true });
  fs.writeFileSync(workerFile, WORKER_SOURCE);

  let setup = null;
  try {
    setup = openSqlite(dbFile);
    setup.exec('CREATE TABLE events (id TEXT PRIMARY KEY, detail TEXT, created_at TEXT)');

    const journal = setup.prepare('PRAGMA journal_mode').get();
    assert.equal(String(journal.journal_mode || journal['journal_mode']).toLowerCase(), 'wal');

    const timeout = setup.prepare('PRAGMA busy_timeout').get();
    assert.equal(Number(Object.values(timeout)[0]), 30000, 'writers wait instead of failing fast');

    const [a, b] = await Promise.all([runWorker('a'), runWorker('b')]);
    assert.deepEqual(a.errors, [], 'first writer never hit a lock');
    assert.deepEqual(b.errors, [], 'second writer never hit a lock');

    const count = setup.prepare('SELECT COUNT(*) AS n FROM events').get();
    assert.equal(Number(count.n), 240, 'both writers kept every row');
  } finally {
    try { setup?.close(); } catch { /* already closed */ }
    fs.rmSync(workerFile, { force: true });
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbFile + suffix, { force: true });
  }
});
