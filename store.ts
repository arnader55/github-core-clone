// store.ts — the forge's in-memory store. One instance per server process.
//
// Repos, git objects, refs, issues, pull requests, labels and comments all live
// here, in Maps, so the hot paths are plain lookups. Nothing is written to disk
// (the trial mounts /bot read-only and only /tmp is writable), and every
// timestamp is the fixture epoch, so a live run and its replay export the same
// bytes.

import {
  hashObject, buildTree, buildCommit, buildTag, parseCommit, parseTree, parseTag,
  collectReachable, peelToCommit, sortTreeEntries, ZERO_OID, isObjectId,
} from './gitwire.ts';

export const EPOCH_SEC = 1735689600;
export const VIEWER = { id: 1000, login: 'adaiversen', email: 'adaiversen@example.invalid', name: 'ada iversen' };
export const CONFORMANCE_IDENTITY = 'Conformance <conformance@make.fun>';
export const DEFAULT_BRANCH = 'main';

/** ISO 8601 without milliseconds, e.g. 2025-01-01T00:00:00Z. */
export function iso(epochSec = EPOCH_SEC) {
  return new Date(epochSec * 1000).toISOString().replace('.000Z', 'Z');
}

export function b64encode(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

export function b64decode(text) {
  return Buffer.from(text, 'base64').toString('utf8');
}

/** The standard labels GitHub gives every new repository. */
const DEFAULT_LABELS = [
  { name: 'bug', color: 'd73a4a', description: "Something isn't working" },
  { name: 'enhancement', color: 'a2eeef', description: 'New feature or request' },
  { name: 'documentation', color: '0075ca', description: 'Improvements or additions to documentation' },
  { name: 'question', color: 'd876e3', description: 'Further information is requested' },
  { name: 'good first issue', color: '7057ff', description: 'Good for newcomers' },
  { name: 'help wanted', color: '008672', description: 'Extra attention is needed' },
];

export function globalId(kind, ...parts) {
  return b64encode(`${kind}:${parts.join(':')}`);
}

/** Decode a global id the suite hands back, or null when it is not one of ours. */
export function decodeGlobalId(id) {
  if (typeof id !== 'string' || id.length === 0) return null;
  let text;
  try {
    text = b64decode(id);
  } catch {
    return null;
  }
  if (!/^[A-Z]+:/.test(text)) return null;
  const [kind, ...rest] = text.split(':');
  return { kind, rest };
}

// -------------------------------------------------------------------------------------------
// repository
// -------------------------------------------------------------------------------------------

export function createStore() {
  const store = {
    repos: new Map(), // key: `${ownerLower}/${nameLower}` -> repo
    nextRepoDbId: 5000,
    nextIssueNumericId: 1,
    nextCommentId: 1,
  };
  return store;
}

function repoKey(owner, name) {
  return `${String(owner).toLowerCase()}/${String(name).toLowerCase()}`;
}

export function getRepo(store, owner, name) {
  return store.repos.get(repoKey(owner, name)) ?? null;
}

export function createRepo(store, { name, isPrivate = false, description = '', defaultBranch = DEFAULT_BRANCH }) {
  if (typeof name !== 'string' || name.length === 0 || name.length > 100) return { error: 'invalid-name' };
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name.startsWith('.') || name.endsWith('.') || name.includes('..')) {
    return { error: 'invalid-name' };
  }
  if (getRepo(store, VIEWER.login, name) !== null) return { error: 'duplicate' };
  const dbId = store.nextRepoDbId;
  store.nextRepoDbId += 1;
  const repo = {
    dbId,
    name,
    owner: VIEWER.login,
    private: Boolean(isPrivate),
    description: String(description ?? ''),
    defaultBranch,
    createdAt: EPOCH_SEC,
    updatedAt: EPOCH_SEC,
    objects: new Map(), // oid -> {type, data}
    commitMeta: new Map(), // commit oid -> {parents, tree}
    refs: new Map(), // 'refs/heads/main' -> oid
    head: `refs/heads/${defaultBranch}`,
    labels: new Map(DEFAULT_LABELS.map((label) => [label.name, { ...label }])),
    items: new Map(), // number -> issue or pull request
    nextNumber: 1,
    comments: new Map(), // issue number -> [{id, body, createdAt}]
    treeCache: new Map(), // tree oid -> Map<path, {mode, oid}>
  };
  store.repos.set(repoKey(VIEWER.login, name), repo);
  return { repo };
}

