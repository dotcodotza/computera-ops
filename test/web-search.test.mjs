/* Exa web search: the SDK request shape, result normalization, and the
 * "no key" path that must not break the rest of the app.
 * Run with: node --test test/web-search.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { createWebSearch } from '../web-search.js';

const quiet = { warn() {} };

async function startExaStub(handler) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const call = { method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null };
      calls.push(call);
      handler(call, res);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, calls, url: `http://127.0.0.1:${server.address().port}` };
}

test('search sends highlights and returns normalized results', async () => {
  const stub = await startExaStub((call, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      requestId: 'req-1',
      resolvedSearchType: 'auto',
      results: [
        {
          id: 'https://example.com/a',
          title: 'Example A',
          url: 'https://example.com/a',
          publishedDate: '2026-01-02',
          author: 'Ada',
          score: 0.42,
          highlights: ['first excerpt', 'second excerpt'],
          highlightScores: [0.9, 0.8],
        },
        { url: 'https://example.com/b', highlights: null },
      ],
    }));
  });

  try {
    const webSearch = createWebSearch({ apiKey: 'test-key', baseURL: stub.url, log: quiet });
    assert.equal(webSearch.configured, true);

    const result = await webSearch.search('how do sqlite wal checkpoints work', { numResults: 500 });

    assert.equal(stub.calls.length, 1);
    const call = stub.calls[0];
    assert.equal(call.method, 'POST');
    assert.match(call.url, /\/search(\?|$)/);
    assert.equal(call.headers['x-api-key'], 'test-key');
    assert.equal(call.body.query, 'how do sqlite wal checkpoints work');
    assert.equal(call.body.contents.highlights, true);
    assert.equal(call.body.numResults, 20);

    assert.equal(result.requestId, 'req-1');
    assert.equal(result.searchType, 'auto');
    assert.equal(result.results.length, 2);
    assert.deepEqual(result.results[0], {
      title: 'Example A',
      url: 'https://example.com/a',
      publishedDate: '2026-01-02',
      author: 'Ada',
      highlights: ['first excerpt', 'second excerpt'],
      score: 0.42,
    });
    assert.deepEqual(result.results[1].highlights, []);
    assert.equal(result.results[1].title, 'https://example.com/b');
  } finally {
    stub.server.close();
  }
});

test('search passes domain filters through', async () => {
  const stub = await startExaStub((call, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ requestId: 'req-2', results: [] }));
  });
  try {
    const webSearch = createWebSearch({ apiKey: 'test-key', baseURL: stub.url, log: quiet });
    await webSearch.search('exa', { includeDomains: ['exa.ai'], excludeDomains: 'example.com' });
    assert.deepEqual(stub.calls[0].body.includeDomains, ['exa.ai']);
    assert.deepEqual(stub.calls[0].body.excludeDomains, ['example.com']);
  } finally {
    stub.server.close();
  }
});

test('without a key the search is unavailable but construction succeeds', async () => {
  const webSearch = createWebSearch({ apiKey: '', log: quiet });
  assert.equal(webSearch.configured, false);
  await assert.rejects(webSearch.search('anything'), (err) => err.status === 503 && /EXA_API_KEY/.test(err.message));
});

test('empty query and upstream errors are reported with a status', async () => {
  const stub = await startExaStub((call, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid API key', tag: 'INVALID_API_KEY' }));
  });
  try {
    const webSearch = createWebSearch({ apiKey: 'bad-key', baseURL: stub.url, log: quiet });
    await assert.rejects(webSearch.search('   '), (err) => err.status === 400);
    await assert.rejects(webSearch.search('sqlite'), (err) => err.status === 401);
  } finally {
    stub.server.close();
  }
});