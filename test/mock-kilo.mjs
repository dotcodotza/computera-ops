/* A tiny stand-in for `kilo serve`, used by test/kilo-runs.test.mjs.
 *
 * It behaves like the real API in the ways the run registry depends on:
 *   POST /session                        -> { id }
 *   POST /session/:id/prompt_async       -> starts a scripted answer
 *   GET  /session/:id/message?directory= -> [{ info, parts }]
 *   GET  /event                          -> SSE: session.idle when finished
 *   POST /session/:id/abort              -> drops the scripted answer
 *   GET  /global/health                  -> { healthy: true }
 *
 * The answer has a deliberately long silent gap: text lands at t=0, then the
 * model is "inside a tool call" for GAP_MS with the last message unchanged, then
 * more text, then time.completed. A stability-based completion check would call
 * that done far too early.
 */
import { createServer } from 'http';

export async function startMockKilo({ gapMs = 1500, tailMs = 400, promptDelayMs = 150, complete = true } = {}) {
  const sessions = new Map();
  const clients = new Set();
  let seq = 0;

  const emit = (payload) => {
    const frame = `data: ${JSON.stringify(payload)}\n\n`;
    for (const res of clients) {
      try { res.write(frame); } catch { /* client went away */ }
    }
  };

  const sessionOf = (id) => {
    if (!sessions.has(id)) sessions.set(id, { messages: [], timers: [], aborted: false });
    return sessions.get(id);
  };

  function answer(sessionId, text) {
    const session = sessionOf(sessionId);
    session.aborted = false;
    const id = `msg_${++seq}`;
    const message = {
      info: { id, role: 'assistant', time: { created: Date.now() }, modelID: 'mock-model', providerID: 'kilo' },
      parts: [{ type: 'text', text: '' }],
    };
    session.messages.push(message);
    const timers = session.timers;

    timers.push(setTimeout(() => { message.parts[0].text = text.split('|')[0]; }, promptDelayMs));
    // The silent gap: nothing changes for gapMs while the "tool" runs.
    timers.push(setTimeout(() => {
      if (session.aborted) return;
      message.parts[0].text += text.split('|')[1] || '';
    }, promptDelayMs + gapMs));
    if (complete) {
      timers.push(setTimeout(() => {
        if (session.aborted) return;
        message.info.time.completed = Date.now();
        emit({ type: 'session.idle', properties: { sessionID: sessionId } });
      }, promptDelayMs + gapMs + tailMs));
    }
    return message;
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const send = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (req.method === 'POST' && url.pathname === '/session') {
      const id = `ses_${++seq}`;
      sessionOf(id);
      return send(200, { id, title: 'mock' });
    }
    if (req.method === 'GET' && url.pathname === '/global/health') {
      return send(200, { healthy: true });
    }
    if (req.method === 'GET' && url.pathname === '/event') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write(': connected\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    const prompt = url.pathname.match(/^\/session\/([^/]+)\/prompt_async$/);
    if (req.method === 'POST' && prompt) {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(body || '{}'); } catch { /* ignore */ }
        const text = (parsed.parts || []).map((p) => p.text || '').join('');
        answer(prompt[1], text);
        send(200, { ok: true });
      });
      return;
    }
    const abort = url.pathname.match(/^\/session\/([^/]+)\/abort$/);
    if (req.method === 'POST' && abort) {
      const session = sessionOf(abort[1]);
      session.aborted = true;
      for (const t of session.timers) clearTimeout(t);
      return send(200, { ok: true });
    }
    const messages = url.pathname.match(/^\/session\/([^/]+)\/message$/);
    if (req.method === 'GET' && messages) {
      return send(200, sessionOf(messages[1]).messages);
    }
    send(404, { error: 'not found' });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    sessions,
    close: () => new Promise((resolve) => {
      for (const res of clients) { try { res.end(); } catch {} }
      clients.clear();
      server.close(() => resolve());
    }),
  };
}

export default { startMockKilo };
