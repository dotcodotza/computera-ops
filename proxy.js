/* Reverse proxy for this node's engines (/proxy/kilo, /proxy/ollama).
 *
 * Both engines answer with event streams (Kilo's /event, Ollama's NDJSON chat),
 * so the response must be forwarded chunk by chunk and never buffered. Requests
 * are streamed too, which is why these routes are mounted before express.json():
 * a body that has already been parsed cannot be forwarded.
 */
import { once } from 'events';

// RFC 7230 hop-by-hop headers must not be passed through a proxy.
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

export function stripHopByHopHeaders(headers = {}) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    const name = key.toLowerCase();
    if (HOP_BY_HOP.has(name)) continue;
    if (value === undefined) continue;
    out[name] = value;
  }
  return out;
}

export function buildTargetUrl(baseUrl, path) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const suffix = !path || path === '/' ? '' : (path.startsWith('/') ? path : '/' + path);
  return base + suffix;
}

/**
 * Forward `req` to `targetUrl` and stream the answer back.
 * Returns the upstream status code, or 502/504 when it could not be reached.
 */
export async function proxyRequest(req, res, options = {}) {
  const {
    targetUrl,
    path,
    headers = {},
    timeoutMs = 10 * 60 * 1000,
    log = console,
  } = options;

  const url = buildTargetUrl(targetUrl, path ?? req.url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let clientGone = false;

  const onClose = () => { if (!res.writableEnded) { clientGone = true; controller.abort(); } };
  res.on('close', onClose);

  try {
    const sendBody = !['GET', 'HEAD'].includes(String(req.method || 'GET').toUpperCase());
    const forwarded = stripHopByHopHeaders(req.headers);
    // The upstream answers in the identity encoding; we forward the bytes as they
    // are, so the length/encoding headers from either side cannot be trusted.
    forwarded['accept-encoding'] = 'identity';
    delete forwarded['content-length'];
    delete forwarded.host;
    delete forwarded['x-fleet-token'];
    Object.assign(forwarded, stripHopByHopHeaders(headers));

    const upstream = await fetch(url, {
      method: req.method,
      headers: forwarded,
      body: sendBody ? req : undefined,
      duplex: sendBody ? 'half' : undefined,
      redirect: 'manual',
      signal: controller.signal,
    });

    const outHeaders = stripHopByHopHeaders(Object.fromEntries(upstream.headers.entries()));
    delete outHeaders['content-encoding'];
    delete outHeaders['content-length'];
    res.status(upstream.status);
    res.setHeader('X-Accel-Buffering', 'no');
    for (const [key, value] of Object.entries(outHeaders)) {
      try { res.setHeader(key, value); } catch { /* invalid upstream header */ }
    }
    res.flushHeaders?.();

    if (!upstream.body) {
      res.end();
      return upstream.status;
    }

    for await (const chunk of upstream.body) {
      if (clientGone || res.writableEnded || res.destroyed) { controller.abort(); break; }
      if (!res.write(chunk)) {
        try { await once(res, 'drain', { signal: controller.signal }); } catch { break; }
      }
    }
    if (!res.writableEnded) res.end();
    return upstream.status;
  } catch (err) {
    const timedOut = err?.name === 'AbortError';
    if (!clientGone && !res.headersSent) {
      res.status(timedOut ? 504 : 502).json({
        error: timedOut ? `Upstream timed out after ${Math.round(timeoutMs / 1000)}s` : `Upstream unreachable: ${err.message}`,
      });
    } else if (!res.writableEnded) {
      try { res.end(); } catch { /* socket already gone */ }
    }
    if (!clientGone) log.warn?.(`proxy ${url} failed: ${err.message}`);
    return timedOut ? 504 : 502;
  } finally {
    clearTimeout(timer);
    res.off('close', onClose);
  }
}

/** Express handler bound to one upstream. */
export function createProxyHandler({ targetUrl, mountPath, headers, timeoutMs, log } = {}) {
  const prefix = mountPath ? mountPath.replace(/\/+$/, '') : '';
  return (req, res) => {
    const path = prefix && req.originalUrl.startsWith(prefix)
      ? req.originalUrl.slice(prefix.length)
      : req.originalUrl;
    proxyRequest(req, res, { targetUrl, headers, timeoutMs, log, path }).catch((err) => {
      log?.warn?.(`proxy handler failed: ${err.message}`);
      if (!res.headersSent) res.status(502).json({ error: err.message });
    });
  };
}

export default { proxyRequest, createProxyHandler, buildTargetUrl, stripHopByHopHeaders };
