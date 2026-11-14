// mcp.ts — the MCP surface (POST /mcp, JSON-RPC 2.0, streamable HTTP).
//
// Modern era 2026-07-28 (revision in _meta, MCP-Protocol-Version header,
// Mcp-Method / Mcp-Name headers) and the legacy era (initialize +
// notifications/initialized) are both answered. Tools act on the same store
// as REST, so an issue created over MCP is visible over REST and vice versa.
//
// Tool results carry BOTH content:[{type:'text', text: JSON.stringify(obj)}]
// AND structuredContent: obj. An unknown tool is a JSON-RPC -32601, never
// HTTP 500; a call missing required arguments is isError:true. A non-JSON
// body is HTTP 400 with -32700 (id null). No Authorization header is 401
// (enforced by app.ts). tools/list is a module-level constant, so two calls
// are byte-identical.

import {
  VIEWER, iso, globalId,
  getRepo, createRepo, listViewerRepos,
  createIssue, createPull, getItem, listItems, mergePull,
} from './store.ts';
import { json, error } from './http.ts';

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2025-11-25', '2026-07-28'];
const LATEST_VERSION = '2026-07-28';

// -------------------------------------------------------------------------------------------
// tools (a constant: two tools/list calls must be byte-identical)
// -------------------------------------------------------------------------------------------