export function deleteRepo(store, owner, name) {
  return store.repos.delete(repoKey(owner, name));
}

export function listViewerRepos(store) {
  const repos = [...store.repos.values()].filter((repo) => repo.owner === VIEWER.login);
  repos.sort((a, b) => b.dbId - a.dbId); // newest first, stable
  return repos;
}

// -------------------------------------------------------------------------------------------
// git objects
// -------------------------------------------------------------------------------------------

/** Store objects (from a pack or built here), filling the commit metadata cache. */
export function storeObjects(repo, objects) {
  for (const [oid, object] of objects) {
    if (repo.objects.has(oid)) continue;
    repo.objects.set(oid, object);
    if (object.type === 'commit') {
      const parsed = parseCommit(object.data);
      repo.commitMeta.set(oid, { parents: parsed.parents, tree: parsed.tree });
    }
  }
}

export function lookupObject(repo, oid) {
  return repo.objects.get(oid);
}

export function commitInfo(repo, oid) {
  return repo.commitMeta.get(oid);
}

/** The commit a ref oid resolves to, following annotated tags. */
export function peel(repo, oid) {
  return peelToCommit(oid, (id) => repo.objects.get(id));
}

// -------------------------------------------------------------------------------------------
// refs and branches
// -------------------------------------------------------------------------------------------

export function getRef(repo, refName) {
  return repo.refs.get(refName) ?? null;
}

export function setRef(repo, refName, oid) {
  repo.refs.set(refName, oid);
}

export function deleteRef(repo, refName) {
  return repo.refs.delete(refName);
}

export function listBranches(repo) {
  const branches = [];
  for (const [refName, oid] of repo.refs) {
    if (!refName.startsWith('refs/heads/')) continue;
    branches.push({ name: refName.slice('refs/heads/'.length), ref: refName, oid });
  }
  branches.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return branches;
}

/** All refs in advertisement order: branches, then tags, each with peel info. */
export function listAdvertisedRefs(repo) {
  const refs = [];
  for (const [refName, oid] of repo.refs) {
    const ref = { name: refName, oid };
    const object = repo.objects.get(oid);
    if (object && object.type === 'tag') {
      const target = parseTag(object.data).object;
      if (target && repo.objects.has(target)) ref.peeled = target;
    }
    refs.push(ref);
  }
  refs.sort((a, b) => {
    const aHead = a.name.startsWith('refs/heads/') ? 0 : 1;
    const bHead = b.name.startsWith('refs/heads/') ? 0 : 1;
    if (aHead !== bHead) return aHead - bHead;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  return refs;
}

/** Resolve a ref name, a branch name, or a full/partial oid to a commit oid. */
export function resolveRef(repo, ref) {
  if (typeof ref !== 'string' || ref.length === 0) return null;
  if (isObjectId(ref)) return repo.objects.has(ref) ? ref : null;
  const candidates = [
    `refs/heads/${ref}`,
    `refs/tags/${ref}`,
    ref,
  ];
  for (const candidate of candidates) {
    const oid = repo.refs.get(candidate);
    if (oid) return oid;
  }
  return null;
}

// -------------------------------------------------------------------------------------------
// trees and paths
// -------------------------------------------------------------------------------------------

/** The flat file listing of a tree: Map<path, {mode, oid}>. Trees are immutable, so this is cached. */
export function flattenTree(repo, treeOid) {
  if (!treeOid || treeOid === ZERO_OID) return new Map();
  const cached = repo.treeCache.get(treeOid);
  if (cached) return cached;
  const out = new Map();
  const walk = (oid, prefix) => {
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { mode: entry.mode, oid: entry.oid });
    }
  };
  walk(treeOid, '');
  repo.treeCache.set(treeOid, out);
  return out;
}

