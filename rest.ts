// rest.ts — the REST v3 surface (/api/v3).
//
// Every reply is JSON with a non-empty X-GitHub-Request-Id (added by http.ts),
// 4xx bodies are {"message": string}, unknown routes are 404 JSON, malformed
// JSON bodies are 400, no token is 401 (enforced by app.ts), and a repo name
// under another owner is 404, never 403.
//
// `handleRest(store, req)` returns a response object or null when the path is
// not a REST route (so app.ts can try the next surface).

import {
  VIEWER, EPOCH_SEC, iso, globalId,
  getRepo, createRepo, deleteRepo, listViewerRepos,
  lookupObject, commitInfo, peel, resolveRef,
  listBranches, listAdvertisedRefs, getRef, setRef,
  commitPath, listCommits, flattenTree, lookupPath, listDirectory,
  createIssue, createPull, getItem, listItems, addComment,
  pullFiles, mergePull, mergeableState,
} from './store.ts';
import { json, error, empty, paginate, parseJsonBody } from './http.ts';
import { isObjectId, parseCommit, parseTree } from './gitwire.ts';

const INSTALLED_VERSION = '2.0.0';

function repoJson(repo, baseUrl) {
  return {
    id: repo.dbId,
    node_id: globalId('R', repo.dbId),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, node_id: globalId('U', VIEWER.id), type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: iso(repo.createdAt),
    updated_at: iso(repo.updatedAt),
    pushed_at: iso(repo.updatedAt),
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `${baseUrl}/repos/${repo.owner}/${repo.name}`,
    fork: false,
    archived: false,
    disabled: false,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    has_downloads: true,
    license: null,
    visibility: repo.private ? 'private' : 'public',
    open_issues_count: [...repo.items.values()].filter((i) => i.kind === 'issue' && i.state === 'open').length,
  };
}

function labelJson(label, repo, baseUrl) {
  return {
    id: label.id ?? 0,
    node_id: globalId('L', repo.dbId, label.name),
    url: `${baseUrl}/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    description: label.description ?? '',
    default: true,
  };
}

function userJson() {
  return {
    login: VIEWER.login,
    id: VIEWER.id,
    node_id: globalId('U', VIEWER.id),
    type: 'User',
    name: VIEWER.name,
    email: VIEWER.email,
    html_url: `https://github.com/${VIEWER.login}`,
  };
}

