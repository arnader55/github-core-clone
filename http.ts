// http.ts — small shared helpers for the forge's HTTP surface.
//
// Every reply is JSON (except the git smart-HTTP bodies) and carries a
// non-empty X-GitHub-Request-Id. Error bodies are {"message": string}.

import { randomBytes } from 'node:crypto';

export function requestId() {
  return randomBytes(8).toString('hex');
}

/** A JSON response. `extraHeaders` are merged in (values must be strings). */
export function json(status, body, extraHeaders = {}) {
  const headers = {
    'content-type': 'application/json',
    'x-github-request-id': requestId(),
    ...extraHeaders,
  };
  return { status, headers, body: Buffer.from(JSON.stringify(body), 'utf8') };
}

/** A JSON response from an already-serialized body (fresh request id each time). */
export function jsonText(status, text, extraHeaders = {}) {
  const headers = {
    'content-type': 'application/json',
    'x-github-request-id': requestId(),
    ...extraHeaders,
  };
  return { status, headers, body: Buffer.from(text, 'utf8') };
}

/** A JSON error response: {"message": string}. */
export function error(status, message, extraHeaders = {}) {
  return json(status, { message }, extraHeaders);
}

/** An empty response (204, 404 with no body is still JSON for the REST surface). */
export function empty(status, extraHeaders = {}) {
  const headers = { 'x-github-request-id': requestId(), ...extraHeaders };
  return { status, headers, body: Buffer.alloc(0) };
}

/**
 * Paginate `items` by `page`/`per_page` and build a GitHub-style Link header.
 * `baseUrl` is the absolute URL of this page without its query string.
 */
export function paginate(items, query, baseUrl) {
  const perPageRaw = Number.parseInt(query.get('per_page') ?? '30', 10);
  const perPage = Number.isFinite(perPageRaw) ? Math.min(Math.max(perPageRaw, 1), 100) : 30;
  const pageRaw = Number.parseInt(query.get('page') ?? '1', 10);
  const page = Number.isFinite(pageRaw) ? Math.max(pageRaw, 1) : 1;
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const start = (page - 1) * perPage;
  const pageItems = items.slice(start, start + perPage);
  const linkFor = (p, rel) => {
    const url = new URL(baseUrl);
    url.searchParams.set('page', String(p));
    url.searchParams.set('per_page', String(perPage));
    return `<${url.toString()}>; rel="${rel}"`;
  };
  const links = [];
  if (page < totalPages) links.push(linkFor(page + 1, 'next'));
  if (page > 1) links.push(linkFor(page - 1, 'prev'));
  links.push(linkFor(1, 'first'));
  links.push(linkFor(totalPages, 'last'));
  return {
    items: pageItems,
    headers: links.length > 0 ? { link: links.join(', ') } : {},
    page,
    perPage,
    total,
    totalPages,
  };
}

/** Read a request body as JSON, or throw a 400-shaped error when it is malformed. */
export function parseJsonBody(body) {
  if (body === null || body.length === 0) return {};
  try {
    const parsed = JSON.parse(body.toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    const err = new Error('Problems parsing JSON');
    err.status = 400;
    throw err;
  }
}