export const TOOLS = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name of the repository.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        full_name: { type: 'string', description: 'The full name of the repository, "owner/repo".' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'list_repos',
    description: 'List the repositories owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        full_name: { type: 'string', description: 'The full name of the repository, "owner/repo".' },
        title: { type: 'string', description: 'The title of the issue.' },
        body: { type: 'string', description: 'The body of the issue.' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Labels to apply to the issue.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get an issue or pull request by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        full_name: { type: 'string', description: 'The full name of the repository, "owner/repo".' },
        issue_number: { type: 'integer', description: 'The issue or pull request number.' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        full_name: { type: 'string', description: 'The full name of the repository, "owner/repo".' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        full_name: { type: 'string', description: 'The full name of the repository, "owner/repo".' },
        title: { type: 'string', description: 'The title of the pull request.' },
        body: { type: 'string', description: 'The body of the pull request.' },
        head: { type: 'string', description: 'The head branch (with the changes).' },
        base: { type: 'string', description: 'The base branch (to merge into).' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List the pull requests of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        full_name: { type: 'string', description: 'The full name of the repository, "owner/repo".' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        full_name: { type: 'string', description: 'The full name of the repository, "owner/repo".' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

// -------------------------------------------------------------------------------------------
// serializers (the same ids as the REST surface, so MCP and REST agree)
// -------------------------------------------------------------------------------------------

function repoJson(repo) {
  return {
    id: repo.dbId,
    node_id: globalId('R', repo.dbId),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: iso(repo.createdAt),
    updated_at: iso(repo.updatedAt),
  };
}

function itemJson(repo, item) {
  const base = {
    id: item.id,
    node_id: globalId(item.kind === 'pull' ? 'PR' : 'I', repo.owner, repo.name, item.number),
    number: item.number,
    title: item.title,
    body: item.body,
    state: item.state,
    labels: item.labels,
    created_at: iso(item.createdAt),
    updated_at: iso(item.updatedAt),
    closed_at: item.closedAt ? iso(item.closedAt) : null,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
  };
  if (item.kind === 'pull') {
    return {
      ...base,
      head: { ref: item.head.ref, sha: item.head.sha, label: `${repo.owner}:${item.head.ref}` },
      base: { ref: item.base.ref, sha: item.base.sha, label: `${repo.owner}:${item.base.ref}` },
      merged: item.merged,
      merged_at: item.mergedAt ? iso(item.mergedAt) : null,
      merge_commit_sha: item.mergeCommitSha,
    };
  }
  return base;
}

/** Resolve a repo from (owner, repo) or from a full_name "owner/repo". */
function resolveRepo(store, args) {
  let owner = args.owner;
  let repoName = args.repo;
  if ((!owner || !repoName) && typeof args.full_name === 'string') {
    const parts = args.full_name.split('/');
    if (parts.length === 2) {
      owner = owner ?? parts[0];
      repoName = repoName ?? parts[1];
    }
  }
  if (!owner || !repoName) return { error: 'owner and repo are required (or full_name as "owner/repo")' };
  const repo = getRepo(store, owner, repoName);
  if (!repo) return { error: `Repository not found: ${owner}/${repoName}` };
  return { repo };
}

function missingArgs(tool, args) {
  const def = TOOLS.find((t) => t.name === tool);
  if (!def) return [];
  return def.inputSchema.required.filter((key) => {
    const value = args[key];
    return value === undefined || value === null || value === '';
  });
}

// -------------------------------------------------------------------------------------------
// tool dispatch
// -------------------------------------------------------------------------------------------

function callTool(store, name, args) {
  // Returns {result} or {error} (a plain message for an isError result).
  const missing = missingArgs(name, args);
  if (missing.length > 0) {
    return { error: `Missing required arguments: ${missing.join(', ')}` };
  }
  switch (name) {
    case 'create_repo': {
      const result = createRepo(store, {
        name: args.name,
        isPrivate: args.private === true,
        description: args.description ?? '',
        defaultBranch: 'main',
      });
      if (result.error === 'duplicate') return { error: 'Repository already exists' };
      if (result.error) return { error: 'Repository name is invalid' };
      return { result: repoJson(result.repo) };
    }
    case 'get_repo': {
      const resolved = resolveRepo(store, args);
      if (resolved.error) return { error: resolved.error };
      return { result: repoJson(resolved.repo) };
    }
    case 'list_repos': {
      return { result: { repos: listViewerRepos(store).map((repo) => repoJson(repo)) } };
    }
    case 'create_issue': {
      const resolved = resolveRepo(store, args);
      if (resolved.error) return { error: resolved.error };
      const result = createIssue(store, resolved.repo, {
        title: args.title,
        body: args.body ?? '',
        labels: Array.isArray(args.labels) ? args.labels.map((l) => (typeof l === 'string' ? l : l.name)) : [],
      });
      if (result.error === 'unknown-label') return { error: `Label does not exist: ${result.label}` };
      return { result: itemJson(resolved.repo, result.item) };
    }
    case 'get_issue': {
      const resolved = resolveRepo(store, args);
      if (resolved.error) return { error: resolved.error };
      const item = getItem(resolved.repo, Number(args.issue_number));
      if (!item) return { error: `Issue not found: ${args.issue_number}` };
      return { result: itemJson(resolved.repo, item) };
    }
    case 'list_issues': {
      const resolved = resolveRepo(store, args);
      if (resolved.error) return { error: resolved.error };
      const state = args.state ?? 'open';
      const items = listItems(resolved.repo, { state, sort: 'created', direction: 'desc', kind: 'issue' });
      return { result: { issues: items.map((item) => itemJson(resolved.repo, item)) } };
    }
    case 'create_pull_request': {
      const resolved = resolveRepo(store, args);
      if (resolved.error) return { error: resolved.error };
      const result = createPull(store, resolved.repo, {
        title: args.title,
        body: args.body ?? '',
        head: String(args.head),
        base: String(args.base),
      });
      if (result.error === 'duplicate-open-pr') return { error: 'A pull request already exists for this head branch' };
      if (result.error === 'unknown-branch') return { error: 'Head or base branch does not exist' };
      return { result: itemJson(resolved.repo, result.item) };
    }
    case 'list_pull_requests': {
      const resolved = resolveRepo(store, args);
      if (resolved.error) return { error: resolved.error };
      const state = args.state ?? 'open';
      const items = listItems(resolved.repo, { state, sort: 'created', direction: 'desc', kind: 'pull' });
      return { result: { pull_requests: items.map((item) => itemJson(resolved.repo, item)) } };
    }
    case 'merge_pull_request': {
      const resolved = resolveRepo(store, args);
      if (resolved.error) return { error: resolved.error };
      const item = getItem(resolved.repo, Number(args.pull_number));
      if (!item || item.kind !== 'pull') return { error: `Pull request not found: ${args.pull_number}` };
      const result = mergePull(resolved.repo, item, 'squash');
      if (result.error === 'conflicted') return { error: 'Pull request is not mergeable' };
      if (result.error === 'not-open') return { error: 'Pull request is not open' };
      if (result.error) return { error: 'Could not merge pull request' };
      return { result: { merged: true, sha: result.sha, message: result.message } };
    }
    default:
      return { error: null, unknownTool: true };
  }
}

// -------------------------------------------------------------------------------------------
// JSON-RPC
// -------------------------------------------------------------------------------------------

function rpcResult(id, result) {
  return json(200, { jsonrpc: '2.0', id, result });
}

function rpcError(id, code, message) {
  return json(200, { jsonrpc: '2.0', id, error: { code, message } });
}

export function handleMcp(store, req) {
  if (req.pathname !== '/mcp' || req.method !== 'POST') return null;
  let body;
  try {
    body = JSON.parse((req.body ?? Buffer.alloc(0)).toString('utf8'));
  } catch {
    // Non-JSON body: HTTP 400 with -32700 (id null).
    return {
      status: 400,
      headers: { 'content-type': 'application/json', 'x-github-request-id': 'mcp-parse-error' },
      body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }), 'utf8'),
    };
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { status: 400, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }), 'utf8') };
  }
  const id = body.id === undefined ? null : body.id;
  const method = body.method;
  const params = body.params ?? {};
  // A notification has no id: acknowledge it and send nothing back.
  const isNotification = body.id === undefined;
  if (isNotification) {
    return { status: 202, headers: { 'content-type': 'application/json' }, body: Buffer.alloc(0) };
  }
  if (typeof method !== 'string') {
    return rpcError(id, -32600, 'Invalid Request');
  }
  if (method === 'server/discover') {
    const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
    return rpcResult(id, {
      supportedVersions: SUPPORTED_VERSIONS,
      protocolVersion: LATEST_VERSION,
      capabilities: { tools: {} },
      serverInfo,
      _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
    });
  }
  if (method === 'initialize') {
    const requested = params.protocolVersion;
    const protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : LATEST_VERSION;
    return rpcResult(id, {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (method === 'ping') {
    return rpcResult(id, {});
  }
  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS });
  }
  if (method === 'tools/call') {
    const name = params.name;
    const args = params.arguments ?? {};
    if (typeof name !== 'string') return rpcError(id, -32602, 'Invalid params: name is required');
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) return rpcError(id, -32601, `Unknown tool: ${name}`);
    const outcome = callTool(store, name, args && typeof args === 'object' ? args : {});
    if (outcome.unknownTool) return rpcError(id, -32601, `Unknown tool: ${name}`);
    if (outcome.error) {
      return rpcResult(id, {
        content: [{ type: 'text', text: outcome.error }],
        structuredContent: { error: outcome.error },
        isError: true,
      });
    }
    return rpcResult(id, {
      content: [{ type: 'text', text: JSON.stringify(outcome.result) }],
      structuredContent: outcome.result,
    });
  }
  return rpcError(id, -32601, `Method not found: ${method}`);
}