/**
 * Return the tree oid of `path`'s parent directory inside `treeOid`, plus the
 * leaf name — or null when a component in the way is not a directory.
 */
function parentTreeOid(repo, treeOid, parts) {
  let current = treeOid;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const object = current ? repo.objects.get(current) : undefined;
    if (!object || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((e) => e.name === parts[i]);
    if (!entry || entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return current;
}

/**
 * Rebuild the tree at `treeOid` with `path` set to `{mode, oid}` (or removed
 * when the entry is null), storing the new intermediate trees. Returns the new
 * root tree oid.
 */
export function setPathInTree(repo, treeOid, path, entry) {
  const parts = path.split('/').filter((part) => part.length > 0);
  if (parts.length === 0) throw new Error('empty path');
  const rebuild = (currentOid, depth) => {
    const object = currentOid ? repo.objects.get(currentOid) : undefined;
    const entries = object && object.type === 'tree' ? parseTree(object.data) : [];
    const name = parts[depth];
    const isLeaf = depth === parts.length - 1;
    const index = entries.findIndex((e) => e.name === name);
    let next = [...entries];
    if (isLeaf) {
      if (entry === null) {
        if (index !== -1) next.splice(index, 1);
      } else if (index !== -1) {
        next[index] = { mode: entry.mode, name, oid: entry.oid };
      } else {
        next.push({ mode: entry.mode, name, oid: entry.oid });
      }
    } else {
      const child = index !== -1 ? entries[index] : null;
      if (child && child.mode !== '40000') throw new Error(`path component ${name} is not a directory`);
      const childOid = rebuild(child ? child.oid : null, depth + 1);
      if (childOid === null) {
        if (index !== -1) next.splice(index, 1);
      } else if (index !== -1) {
        next[index] = { mode: '40000', name, oid: childOid };
      } else {
        next.push({ mode: '40000', name, oid: childOid });
      }
    }
    if (next.length === 0) return null;
    const data = buildTree(next);
    const oid = hashObject('tree', data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type: 'tree', data });
    return oid;
  };
  const result = rebuild(treeOid, 0);
  return result ?? hashObject('tree', buildTree([]));
}

/** The blob (or tree) at `path` inside the tree `treeOid`, or null. */
export function lookupPath(repo, treeOid, path) {
  const flat = flattenTree(repo, treeOid);
  const hit = flat.get(path);
  if (hit) return { ...hit, path };
  // Maybe it is a directory: look for any entry beneath it.
  const prefix = `${path}/`;
  for (const key of flat.keys()) {
    if (key.startsWith(prefix)) return { mode: '40000', oid: null, path, isDir: true };
  }
  return null;
}

/** The directory listing of `path` ('' for the root) inside `treeOid`. */
export function listDirectory(repo, treeOid, path) {
  let current = treeOid;
  if (path) {
    const parts = path.split('/').filter((part) => part.length > 0);
    for (const part of parts) {
      const object = current ? repo.objects.get(current) : undefined;
      if (!object || object.type !== 'tree') return null;
      const entry = parseTree(object.data).find((e) => e.name === part);
      if (!entry || entry.mode !== '40000') return null;
      current = entry.oid;
    }
  }
  const object = current ? repo.objects.get(current) : undefined;
  if (!object || object.type !== 'tree') return null;
  return parseTree(object.data).map((entry) => ({
    mode: entry.mode,
    name: entry.name,
    path: path ? `${path}/${entry.name}` : entry.name,
    oid: entry.oid,
    type: entry.mode === '40000' ? 'dir' : 'file',
  }));
}

// -------------------------------------------------------------------------------------------
// commits on a branch (REST contents)
// -------------------------------------------------------------------------------------------

/**
 * Create a commit on `branch` that sets (or removes) `path`, and move the
 * branch. `branch` is created from the default tip when it does not exist yet.
 * Returns {commitSha, blobSha, created, branchCreated, treeOid} or {error}.
 */
export function commitPath(repo, { branch, path, content, message, sha, remove = false }) {
  const branchRef = `refs/heads/${branch}`;
  let tip = repo.refs.get(branchRef) ?? null;
  let branchCreated = false;
  if (tip === null) {
    // A new branch starts from the default tip (or from nothing when unborn).
    const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
    tip = defaultTip;
    branchCreated = true;
  }
  let parentTree = null;
  let parents = [];
  if (tip !== null) {
    const commitOid = peel(repo, tip);
    const meta = repo.commitMeta.get(commitOid);
    if (!meta) return { error: 'bad-tip' };
    parentTree = meta.tree;
    parents = [commitOid];
  }
  if (!remove) {
    if (sha !== undefined && sha !== null) {
      const current = parentTree ? lookupPath(repo, parentTree, path) : null;
      if (!current || current.oid !== sha) return { error: 'sha-mismatch' };
    }
    const blobData = Buffer.isBuffer(content) ? content : Buffer.from(String(content ?? ''), 'utf8');
    const blobOid = hashObject('blob', blobData);
    if (!repo.objects.has(blobOid)) repo.objects.set(blobOid, { type: 'blob', data: blobData });
    const newTree = setPathInTree(repo, parentTree, path, { mode: '100644', oid: blobOid });
    const created = tip === null || lookupPath(repo, parentTree, path) === null;
    const commitData = buildCommit({
      tree: newTree,
      parents,
      message: message || (created ? `Create ${path}` : `Update ${path}`),
      author: `${VIEWER.name} <${VIEWER.email}>`,
      committer: CONFORMANCE_IDENTITY,
      timestamp: EPOCH_SEC,
    });
    const commitOid = hashObject('commit', commitData);
    repo.objects.set(commitOid, { type: 'commit', data: commitData });
    repo.commitMeta.set(commitOid, { parents, tree: newTree });
    repo.refs.set(branchRef, commitOid);
    return { commitSha: commitOid, blobSha: blobOid, created, branchCreated, treeOid: newTree };
  }
  // Remove.
  const current = parentTree ? lookupPath(repo, parentTree, path) : null;
  if (!current) return { error: 'not-found' };
  if (sha !== undefined && sha !== null && current.oid !== sha) return { error: 'sha-mismatch' };
  const newTree = setPathInTree(repo, parentTree, path, null);
  const commitData = buildCommit({
    tree: newTree,
    parents,
    message: message || `Delete ${path}`,
    author: `${VIEWER.name} <${VIEWER.email}>`,
    committer: CONFORMANCE_IDENTITY,
    timestamp: EPOCH_SEC,
  });
  const commitOid = hashObject('commit', commitData);
  repo.objects.set(commitOid, { type: 'commit', data: commitData });
  repo.commitMeta.set(commitOid, { parents, tree: newTree });
  repo.refs.set(branchRef, commitOid);
  return { commitSha: commitOid, blobSha: current.oid, created: false, branchCreated, treeOid: newTree };
}

/** The commits reachable from `refOid`, newest first. */
export function listCommits(repo, refOid, limit = 100) {
  const out = [];
  const seen = new Set();
  const stack = [refOid];
  while (stack.length > 0 && out.length < limit) {
    const oid = stack.pop();
    if (!oid || oid === ZERO_OID || seen.has(oid)) continue;
    seen.add(oid);
    const meta = repo.commitMeta.get(oid);
    if (!meta) continue;
    const object = repo.objects.get(oid);
    const parsed = object ? parseCommit(object.data) : null;
    out.push({
      sha: oid,
      commit: { message: parsed ? parsed.message : '', tree: meta.tree, author: parsed ? parsed.author : '', committer: parsed ? parsed.committer : '' },
      parents: meta.parents.map((parent) => ({ sha: parent })),
    });
    // Depth-first, parents pushed in order so the first parent comes out first.
    for (let i = meta.parents.length - 1; i >= 0; i -= 1) stack.push(meta.parents[i]);
  }
  return out;
}

// -------------------------------------------------------------------------------------------
// issues and pull requests
// -------------------------------------------------------------------------------------------

export function nextItemNumber(repo) {
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  return number;
}

export function createIssue(store, repo, { title, body = '', labels = [] }) {
  for (const label of labels) {
    if (!repo.labels.has(label)) return { error: 'unknown-label', label };
  }
  const number = nextItemNumber(repo);
  const id = store.nextIssueNumericId;
  store.nextIssueNumericId += 1;
  const item = {
    id,
    number,
    kind: 'issue',
    title: String(title ?? ''),
    body: String(body ?? ''),
    state: 'open',
    labels: [...labels],
    createdAt: EPOCH_SEC,
    updatedAt: EPOCH_SEC,
    closedAt: null,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    head: null,
    base: null,
    comments: [],
  };
  repo.items.set(number, item);
  return { item };
}

export function createPull(store, repo, { title, body = '', head, base }) {
  const headRef = `refs/heads/${head}`;
  const baseRef = `refs/heads/${base}`;
  const headOid = repo.refs.get(headRef) ?? null;
  const baseOid = repo.refs.get(baseRef) ?? null;
  if (headOid === null || baseOid === null) return { error: 'unknown-branch' };
  for (const existing of repo.items.values()) {
    if (existing.kind === 'pull' && existing.state === 'open' && existing.head.ref === head) {
      return { error: 'duplicate-open-pr' };
    }
  }
  const number = nextItemNumber(repo);
  const id = store.nextIssueNumericId;
  store.nextIssueNumericId += 1;
  const item = {
    id,
    number,
    kind: 'pull',
    title: String(title ?? ''),
    body: String(body ?? ''),
    state: 'open',
    labels: [],
    createdAt: EPOCH_SEC,
    updatedAt: EPOCH_SEC,
    closedAt: null,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    head: { ref: head, sha: peel(repo, headOid) },
    base: { ref: base, sha: peel(repo, baseOid) },
  };
  repo.items.set(number, item);
  return { item };
}

export function getItem(repo, number) {
  return repo.items.get(number) ?? null;
}

/** Issues (and, for the list endpoint, pull requests) with filtering and sorting. */
export function listItems(repo, { state = 'open', sort = 'created', direction = 'desc', kind = null } = {}) {
  let items = [...repo.items.values()];
  if (kind) items = items.filter((item) => item.kind === kind);
  if (state !== 'all') items = items.filter((item) => item.state === state);
  const dir = direction === 'asc' ? 1 : -1;
  items.sort((a, b) => {
    if (sort === 'created') return dir * (a.number - b.number);
    return dir * (a.number - b.number);
  });
  return items;
}

export function addComment(store, repo, number, body) {
  const item = repo.items.get(number);
  if (!item) return null;
  const id = store.nextCommentId;
  store.nextCommentId += 1;
  const comment = { id, body: String(body ?? ''), createdAt: EPOCH_SEC };
  item.comments.push(comment);
  return comment;
}

// -------------------------------------------------------------------------------------------
// merges and diffs
// -------------------------------------------------------------------------------------------

/** The merge base of two commits: the newest common ancestor. */
export function mergeBase(repo, aOid, bOid) {
  const a = peel(repo, aOid);
  const b = peel(repo, bOid);
  if (a === b) return a;
  const ancestorsOfA = new Set();
  const stackA = [a];
  while (stackA.length > 0) {
    const oid = stackA.pop();
    if (!oid || oid === ZERO_OID || ancestorsOfA.has(oid)) continue;
    ancestorsOfA.add(oid);
    const meta = repo.commitMeta.get(oid);
    if (meta) for (const parent of meta.parents) stackA.push(parent);
  }
  const stackB = [b];
  const seenB = new Set();
  while (stackB.length > 0) {
    const oid = stackB.pop();
    if (!oid || oid === ZERO_OID || seenB.has(oid)) continue;
    seenB.add(oid);
    if (ancestorsOfA.has(oid)) return oid;
    const meta = repo.commitMeta.get(oid);
    if (meta) for (const parent of meta.parents) stackB.push(parent);
  }
  return null;
}

/**
 * The three-way merge of `headTree` onto `baseTree` with `baseTree0` as the
 * merge base. Returns {tree, conflicted, files} where `tree` is the merged
 * flat listing (null when conflicted).
 */
export function threeWayMerge(repo, baseTree0, headTree, baseTree) {
  const base0 = flattenTree(repo, baseTree0);
  const head = flattenTree(repo, headTree);
  const base = flattenTree(repo, baseTree);
  const paths = new Set([...base0.keys(), ...head.keys(), ...base.keys()]);
  const merged = new Map();
  let conflicted = false;
  for (const path of paths) {
    const o0 = base0.get(path)?.oid ?? null;
    const oH = head.get(path)?.oid ?? null;
    const oB = base.get(path)?.oid ?? null;
    if (oH === o0) {
      if (oB !== null) merged.set(path, base.get(path));
    } else if (oB === o0) {
      if (oH !== null) merged.set(path, head.get(path));
    } else if (oH === oB) {
      if (oH !== null) merged.set(path, head.get(path));
    } else {
      conflicted = true;
    }
  }
  return { tree: conflicted ? null : merged, conflicted };
}

/** Build a tree oid from a flat listing (nested directories included). */
export function treeFromFlat(repo, flat) {
  const build = (prefix) => {
    const entries = [];
    const subdirs = new Set();
    for (const [path, entry] of flat) {
      if (prefix && !path.startsWith(`${prefix}/`)) continue;
      const rest = prefix ? path.slice(prefix.length + 1) : path;
      if (rest.includes('/')) {
        subdirs.add(rest.split('/')[0]);
      } else {
        entries.push({ mode: entry.mode, name: rest, oid: entry.oid });
      }
    }
    for (const dirName of subdirs) {
      const childPrefix = prefix ? `${prefix}/${dirName}` : dirName;
      entries.push({ mode: '40000', name: dirName, oid: build(childPrefix) });
    }
    const data = buildTree(entries);
    const oid = hashObject('tree', data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type: 'tree', data });
    return oid;
  };
  return build('');
}

