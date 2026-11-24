/* Web search for the chat agent, powered by Exa (official SDK, exa-js).
 *
 * The key stays on this node: it comes from EXA_API_KEY, is never sent to the
 * browser, and is never written to the database or the logs. Results carry
 * highlights (the passages relevant to the query) rather than whole pages, which
 * is what a model needs to ground an answer and keeps responses small.
 */
import Exa from 'exa-js';

const DEFAULT_NUM_RESULTS = 8;
const MAX_NUM_RESULTS = 20;

function clampResults(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(MAX_NUM_RESULTS, Math.floor(n));
}

function domainList(value) {
  const list = Array.isArray(value) ? value : (value === undefined ? [] : [value]);
  return list.map((v) => String(v || '').trim()).filter(Boolean);
}

function httpError(message, status) {
  return Object.assign(new Error(message), { status });
}

// Exposed to the chat agent: this is the schema Ollama receives for tool calls.
export const WEB_SEARCH_TOOL = {
  type: 'function',
  function: {
    name: 'web_search',
    description: 'Search the web with Exa and return the most relevant pages with highlighted excerpts.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for, phrased as a question or topic.' },
        numResults: { type: 'integer', description: 'How many pages to return (1-20, default 8).', default: 8 }
      },
      required: ['query']
    }
  }
};

export function createWebSearch(options = {}) {
  const {
    apiKey = process.env.EXA_API_KEY,
    baseURL = process.env.EXA_BASE_URL,
    timeoutMs = 20000,
    numResults = DEFAULT_NUM_RESULTS,
    log = console,
  } = options;

  const key = String(apiKey || '').trim();
  // No key means the rest of the app still boots; the route answers 503 until it is set.
  const client = key ? new Exa(key, { baseURL, timeout: timeoutMs }) : null;

  function normalizeResult(result = {}) {
    return {
      title: result.title || result.url || '(untitled)',
      url: result.url || '',
      publishedDate: result.publishedDate || null,
      author: result.author || null,
      highlights: Array.isArray(result.highlights) ? result.highlights.filter(Boolean) : [],
      score: typeof result.score === 'number' ? result.score : null,
    };
  }

  /** Search the web and return the most relevant pages with highlight excerpts. */
  async function search(query, searchOptions = {}) {
    const q = String(query || '').trim();
    if (!q) throw httpError('query required', 400);
    if (!client) throw httpError('Web search is not configured: set EXA_API_KEY on this node', 503);

    const payload = {
      type: 'auto',
      numResults: clampResults(searchOptions.numResults, clampResults(numResults, DEFAULT_NUM_RESULTS)),
      contents: { highlights: true },
    };
    const includeDomains = domainList(searchOptions.includeDomains);
    const excludeDomains = domainList(searchOptions.excludeDomains);
    if (includeDomains.length) payload.includeDomains = includeDomains;
    if (excludeDomains.length) payload.excludeDomains = excludeDomains;
    if (searchOptions.category) payload.category = String(searchOptions.category);

    try {
      const response = await client.search(q, payload);
      return {
        query: q,
        requestId: response.requestId || null,
        searchType: response.resolvedSearchType || payload.type,
        results: (response.results || []).map(normalizeResult),
      };
    } catch (err) {
      const status = Number(err.statusCode) || (err.name === 'AbortError' ? 504 : 502);
      log.warn?.(`exa search failed (${status}): ${err.message}`);
      throw httpError(`Exa search failed: ${err.message}`, status);
    }
  }

  return { configured: !!client, search };
}

export default { createWebSearch, WEB_SEARCH_TOOL };