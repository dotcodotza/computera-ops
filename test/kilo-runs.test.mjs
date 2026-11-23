/* Proves the properties that make a long Kilo task safe:
 *   - a silent tool step is not mistaken for completion
 *   - a run keeps producing text with no HTTP view attached
 *   - partial text survives a stop
 *   - a run persisted as "running" is re-attached after a restart and finishes
 *   - Kilo being unreachable fails the run instead of hanging or crashing
 *
 * Run with: node --test test/kilo-runs.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import fs from 'fs-extra';
import { startMockKilo } from './mock-kilo.mjs';
import { createKiloRuns } from '../kilo-runs.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmpRunDir = () => fs.mkdtemp(path.join(os.tmpdir(), 'kilo-runs-'));

function makeRuns(kiloUrl, runDir, extra = {}) {
  return createKiloRuns({
    kiloUrl,
    directory: process.cwd(),
    runDir,
    log: { warn() {}, error() {}, log() {} },
    persistEveryMs: 0,
    pollActiveMs: 120,
    pollIdleMs: 200,
    ...extra,
  });
}

async function waitFor(check, message, timeoutMs = 10000) {
  const started = Date.now();
  for (;;) {
    if (check()) return;
    if (Date.now() - started > timeoutMs) throw new Error(message);
    await sleep(80);
  }
}

test('a silent tool step is not mistaken for completion', async () => {
  const mock = await startMockKilo({ gapMs: 1600, tailMs: 300, promptDelayMs: 100 });
  const runs = makeRuns(mock.url, await tmpRunDir());
  try {
    const { run } = await runs.start({ sessionId: 'ses_gap', prompt: 'first half|second half' });
    await waitFor(() => run.text.includes('first half'), 'first text never arrived');
    await sleep(900); // deep inside the silent gap, text unchanged
    assert.equal(run.status, 'running', 'run must still be running during a long tool step');
    assert.equal(run.text, 'first half');

    await waitFor(() => run.status === 'done', `run never completed (stuck ${run.status})`);
    assert.equal(run.text, 'first halfsecond half');
  } finally {
    runs.close();
    await mock.close();
  }
});

test('reads are incremental through offset, with no viewer attached', async () => {
  const mock = await startMockKilo({ gapMs: 400, tailMs: 100, promptDelayMs: 60 });
  const runs = makeRuns(mock.url, await tmpRunDir());
  try {
    const { run } = await runs.start({ sessionId: 'ses_offset', prompt: 'abcdef|ghijkl' });
    await waitFor(() => run.status === 'done', 'run never completed');

    const all = runs.snapshot(run, 0);
    assert.equal(all.text, 'abcdefghijkl');
    assert.equal(all.offset, 12);

    const tail = runs.snapshot(run, 6);
    assert.equal(tail.text, 'ghijkl', 'offset read must return only new text');
    assert.equal(tail.done, true);
  } finally {
    runs.close();
    await mock.close();
  }
});

test('starting a second run for a busy session reuses the running one', async () => {
  const mock = await startMockKilo({ gapMs: 900, tailMs: 150, promptDelayMs: 60 });
  const runs = makeRuns(mock.url, await tmpRunDir());
  try {
    const first = await runs.start({ sessionId: 'ses_busy', prompt: 'one|two' });
    const second = await runs.start({ sessionId: 'ses_busy', prompt: 'ignored' });
    assert.equal(second.reused, true);
    assert.equal(second.run.id, first.run.id, 'a busy session must not be prompted twice');
    await waitFor(() => first.run.status === 'done', 'run never completed');
  } finally {
    runs.close();
    await mock.close();
  }
});

test('stop keeps the text produced so far', async () => {
  const mock = await startMockKilo({ gapMs: 5000, tailMs: 100, promptDelayMs: 60 });
  const runs = makeRuns(mock.url, await tmpRunDir());
  try {
    const { run } = await runs.start({ sessionId: 'ses_stop', prompt: 'keep this|never arrives' });
    await waitFor(() => run.text.includes('keep this'), 'first text never arrived');
    runs.stop(run.id);
    assert.equal(run.status, 'stopped');
    assert.equal(run.text, 'keep this');

    await sleep(700); // Kilo was told to abort; no late text may land
    assert.equal(run.text, 'keep this');
  } finally {
    runs.close();
    await mock.close();
  }
});

test('a run persisted as running is re-attached after a restart and finishes', async () => {
  const mock = await startMockKilo({ gapMs: 900, tailMs: 150, promptDelayMs: 60 });
  const runDir = await tmpRunDir();
  try {
    // Kilo is already working on an answer...
    const session = await (await fetch(`${mock.url}/session`, { method: 'POST' })).json();
    await fetch(`${mock.url}/session/${session.id}/prompt_async`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parts: [{ type: 'text', text: 'before|after' }] }),
    });

    // ...and this process died mid-run, leaving only the record on disk.
    const startedMs = Date.now();
    await fs.writeJson(path.join(runDir, 'run_restart.json'), {
      id: 'run_restart', sessionId: session.id, prompt: 'before|after', agent: 'master', model: null,
      status: 'running', text: '', modelID: null, providerID: null, error: null,
      startedAt: new Date(startedMs).toISOString(), startedMs, updatedAt: new Date().toISOString(),
      lastTextAt: 0, waiting: false, knownIds: [],
    });

    const runs = makeRuns(mock.url, runDir);
    const count = await runs.restore();
    assert.equal(count, 1, 'the interrupted run should be re-attached');

    const restored = runs.get('run_restart');
    assert.ok(restored, 'restored run must be readable');
    await waitFor(() => restored.status === 'done', `restored run stuck in ${restored.status}`);
    assert.equal(restored.text, 'beforeafter');
    runs.close();
  } finally {
    await mock.close();
  }
});

test('Kilo being unreachable fails the run without crashing', async () => {
  const runs = makeRuns('http://127.0.0.1:9', await tmpRunDir(), { offlineGraceMs: 400 });
  try {
    await assert.rejects(
      () => runs.start({ sessionId: 'ses_down', prompt: 'hello' }),
      /Kilo/,
      'a dead Kilo must surface as a failed run',
    );
  } finally {
    runs.close();
  }
  // The registry is still usable afterwards.
  assert.equal(runs.activeRun('ses_down'), null);
});