/** MERGEABLE / CONFLICTING / UNKNOWN for a pull request. */
export function mergeableState(repo, pull) {
  if (pull.state !== 'open') return 'UNKNOWN';
  const headOid = pull.head.sha;
  const baseRef = repo.refs.get(`refs/heads/${pull.base.ref}`);
  if (!baseRef) return 'UNKNOWN';
  const baseOid = peel(repo, baseRef);
  const base = mergeBase(repo, headOid, baseOid);
  if (base === null) return 'UNKNOWN';
  const headMeta = repo.commitMeta.get(headOid);
  const baseMeta = repo.commitMeta.get(baseOid);
  const base0Meta = repo.commitMeta.get(base);
  if (!headMeta || !baseMeta || !base0Meta) return 'UNKNOWN';
  const { conflicted } = threeWayMerge(repo, base0Meta.tree, headMeta.tree, baseMeta.tree);
  return conflicted ? 'CONFLICTING' : 'MERGEABLE';
}

/** The files a pull request changes, diffed against its merge base. */
export function pullFiles(repo, pull) {
  const headOid = pull.head.sha;
  const baseRef = repo.refs.get(`refs/heads/${pull.base.ref}`);
  const baseOid = baseRef ? peel(repo, baseRef) : pull.base.sha;
  const base = mergeBase(repo, headOid, baseOid);
  const baseTree = base ? repo.commitMeta.get(base)?.tree ?? null : null;
  const headTree = repo.commitMeta.get(headOid)?.tree ?? null;
  const before = flattenTree(repo, baseTree);
  const after = flattenTree(repo, headTree);
  const paths = new Set([...before.keys(), ...after.keys()]);
  const files = [];
  for (const path of paths) {
    const o0 = before.get(path);
    const o1 = after.get(path);
    if (o0?.oid === o1?.oid) continue;
    const countLines = (oid) => {
      if (!oid) return 0;
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'blob') return 0;
      const text = object.data.toString('utf8');
      if (text.length === 0) return 0;
      return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    };
    let status = 'modified';
    if (!o0) status = 'added';
    else if (!o1) status = 'removed';
    let additions = 0;
    let deletions = 0;
    if (status === 'added') additions = countLines(o1.oid);
    else if (status === 'removed') deletions = countLines(o0.oid);
    else {
      // Bag difference of the two blobs' lines.
      const linesOf = (oid) => {
        const object = repo.objects.get(oid);
        if (!object) return [];
        const text = object.data.toString('utf8');
        if (text.length === 0) return [];
        const lines = text.split('\n');
        if (text.endsWith('\n')) lines.pop();
        return lines;
      };
      const oldCounts = new Map();
      for (const line of linesOf(o0.oid)) oldCounts.set(line, (oldCounts.get(line) ?? 0) + 1);
      for (const line of linesOf(o1.oid)) {
        const remaining = oldCounts.get(line) ?? 0;
        if (remaining > 0) oldCounts.set(line, remaining - 1);
        else additions += 1;
      }
      for (const remaining of oldCounts.values()) deletions += remaining;
    }
    files.push({
      filename: path,
      status,
      additions,
      deletions,
      changes: additions + deletions,
      previous_filename: status === 'removed' ? path : undefined,
    });
  }
  files.sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));
  return files;
}