function itemJson(repo, item, baseUrl) {
  const labels = item.labels.map((name) => {
    const label = repo.labels.get(name);
    return label ? labelJson(label, repo, baseUrl) : { name, color: '000000', description: '' };
  });
  const base = {
    id: item.id,
    node_id: globalId(item.kind === 'pull' ? 'PR' : 'I', repo.owner, repo.name, item.number),
    number: item.number,
    title: item.title,
    body: item.body,
    state: item.state,
    state_reason: item.state === 'closed' ? (item.merged ? 'completed' : 'not_planned') : null,
    labels,
    created_at: iso(item.createdAt),
    updated_at: iso(item.updatedAt),
    closed_at: item.closedAt ? iso(item.closedAt) : null,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${item.number}`,
    url: `${baseUrl}/repos/${repo.owner}/${repo.name}/issues/${item.number}`,
    comments: item.comments.length,
  };
  if (item.kind === 'pull') {
    return {
      ...base,
      head: { ref: item.head.ref, sha: item.head.sha, label: `${repo.owner}:${item.head.ref}` },
      base: { ref: item.base.ref, sha: item.base.sha, label: `${repo.owner}:${item.base.ref}` },
      merged: item.merged,
      merged_at: item.mergedAt ? iso(item.mergedAt) : null,
      merge_commit_sha: item.mergeCommitSha,
      mergeable: mergeableState(repo, item) === 'MERGEABLE',
      mergeable_state: mergeableState(repo, item).toLowerCase(),
      draft: false,
      pull_request: { url: `${baseUrl}/repos/${repo.owner}/${repo.name}/pulls/${item.number}` },
    };
  }
  return base;
}

function commentJson(repo, item, comment, baseUrl) {
  return {
    id: comment.id,
    node_id: globalId('C', repo.owner, repo.name, item.number, comment.id),
    body: comment.body,
    created_at: iso(comment.createdAt),
    updated_at: iso(comment.createdAt),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${item.number}#issuecomment-${comment.id}`,
    url: `${baseUrl}/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
  };
}

function parseIdentity(line) {
  // "ada iversen <adaiversen@example.invalid> 1735689600 +0000"
  const match = /^(.*) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line ?? '');
  if (!match) return { name: '', email: '', date: iso(EPOCH_SEC) };
  return { name: match[1], email: match[2], date: iso(Number(match[3])) };
}

function commitJson(repo, oid) {
  const object = repo.objects.get(oid);
  const meta = commitInfo(repo, oid);
  const parsed = object ? parseCommit(object.data) : null;
  const author = parseIdentity(parsed?.author ?? '');
  const committer = parseIdentity(parsed?.committer ?? '');
  return {
    sha: oid,
    node_id: globalId('C', oid),
    commit: {
      message: parsed ? parsed.message : '',
      tree: { sha: meta ? meta.tree : '' },
      author: { name: author.name, email: author.email, date: author.date },
      committer: { name: committer.name, email: committer.email, date: committer.date },
    },
    parents: (meta ? meta.parents : []).map((parent) => ({ sha: parent })),
    author: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    committer: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
  };
}

/** The ref the suite means by a branch name in a git/refs path. */
function normalizeRef(ref) {
  if (ref.startsWith('refs/')) return ref;
  if (ref.startsWith('heads/') || ref.startsWith('tags/')) return `refs/${ref}`;
  return `refs/heads/${ref}`;
}

export function handleRest(store, req) {
  const { method, pathname, query } = req;
  const baseUrl = req.baseUrl; // e.g. http://127.0.0.1:PORT/api/v3
  const api = '/api/v3';
  if (!pathname.startsWith(api)) return null;
  const path = pathname.slice(api.length) || '/';
  const segments = path.split('/').filter((s) => s.length > 0);

  // ---- API root and meta (public) --------------------------------------
  if (path === '/' && method === 'GET') {
    return json(200, {
      current_user_url: `${baseUrl}/user`,
      repository_url: `${baseUrl}/repos/{owner}/{repo}`,
      user_repositories_url: `${baseUrl}/user/repos`,
      meta_url: `${baseUrl}/meta`,
    }, { 'x-oauth-scopes': 'repo, read:org' });
  }
  if (path === '/meta' && method === 'GET') {
    return json(200, { installed_version: INSTALLED_VERSION });
  }

  // ---- /user ------------------------------------------------------------
  if (path === '/user' && method === 'GET') return json(200, userJson());
  if (path === '/user/repos' && method === 'GET') {
    const repos = listViewerRepos(store);
    const page = paginate(repos, query, `${baseUrl}/user/repos`);
    return json(200, page.items.map((repo) => repoJson(repo, baseUrl)), page.headers);
  }
  if (path === '/user/repos' && method === 'POST') {
    const body = parseJsonBody(req.body);
    const result = createRepo(store, {
      name: body.name,
      isPrivate: body.private === true,
      description: body.description ?? '',
      defaultBranch: body.default_branch ?? 'main',
    });
    if (result.error === 'duplicate') return error(422, 'Repository creation failed. name already exists on this account');
    if (result.error) return error(422, 'Repository creation failed. name is invalid');
    return json(201, repoJson(result.repo, baseUrl));
  }

  // ---- /repos/{owner}/{repo}/... ----------------------------------------
  if (segments[0] !== 'repos' || segments.length < 3) {
    if (segments.length === 0) return null;
    return error(404, 'Not Found');
  }
  const owner = decodeURIComponent(segments[1]);
  const repoName = decodeURIComponent(segments[2]);
  const repo = getRepo(store, owner, repoName);
  if (repo === null) return error(404, 'Not Found');
  const rest = segments.slice(3);
  const repoUrl = `${baseUrl}/repos/${owner}/${repoName}`;

  // GET / PATCH / DELETE the repo itself.
  if (rest.length === 0) {
    if (method === 'GET') return json(200, repoJson(repo, baseUrl));
    if (method === 'PATCH') {
      const body = parseJsonBody(req.body);
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.default_branch === 'string' && repo.refs.has(`refs/heads/${body.default_branch}`)) {
        repo.defaultBranch = body.default_branch;
        repo.head = `refs/heads/${body.default_branch}`;
      }
      return json(200, repoJson(repo, baseUrl));
    }
    if (method === 'DELETE') {
      deleteRepo(store, owner, repoName);
      return empty(204);
    }
    return error(404, 'Not Found');
  }

  // ---- branches ---------------------------------------------------------
  if (rest[0] === 'branches') {
    const branches = listBranches(repo);
    if (rest.length === 1 && method === 'GET') {
      const page = paginate(branches, query, `${repoUrl}/branches`);
      return json(200, page.items.map((branch) => ({
        name: branch.name,
        commit: { sha: branch.oid, url: `${repoUrl}/commits/${branch.oid}` },
        protected: false,
      })), page.headers);
    }
    if (rest.length === 2 && method === 'GET') {
      const branch = branches.find((b) => b.name === decodeURIComponent(rest[1]));
      if (!branch) return error(404, 'Branch not found');
      return json(200, {
        name: branch.name,
        commit: { sha: branch.oid, url: `${repoUrl}/commits/${branch.oid}` },
        protected: false,
      });
    }
    return error(404, 'Not Found');
  }

  // ---- git/refs ---------------------------------------------------------
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const body = parseJsonBody(req.body);
      const ref = normalizeRef(String(body.ref ?? ''));
      const sha = String(body.sha ?? '');
      if (!ref.startsWith('refs/') || !isObjectId(sha) || !repo.objects.has(sha)) {
        return error(422, 'Invalid ref or sha');
      }
      if (repo.refs.has(ref)) return error(422, 'Reference already exists');
      setRef(repo, ref, sha);
      const object = repo.objects.get(sha);
      return json(201, {
        ref,
        node_id: globalId('R', repo.dbId, ref),
        url: `${repoUrl}/git/refs/${encodeURIComponent(ref)}`,
        object: { sha, type: object ? object.type : 'commit', url: `${repoUrl}/git/${object ? object.type : 'commit'}s/${sha}` },
      });
    }
    if (method === 'GET' && rest.length >= 3) {
      const ref = normalizeRef(rest.slice(2).map(decodeURIComponent).join('/'));
      const oid = getRef(repo, ref);
      if (oid === null) return error(404, 'Not Found');
      const object = repo.objects.get(oid);
      return json(200, {
        ref,
        node_id: globalId('R', repo.dbId, ref),
        url: `${repoUrl}/git/refs/${encodeURIComponent(ref)}`,
        object: { sha: oid, type: object ? object.type : 'commit', url: `${repoUrl}/git/${object ? object.type : 'commit'}s/${oid}` },
      });
    }
    return error(404, 'Not Found');
  }

  // ---- commits ----------------------------------------------------------
  if (rest[0] === 'commits' && method === 'GET') {
    let refOid = null;
    if (rest.length === 2) {
      refOid = resolveRef(repo, decodeURIComponent(rest[1]));
    } else {
      const sha = query.get('sha');
      refOid = sha ? resolveRef(repo, sha) : repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
    }
    if (refOid === null) return json(200, []);
    const commits = listCommits(repo, refOid, 100);
    const page = paginate(commits, query, `${repoUrl}/commits`);
    return json(200, page.items.map((c) => commitJson(repo, c.sha)), page.headers);
  }

  // ---- contents ---------------------------------------------------------
  if (rest[0] === 'contents') {
    const contentPath = rest.slice(1).map(decodeURIComponent).join('/');
    const refParam = query.get('ref');
    const refOid = refParam ? resolveRef(repo, refParam) : (repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null);
    if (method === 'GET') {
      if (refOid === null) return error(404, 'This repository is empty.');
      const commitOid = peel(repo, refOid);
      const meta = commitInfo(repo, commitOid);
      if (!meta) return error(404, 'Not Found');
      if (contentPath === '') {
        const entries = listDirectory(repo, meta.tree, '');
        if (entries === null) return error(404, 'Not Found');
        return json(200, entries.map((entry) => ({
          type: entry.type,
          name: entry.name,
          path: entry.path,
          sha: entry.oid,
          size: entry.type === 'file' ? (repo.objects.get(entry.oid)?.data.length ?? 0) : 0,
          url: `${repoUrl}/contents/${encodeURIComponent(entry.path)}`,
          html_url: `https://github.com/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${entry.path}`,
        })));
      }
      const hit = lookupPath(repo, meta.tree, contentPath);
      if (!hit) return error(404, 'Not Found');
      if (hit.isDir || hit.mode === '40000') {
        const entries = listDirectory(repo, meta.tree, contentPath);
        if (entries === null) return error(404, 'Not Found');
        return json(200, entries.map((entry) => ({
          type: entry.type,
          name: entry.name,
          path: entry.path,
          sha: entry.oid,
          size: entry.type === 'file' ? (repo.objects.get(entry.oid)?.data.length ?? 0) : 0,
          url: `${repoUrl}/contents/${encodeURIComponent(entry.path)}`,
          html_url: `https://github.com/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${entry.path}`,
        })));
      }
      const object = repo.objects.get(hit.oid);
      if (!object || object.type !== 'blob') return error(404, 'Not Found');
      return json(200, {
        type: 'file',
        encoding: 'base64',
        size: object.data.length,
        name: contentPath.split('/').pop(),
        path: contentPath,
        sha: hit.oid,
        content: object.data.toString('base64'),
        url: `${repoUrl}/contents/${encodeURIComponent(contentPath)}`,
        html_url: `https://github.com/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${contentPath}`,
        git_url: `${repoUrl}/git/blobs/${hit.oid}`,
        download_url: `${repoUrl}/contents/${encodeURIComponent(contentPath)}?raw=1`,
      });
    }
    if (method === 'PUT') {
      const body = parseJsonBody(req.body);
      const branch = typeof body.branch === 'string' && body.branch.length > 0 ? body.branch : repo.defaultBranch;
      const content = body.content ? Buffer.from(String(body.content), 'base64') : Buffer.alloc(0);
      const result = commitPath(repo, {
        branch,
        path: contentPath,
        content,
        message: body.message,
        sha: body.sha,
      });
      if (result.error === 'sha-mismatch') return error(409, 'sha does not match the current file');
      if (result.error) return error(422, 'Could not update file');
      return json(result.created ? 201 : 200, {
        content: {
          name: contentPath.split('/').pop(),
          path: contentPath,
          sha: result.blobSha,
          size: content.length,
          type: 'file',
          encoding: 'base64',
          url: `${repoUrl}/contents/${encodeURIComponent(contentPath)}`,
        },
        commit: { sha: result.commitSha, message: body.message ?? '' },
      });
    }
    if (method === 'DELETE') {
      const body = parseJsonBody(req.body);
      const branch = typeof body.branch === 'string' && body.branch.length > 0 ? body.branch : repo.defaultBranch;
      const result = commitPath(repo, {
        branch,
        path: contentPath,
        message: body.message,
        sha: body.sha,
        remove: true,
      });
      if (result.error === 'not-found') return error(404, 'Not Found');
      if (result.error === 'sha-mismatch') return error(409, 'sha does not match the current file');
      if (result.error) return error(422, 'Could not delete file');
      return json(200, { commit: { sha: result.commitSha, message: body.message ?? '' } });
    }
    return error(404, 'Not Found');
  }

  // ---- labels -----------------------------------------------------------
  if (rest[0] === 'labels') {
    if (method === 'GET' && rest.length === 1) {
      return json(200, [...repo.labels.values()].map((label) => labelJson(label, repo, baseUrl)));
    }
    if (method === 'POST' && rest.length === 1) {
      const body = parseJsonBody(req.body);
      const name = String(body.name ?? '');
      const color = String(body.color ?? '000000').replace(/^#/, '');
      if (!name) return error(422, 'Label name is required');
      if (repo.labels.has(name)) return error(422, 'Label already exists');
      const label = { name, color, description: String(body.description ?? '') };
      repo.labels.set(name, label);
      return json(201, labelJson(label, repo, baseUrl));
    }
    return error(404, 'Not Found');
  }

  // ---- issues -----------------------------------------------------------
  if (rest[0] === 'issues') {
    if (rest.length === 1 && method === 'GET') {
      const state = query.get('state') ?? 'open';
      const sort = query.get('sort') ?? 'created';
      const direction = query.get('direction') ?? 'desc';
      const items = listItems(repo, { state, sort, direction, kind: 'issue' });
      const page = paginate(items, query, `${repoUrl}/issues`);
      return json(200, page.items.map((item) => itemJson(repo, item, baseUrl)), page.headers);
    }
    if (rest.length === 1 && method === 'POST') {
      const body = parseJsonBody(req.body);
      if (!body.title) return error(422, 'Title is required');
      const result = createIssue(store, repo, {
        title: body.title,
        body: body.body ?? '',
        labels: Array.isArray(body.labels) ? body.labels.map((l) => (typeof l === 'string' ? l : l.name)) : [],
      });
      if (result.error === 'unknown-label') return error(422, `Label does not exist: ${result.label}`);
      return json(201, itemJson(repo, result.item, baseUrl));
    }
    if (rest.length >= 2) {
      const number = Number.parseInt(rest[1], 10);
      if (!Number.isInteger(number)) return error(404, 'Not Found');
      const item = getItem(repo, number);
      if (rest.length === 2 && method === 'GET') {
        if (!item) return error(404, 'Not Found');
        return json(200, itemJson(repo, item, baseUrl));
      }
      if (rest.length === 2 && method === 'PATCH') {
        if (!item) return error(404, 'Not Found');
        const body = parseJsonBody(req.body);
        if (typeof body.title === 'string') item.title = body.title;
        if (typeof body.body === 'string') item.body = body.body;
        if (body.state === 'closed' || body.state === 'open') {
          item.state = body.state;
          item.closedAt = body.state === 'closed' ? EPOCH_SEC : null;
        }
        if (Array.isArray(body.labels)) {
          const names = body.labels.map((l) => (typeof l === 'string' ? l : l.name));
          for (const name of names) if (!repo.labels.has(name)) return error(422, `Label does not exist: ${name}`);
          item.labels = names;
        }
        item.updatedAt = EPOCH_SEC;
        return json(200, itemJson(repo, item, baseUrl));
      }
      if (rest.length === 3 && rest[2] === 'comments' && method === 'GET') {
        if (!item) return error(404, 'Not Found');
        const page = paginate(item.comments, query, `${repoUrl}/issues/${number}/comments`);
        return json(200, page.items.map((c) => commentJson(repo, item, c, baseUrl)), page.headers);
      }
      if (rest.length === 3 && rest[2] === 'comments' && method === 'POST') {
        if (!item) return error(404, 'Not Found');
        const body = parseJsonBody(req.body);
        if (!body.body) return error(422, 'Comment body is required');
        const comment = addComment(store, repo, number, body.body);
        return json(201, commentJson(repo, item, comment, baseUrl));
      }
      return error(404, 'Not Found');
    }
    return error(404, 'Not Found');
  }

  // ---- pulls ------------------------------------------------------------
  if (rest[0] === 'pulls') {
    if (rest.length === 1 && method === 'GET') {
      const state = query.get('state') ?? 'open';
      const items = listItems(repo, { state, sort: 'created', direction: 'desc', kind: 'pull' });
      const page = paginate(items, query, `${repoUrl}/pulls`);
      return json(200, page.items.map((item) => itemJson(repo, item, baseUrl)), page.headers);
    }
    if (rest.length === 1 && method === 'POST') {
      const body = parseJsonBody(req.body);
      if (!body.title || !body.head || !body.base) return error(422, 'title, head and base are required');
      const result = createPull(store, repo, {
        title: body.title,
        body: body.body ?? '',
        head: String(body.head),
        base: String(body.base),
      });
      if (result.error === 'duplicate-open-pr') return error(422, 'A pull request already exists for this head branch');
      if (result.error === 'unknown-branch') return error(422, 'Head or base branch does not exist');
      return json(201, itemJson(repo, result.item, baseUrl));
    }
    if (rest.length >= 2) {
      const number = Number.parseInt(rest[1], 10);
      if (!Number.isInteger(number)) return error(404, 'Not Found');
      const item = getItem(repo, number);
      if (rest.length === 2 && method === 'GET') {
        if (!item || item.kind !== 'pull') return error(404, 'Not Found');
        return json(200, itemJson(repo, item, baseUrl));
      }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        if (!item || item.kind !== 'pull') return error(404, 'Not Found');
        const files = pullFiles(repo, item);
        const page = paginate(files, query, `${repoUrl}/pulls/${number}/files`);
        return json(200, page.items.map((f) => ({
          filename: f.filename,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          changes: f.changes,
          sha: '',
          raw_url: '',
          blob_url: '',
          patch: '',
        })), page.headers);
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'GET') {
        if (!item || item.kind !== 'pull') return error(404, 'Not Found');
        if (!item.merged) return empty(204);
        return json(200, { merged: true, sha: item.mergeCommitSha, message: `Merge pull request #${item.number} from ${item.head.ref}` });
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        if (!item || item.kind !== 'pull') return error(404, 'Not Found');
        const body = parseJsonBody(req.body);
        const result = mergePull(repo, item, body.merge_method ?? 'squash');
        if (result.error === 'conflicted') return error(405, 'Pull request is not mergeable');
        if (result.error === 'not-open') return error(405, 'Pull request is not open');
        if (result.error) return error(422, 'Could not merge pull request');
        return json(200, { merged: true, sha: result.sha, message: result.message });
      }
      return error(404, 'Not Found');
    }
    return error(404, 'Not Found');
  }

  return error(404, 'Not Found');
}
