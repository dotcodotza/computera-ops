/* The engine proxies must stream, forward bodies, and fail cleanly.
 * Run with: node --test test/proxy.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import express from 'express';
import { createProxyHandler, stripHopByHopHeaders, buildTargetUrl } from '../proxy.js';

const quiet = { warn() {}, error() {} };

async function startUpstream() {
  const server = http.createServer((req, res) => {
    if (req.url === '/json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    }
    if (req.url === '/echo') {
      let body = '';
      req.on('data', (c) => { body += c; });
      return req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ method: req.method, body, token: req.headers['x-fleet-token'] || null }));
      });
    }
    if (req.url === '/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: one\n\n');
      setTimeout(() => { res.write('data: two\n\n'); res.end(); }, 300);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

async function startProxy(targetUrl) {
  const app = express();
  app.use('/proxy', createProxyHandler({ targetUrl, mountPath: '/proxy', log: quiet }));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

const close = (server) => new Promise((r) => server.close(r));

test('hop-by-hop headers are stripped, end-to-end headers kept', () => {
  const out = stripHopByHopHeaders({
    connection: 'keep-alive',
    'keep-alive': 'timeout=5',
    'transfer-encoding': 'chunked',
    upgrade: 'websocket',
    'content-type': 'application/json',
    cookie: 'a=b',
  });
  assert.deepEqual(out, { 'content-type': 'application/json', cookie: 'a=b' });
});

test('target urls are joined without doubling slashes', () => {
  assert.equal(buildTargetUrl('http://127.0.0.1:7777/', '/global/health'), 'http://127.0.0.1:7777/global/health');
  assert.equal(buildTargetUrl('http://127.0.0.1:7777', 'session'), 'http://127.0.0.1:7777/session');
  assert.equal(buildTargetUrl('http://127.0.0.1:7777', '/'), 'http://127.0.0.1:7777');
});

test('proxies a JSON response', async () => {
  const upstream = await startUpstream();
  const proxy = await startProxy(upstream.url);
  try {
    const res = await fetch(`${proxy.base}/proxy/json`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  } finally {
    await close(proxy.server);
    await close(upstream.server);
  }
});

test('streams the request body through and keeps the fleet token out of it', async () => {
  const upstream = await startUpstream();
  const proxy = await startProxy(upstream.url);
  try {
    const res = await fetch(`${proxy.base}/proxy/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Fleet-Token': 'secret-token' },
      body: JSON.stringify({ hello: 'world' }),
    });
    const data = await res.json();
    assert.equal(data.method, 'POST');
    assert.equal(data.body, '{"hello":"world"}');
    assert.equal(data.token, null, 'the fleet token must not leak to the engine');
  } finally {
    await close(proxy.server);
    await close(upstream.server);
  }
});

test('event streams are forwarded chunk by chunk, not buffered', async () => {
  const upstream = await startUpstream();
  const proxy = await startProxy(upstream.url);
  try {
    const started = Date.now();
    const res = await fetch(`${proxy.base}/proxy/stream`);
    assert.equal(res.status, 200);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const first = await reader.read();
    const firstAt = Date.now() - started;
    assert.match(decoder.decode(first.value), /data: one/);
    assert.ok(firstAt < 280, `first chunk took ${firstAt}ms — it was buffered`);
    let rest = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += decoder.decode(value, { stream: true });
    }
    assert.match(rest, /data: two/);
  } finally {
    await close(proxy.server);
    await close(upstream.server);
  }
});

test('an unreachable engine answers 502 instead of hanging', async () => {
  const proxy = await startProxy('http://127.0.0.1:9');
  try {
    const res = await fetch(`${proxy.base}/proxy/global/health`);
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.match(body.error, /unreachable/i);
  } finally {
    await close(proxy.server);
  }
});