/**
 * Merge a pull request with a squash. Returns {merged, sha, message} or
 * {error: 'conflicted' | 'not-open' | 'unknown-branch'}.
 */
export function mergePull(repo, pull, method = 'squash') {
  if (pull.state !== 'open') return { error: 'not-open' };
  const baseRefName = `refs/heads/${pull.base.ref}`;
  const baseRef = repo.refs.get(baseRefName);
  if (!baseRef) return { error: 'unknown-branch' };
  const baseOid = peel(repo, baseRef);
  const headOid = pull.head.sha;
  const base = mergeBase(repo, headOid, baseOid);
  if (base === null) return { error: 'conflicted' };
  const headMeta = repo.commitMeta.get(headOid);
  const baseMeta = repo.commitMeta.get(baseOid);
  const base0Meta = repo.commitMeta.get(base);
  if (!headMeta || !baseMeta || !base0Meta) return { error: 'conflicted' };
  const { tree, conflicted } = threeWayMerge(repo, base0Meta.tree, headMeta.tree, baseMeta.tree);
  if (conflicted) return { error: 'conflicted' };
  const mergedTreeOid = treeFromFlat(repo, tree);
  const message = `Merge pull request #${pull.number} from ${pull.head.ref}`;
  const commitData = buildCommit({
    tree: mergedTreeOid,
    parents: [baseOid],
    message,
    author: `${VIEWER.name} <${VIEWER.email}>`,
    committer: CONFORMANCE_IDENTITY,
    timestamp: EPOCH_SEC,
  });
  const commitOid = hashObject('commit', commitData);
  repo.objects.set(commitOid, { type: 'commit', data: commitData });
  repo.commitMeta.set(commitOid, { parents: [baseOid], tree: mergedTreeOid });
  repo.refs.set(baseRefName, commitOid);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = EPOCH_SEC;
  pull.mergeCommitSha = commitOid;
  pull.closedAt = EPOCH_SEC;
  pull.updatedAt = EPOCH_SEC;
  return { merged: true, sha: commitOid, message };
}
