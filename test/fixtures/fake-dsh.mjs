// Stand-in for `dsh --profile headless --json` in tests: reads the task from
// stdin and writes the same NDJSON event vocabulary as the real harness.
const chunks = [];
process.stdin.on('data', chunk => chunks.push(chunk));
process.stdin.on('end', () => {
  const prompt = Buffer.concat(chunks).toString();
  const emit = record => process.stdout.write(JSON.stringify(record) + '\n');

  emit({ type: 'session', sessionId: 'session-test' });
  emit({ type: 'status', status: `received ${prompt.length} chars` });
  emit({ type: 'thinking', thinking: 'Plan: read the file, then answer.' });
  emit({ type: 'tool_call', name: 'read_file', arguments: { path: 'README.md' } });
  emit({ type: 'tool_result', name: 'read_file', status: 'completed', output: '# Title' });

  if (process.env.FAKE_DSH_FAIL === '1') {
    emit({ type: 'error', message: 'model unavailable' });
    process.exitCode = 1;
    return;
  }

  emit({ type: 'text', text: 'the finished answer' });
  emit({ type: 'final', text: 'the finished answer', reason: { kind: 'completed' }, sessionId: 'session-test' });
});
