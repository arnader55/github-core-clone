// app.ts — the forge's HTTP server: routing, auth, request ids.
//
// Route order: the health probe, then auth, then REST v3, GraphQL v4, MCP,
// and the git smart-HTTP surface. Every reply is JSON (except the git bodies)
// with a non-empty X-GitHub-Request-Id. A request without a bearer token that
// matches MAKEFUN_SHOP_TOKEN gets 401 on every route except the public ones
// (GET /healthz, GET /, GET /api/v3/ and GET /api/v3/meta).

import { createServer } from 'node:http';
import { createStore } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleGit } from './githttp.ts';
import { json, error } from './http.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

export function createApp(options = {}) {
  const store = createStore();
  const token = options.token ?? process.env.MAKEFUN_SHOP_TOKEN ?? null;
  const server = createServer((nodeReq, nodeRes) => {
    readRequest(nodeReq)
      .then((req) => {
        let response;
        try {
          response = route(store, req, token);
        } catch (err) {
          if (err && typeof err.status === 'number') {
            response = error(err.status, err.message || 'Bad Request');
          } else {
            console.error(err);
            response = error(500, 'Internal Server Error');
          }
        }
        nodeRes.writeHead(response.status, response.headers);
        nodeRes.end(response.body);
      })
      .catch(() => {
        nodeRes.writeHead(413, { 'content-type': 'application/json' });
        nodeRes.end(JSON.stringify({ message: 'Request body too large' }));
      });
  });
  return { server, store };
}

function readRequest(nodeReq) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    nodeReq.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        return;
      }
      chunks.push(chunk);
    });
    nodeReq.on('end', () => {
      const host = nodeReq.headers.host ?? '127.0.0.1';
      const url = new URL(nodeReq.url ?? '/', `http://${host}`);
      const headers = {};
      for (const [key, value] of Object.entries(nodeReq.headers)) {
        headers[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
      }
      resolve({
        method: nodeReq.method ?? 'GET',
        pathname: url.pathname,
        query: url.searchParams,
        headers,
        body: chunks.length > 0 ? Buffer.concat(chunks) : null,
        baseUrl: `http://${host}/api/v3`,
      });
    });
    nodeReq.on('error', reject);
  });
}

function isPublic(method, pathname) {
  if (method === 'GET' && pathname === '/healthz') return true;
  if (method === 'GET' && pathname === '/') return true;
  if (method === 'GET' && (pathname === '/api/v3' || pathname === '/api/v3/')) return true;
  if (method === 'GET' && pathname === '/api/v3/meta') return true;
  return false;
}

function authorized(req, token) {
  if (token === null || token === undefined || token === '') return true;
  const header = req.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/.exec(header);
  return match !== null && match[1] === token;
}

function route(store, req, token) {
  if (req.pathname === '/healthz' && req.method === 'GET') {
    return json(200, { status: 'ok' });
  }
  if (!isPublic(req.method, req.pathname) && !authorized(req, token)) {
    return error(401, 'Requires authentication');
  }
  const rest = handleRest(store, req);
  if (rest !== null) return rest;
  const graphql = handleGraphql(store, req);
  if (graphql !== null) return graphql;
  const mcp = handleMcp(store, req);
  if (mcp !== null) return mcp;
  const git = handleGit(store, req);
  if (git !== null) return git;
  return error(404, 'Not Found');
}
