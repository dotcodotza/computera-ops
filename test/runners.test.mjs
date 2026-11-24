import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'url';
import {
  normalizeDshEvent,
  createDshRunner,
  createFleetRunner,
  createRunnerRegistry,
  createPreviewGuard,
} from '../runners.js';

const fixture = fileURLToPath(new URL('./fixtures/fake-dsh.mjs', import.meta.url));

function fakeRunner(options = {}) {
  return createDshRunner({
    command: process.execPath,
    commandArgs: [fixture],
    workdir: process.cwd(),
    taskTimeoutMs: 20000,
    ...options,
    env: { ...process.env, ...(options.env || {}) },
  });
}

test('dsh events normalise into feed rows', () => {
  const thinking = normalizeDshEvent({ type: 'thinking', thinking: 'Plan: read first' });
  assert.equal(thinking.kind, 'thinking');
  assert.equal(thinking.detail, 'Plan: read first');

  const call = normalizeDshEvent({ type: 'tool_call', name: 'read_file', arguments: { path: 'README.md' } });
  assert.equal(call.kind, 'tool');
  assert.match(call.message, /read_file/);
  assert.match(call.detail, /README\.md/);

  const result = normalizeDshEvent({ type: 'tool_result', name: 'read_file', status: 'completed', output: '# Title' });
  assert.equal(result.kind, 'tool_result');
  assert.match(result.detail, /# Title/);

  const failed = normalizeDshEvent({ type: 'tool_result', name: 'bash', error: { code: 'DENIED' } });
  assert.equal(failed.kind, 'tool_error');

  const final = normalizeDshEvent({ type: 'final', text: 'done', reason: { kind: 'completed' } });
  assert.equal(final.kind, 'result');
  assert.match(final.message, /completed/);

  const unknown = normalizeDshEvent({ type: 'whatever', message: 'hello' });
  assert.equal(unknown.kind, 'system');
  assert.equal(unknown.message, 'hello');
});

test('the dsh runner streams a task through stdin and returns the final answer', async () => {
  const events = [];
  const prompt = 'summarise the workspace';
  const outcome = await fakeRunner().run({
    prompt,
    step: { stage: 'research', role: 'worker' },
    onEvent: event => events.push(event),
  });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.engine, 'dsh');
  assert.equal(outcome.text, 'the finished answer');
  assert.equal(outcome.sessionId, 'session-test');

  const kinds = events.map(event => event.kind);
  assert.ok(kinds.includes('thinking'), 'reasoning reaches the feed');
  assert.ok(kinds.includes('tool'), 'tool calls reach the feed');
  assert.ok(kinds.includes('tool_result'), 'tool results reach the feed');
  assert.ok(kinds.includes('agent'), 'assistant text reaches the feed');
  assert.ok(kinds.includes('result'), 'the final event reaches the feed');
  assert.ok(
    events.some(event => /received \d+ chars/.test(event.message)),
    'the prompt is delivered on stdin',
  );
  assert.ok(events[0].message.includes('dsh'), 'the run announces its runner');
});

test('a failed dsh run reports the harness error', async () => {
  const outcome = await fakeRunner({ env: { FAKE_DSH_FAIL: '1' } }).run({
    prompt: 'anything',
    step: { stage: 'draft', role: 'worker' },
  });
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /model unavailable/);
});

test('the preview guardrail refuses to start on an unhealthy node', async () => {
  const guard = {
    url: 'http://127.0.0.1:3000/api/health',
    failuresToAbort: 3,
    check: async () => ({ ok: false, failures: 1 }),
  };
  const outcome = await fakeRunner({ previewGuard: guard }).run({ prompt: 'x', step: {} });
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /preview guardrail/);
});

test('a non-loopback dsh web bind is refused', async () => {
  const outcome = await fakeRunner({ profile: 'web', env: { DSH_HOST: '0.0.0.0' } }).run({ prompt: 'x', step: {} });
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /loopback only/);
});

test('the registry picks dsh first and falls back to the fleet', () => {
  const registry = createRunnerRegistry();
  registry.register({ name: 'dsh', kind: 'harness', available: () => true, run: async () => ({ ok: true, text: 'a' }) });
  registry.register(createFleetRunner({ dispatch: async () => ({ ok: true, text: 'b' }) }));

  assert.equal(registry.resolve('auto').name, 'dsh');
  assert.equal(registry.resolve('fleet').name, 'fleet');

  const noDsh = createRunnerRegistry();
  noDsh.register({ name: 'dsh', available: () => false, run: async () => ({ ok: false }) });
  noDsh.register(createFleetRunner({ dispatch: async () => ({ ok: true, text: 'b' }) }));
  assert.equal(noDsh.resolve('auto').name, 'fleet');
});

test('the fleet runner fails cleanly when a step has no task', async () => {
  const outcome = await createFleetRunner({ dispatch: async () => ({ ok: true, text: 'x' }) }).run({ step: {} });
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /task_id/);
});

test('the preview guard tracks consecutive failures', async () => {
  let healthy = false;
  const guard = createPreviewGuard({
    url: 'http://127.0.0.1:3000/api/health',
    fetchImpl: async () => ({ ok: healthy }),
  });
  assert.deepEqual(await guard.check(), { ok: false, failures: 1 });
  assert.deepEqual(await guard.check(), { ok: false, failures: 2 });
  healthy = true;
  assert.deepEqual(await guard.check(), { ok: true, failures: 0 });
});
