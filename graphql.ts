// graphql.ts — the GraphQL v4 surface (POST /api/graphql).
//
// A hand-written mini-parser (operations, aliases, variables, inline input
// objects, inline enums, null variables, inline and named fragments) and an
// executor over the store. Unknown fields return HTTP 200 with an errors
// array naming the field; an unknown repository is data.repository = null
// with no errors. A JSON array of operations returns an array of responses.
//
// Global ids are opaque base64 of `R:<dbId>` / `I:<owner>:<repo>:<num>` /
// `PR:<owner>:<repo>:<num>` / `C:<owner>:<repo>:<num>:<commentId>` — never
// the plain databaseId or number.

import {
  VIEWER, EPOCH_SEC, iso, globalId, decodeGlobalId,
  getRepo, getItem, createIssue, createPull, addComment, mergePull,
  listItems, pullFiles, mergeableState,
} from './store.ts';
import { json, error, parseJsonBody } from './http.ts';

// -------------------------------------------------------------------------------------------
// schema table (for __type)
// -------------------------------------------------------------------------------------------

const SCHEMA = {
  Query: { kind: 'OBJECT', fields: ['viewer', 'repository', 'node', 'search', 'user', 'organization'] },
  Mutation: { kind: 'OBJECT', fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'] },
  Repository: { kind: 'OBJECT', fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'url', 'description', 'isPrivate', 'createdAt', 'updatedAt', 'licenseInfo'] },
  Issue: { kind: 'OBJECT', fields: ['id', 'databaseId', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'closedAt', 'author', 'labels', 'comments', 'repository', 'url', 'stateReason'] },
  PullRequest: { kind: 'OBJECT', fields: ['id', 'databaseId', 'number', 'title', 'state', 'body', 'headRefName', 'baseRefName', 'mergeable', 'merged', 'files', 'createdAt', 'updatedAt', 'closedAt', 'mergedAt', 'author', 'labels', 'comments', 'repository', 'url', 'isDraft'] },
  User: { kind: 'OBJECT', fields: ['id', 'databaseId', 'login', 'name', 'email', 'url'] },
  Ref: { kind: 'OBJECT', fields: ['id', 'name', 'prefix', 'target'] },
  IssueConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PullRequestConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PullRequestFileConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  IssueCommentConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PullRequestFile: { kind: 'OBJECT', fields: ['path', 'additions', 'deletions', 'changeType'] },
  IssueComment: { kind: 'OBJECT', fields: ['id', 'databaseId', 'body', 'createdAt', 'updatedAt', 'author'] },
  IssueEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  PullRequestEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  PageInfo: { kind: 'OBJECT', fields: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'] },
  Label: { kind: 'OBJECT', fields: ['id', 'name', 'color', 'description'] },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'] },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  IssueOrderField: { kind: 'ENUM', enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  OrderDirection: { kind: 'ENUM', enumValues: ['ASC', 'DESC'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  MergeMethod: { kind: 'ENUM', enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
};

// -------------------------------------------------------------------------------------------
// tokenizer and parser
// -------------------------------------------------------------------------------------------

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*/;

function tokenize(source) {
  const tokens = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '\uFEFF') { i += 1; continue; }
    if (ch === '#') { while (i < source.length && source[i] !== '\n') i += 1; continue; }
    if (ch === '.' && source.slice(i, i + 3) === '...') { tokens.push({ kind: 'SPREAD' }); i += 3; continue; }
    if ('{}()[]:!=$@'.includes(ch)) { tokens.push({ kind: ch }); i += 1; continue; }
    if (ch === '"') {
      if (source.slice(i, i + 3) === '"""') {
        const end = source.indexOf('"""', i + 3);
        if (end === -1) throw new Error('unterminated block string');
        tokens.push({ kind: 'STRING', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1];
          const map = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/' };
          value += map[esc] ?? esc;
          j += 2;
        } else {
          value += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new Error('unterminated string');
      tokens.push({ kind: 'STRING', value });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      let isFloat = false;
      if (source[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      }
      const raw = source.slice(i, j);
      tokens.push({ kind: isFloat ? 'FLOAT' : 'INT', value: Number(raw) });
      i = j;
      continue;
    }
    const name = NAME_RE.exec(source.slice(i));
    if (name) {
      tokens.push({ kind: 'NAME', value: name[0] });
      i += name[0].length;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} at ${i}`);
  }
  tokens.push({ kind: 'EOF' });
  return tokens;
}

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
  }
  peek() { return this.tokens[this.pos]; }
  next() { return this.tokens[this.pos++]; }
  expect(kind) {
    const token = this.next();
    if (token.kind !== kind) throw new Error(`expected ${kind}, got ${token.kind}`);
    return token;
  }
  eat(kind) {
    if (this.peek().kind === kind) { this.pos += 1; return true; }
    return false;
  }
  parseDocument() {
    const definitions = [];
    while (this.peek().kind !== 'EOF') definitions.push(this.parseDefinition());
    return { kind: 'Document', definitions };
  }
  parseDefinition() {
    if (this.peek().kind === 'NAME' && this.peek().value === 'fragment') {
      this.next();
      const name = this.expect('NAME').value;
      const on = this.expect('NAME');
      if (on.value !== 'on') throw new Error('fragment must say "on"');
      const typeName = this.expect('NAME').value;
      return { kind: 'FragmentDefinition', name, typeName, selectionSet: this.parseSelectionSet() };
    }
    let operation = 'query';
    let name = null;
    if (this.peek().kind === 'NAME' && ['query', 'mutation', 'subscription'].includes(this.peek().value)) {
      operation = this.next().value;
      if (this.peek().kind === 'NAME') name = this.next().value;
    } else if (this.peek().kind === 'NAME') {
      name = this.next().value;
    }
    const variableDefinitions = this.parseVariableDefinitions();
    this.skipDirectives();
    const selectionSet = this.parseSelectionSet();
    return { kind: 'OperationDefinition', operation, name, variableDefinitions, selectionSet };
  }
  parseVariableDefinitions() {
    const defs = [];
    if (!this.eat('(')) return defs;
    while (!this.eat(')')) {
      this.expect('$');
      const name = this.expect('NAME').value;
      this.expect(':');
      const type = this.parseType();
      let defaultValue = undefined;
      if (this.eat('=')) defaultValue = this.parseValue(true);
      defs.push({ name, type, defaultValue });
    }
    return defs;
  }
  parseType() {
    let type;
    if (this.eat('[')) {
      const inner = this.parseType();
      this.expect(']');
      type = `[${inner}]`;
    } else {
      type = this.expect('NAME').value;
    }
    if (this.eat('!')) type += '!';
    return type;
  }
  skipDirectives() {
    while (this.eat('@')) {
      this.expect('NAME');
      if (this.peek().kind === '(') this.parseArguments();
    }
  }
  parseSelectionSet() {
    this.expect('{');
    const selections = [];
    while (!this.eat('}')) selections.push(this.parseSelection());
    return { kind: 'SelectionSet', selections };
  }
  parseSelection() {
    if (this.eat('SPREAD')) {
      if (this.peek().kind === 'NAME' && this.peek().value === 'on') {
        this.next();
        const typeName = this.expect('NAME').value;
        this.skipDirectives();
        return { kind: 'InlineFragment', typeName, selectionSet: this.parseSelectionSet() };
      }
      const name = this.expect('NAME').value;
      this.skipDirectives();
      return { kind: 'FragmentSpread', name };
    }
    let alias = null;
    let name = this.expect('NAME').value;
    if (this.eat(':')) {
      alias = name;
      name = this.expect('NAME').value;
    }
    const args = this.parseArguments();
    this.skipDirectives();
    let selectionSet = null;
    if (this.peek().kind === '{') selectionSet = this.parseSelectionSet();
    return { kind: 'Field', name, alias, arguments: args, selectionSet };
  }
  parseArguments() {
    const args = {};
    if (!this.eat('(')) return args;
    while (!this.eat(')')) {
      const name = this.expect('NAME').value;
      this.expect(':');
      args[name] = this.parseValue(true);
    }
    return args;
  }
  parseValue(isConst) {
    const token = this.next();
    if (token.kind === '$') {
      if (isConst) throw new Error('variable in a constant value');
      return { kind: 'Variable', name: this.expect('NAME').value };
    }
    if (token.kind === 'INT' || token.kind === 'FLOAT' || token.kind === 'STRING') {
      return { kind: 'Literal', value: token.value };
    }
    if (token.kind === 'NAME') {
      if (token.value === 'true') return { kind: 'Literal', value: true };
      if (token.value === 'false') return { kind: 'Literal', value: false };
      if (token.value === 'null') return { kind: 'Literal', value: null };
      return { kind: 'Enum', value: token.value };
    }
    if (token.kind === '[') {
      const values = [];
      while (!this.eat(']')) values.push(this.parseValue(isConst));
      return { kind: 'List', values };
    }
    if (token.kind === '{') {
      const fields = {};
      while (!this.eat('}')) {
        const name = this.expect('NAME').value;
        this.expect(':');
        fields[name] = this.parseValue(isConst);
      }
      return { kind: 'Object', fields };
    }
    throw new Error(`unexpected token ${token.kind} in value`);
  }
}

function parseGraphql(source) {
  return new Parser(tokenize(source)).parseDocument();
}

// -------------------------------------------------------------------------------------------
// value resolution
// -------------------------------------------------------------------------------------------

function resolveValue(node, variables) {
  switch (node.kind) {
    case 'Literal': return node.value;
    case 'Enum': return node.value;
    case 'Variable': return variables[node.name];
    case 'List': return node.values.map((v) => resolveValue(v, variables));
    case 'Object': {
      const out = {};
      for (const [key, value] of Object.entries(node.fields)) out[key] = resolveValue(value, variables);
      return out;
    }
    default: return null;
  }
}

function resolveArguments(field, variables) {
  const out = {};
  for (const [key, value] of Object.entries(field.arguments ?? {})) out[key] = resolveValue(value, variables);
  return out;
}

// -------------------------------------------------------------------------------------------
// cursors and connections
// -------------------------------------------------------------------------------------------

function cursorFor(index) {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function indexFromCursor(cursor) {
  if (typeof cursor !== 'string') return -1;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number(match[1]) : -1;
  } catch {
    return -1;
  }
}

function connection(items, { first, after } = {}) {
  const start = indexFromCursor(after) + 1;
  const limit = Number.isInteger(first) && first > 0 ? first : items.length;
  const page = items.slice(start, start + limit);
  const endIndex = start + page.length - 1;
  return {
    __typename: 'Connection',
    nodes: page,
    totalCount: items.length,
    pageInfo: {
      hasNextPage: start + page.length < items.length,
      hasPreviousPage: start > 0,
      startCursor: page.length > 0 ? cursorFor(start) : null,
      endCursor: page.length > 0 ? cursorFor(endIndex) : null,
    },
  };
}

// -------------------------------------------------------------------------------------------
// resolvers
// -------------------------------------------------------------------------------------------

function repoNode(repo) {
  return {
    __typename: 'Repository',
    __repo: repo,
    id: globalId('R', repo.dbId),
    databaseId: repo.dbId,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
  };
}

function issueNode(repo, item) {
  return {
    __typename: item.kind === 'pull' ? 'PullRequest' : 'Issue',
    __repo: repo,
    __item: item,
    id: globalId(item.kind === 'pull' ? 'PR' : 'I', repo.owner, repo.name, item.number),
    databaseId: item.id,
    number: item.number,
  };
}

function userNode() {
  return {
    __typename: 'User',
    id: globalId('U', VIEWER.id),
    databaseId: VIEWER.id,
    login: VIEWER.login,
    name: VIEWER.name,
    email: VIEWER.email,
  };
}

function refNode(name) {
  return { __typename: 'Ref', id: globalId('Ref', name), name };
}

const RESOLVERS = {
  Query: {
    viewer: () => userNode(),
    repository: (ctx, args) => {
      const repo = getRepo(ctx.store, args.owner, args.name);
      return repo ? repoNode(repo) : null;
    },
    node: (ctx, args) => {
      const decoded = decodeGlobalId(args.id);
      if (!decoded) return null;
      if (decoded.kind === 'R') {
        const dbId = Number(decoded.rest[0]);
        for (const repo of ctx.store.repos.values()) {
          if (repo.dbId === dbId) return repoNode(repo);
        }
        return null;
      }
      if (decoded.kind === 'I' || decoded.kind === 'PR' || decoded.kind === 'C') {
        const [owner, name, numberText] = decoded.rest;
        const repo = getRepo(ctx.store, owner, name);
        if (!repo) return null;
        const item = getItem(repo, Number(numberText));
        if (!item) return null;
        if (decoded.kind === 'C') {
          const commentId = Number(decoded.rest[3]);
          const comment = item.comments.find((c) => c.id === commentId);
          if (!comment) return null;
          return {
            __typename: 'IssueComment',
            __repo: repo,
            __item: item,
            __comment: comment,
            id: globalId('C', owner, name, item.number, comment.id),
            databaseId: comment.id,
            body: comment.body,
          };
        }
        return issueNode(repo, item);
      }
      if (decoded.kind === 'U') return userNode();
      return null;
    },
    __type: (ctx, args) => {
      const entry = SCHEMA[args.name];
      if (!entry) return null;
      return { __typename: '__Type', __schemaName: args.name, __schema: entry, name: args.name, kind: entry.kind };
    },
  },
  Repository: {
    owner: (ctx, _args, parent) => userNode(),
    defaultBranchRef: (ctx, _args, parent) => {
      const repo = parent.__repo;
      const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      return tip ? refNode(repo.defaultBranch) : null;
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    issue: (ctx, args, parent) => {
      const repo = parent.__repo;
      const item = getItem(repo, Number(args.number));
      return item && item.kind === 'issue' ? issueNode(repo, item) : null;
    },
    issues: (ctx, args, parent) => {
      const repo = parent.__repo;
      let items = listItems(repo, { state: 'all', kind: 'issue' });
      if (Array.isArray(args.states) && args.states.length > 0) {
        const wanted = new Set(args.states.map((s) => String(s).toLowerCase()));
        items = items.filter((item) => wanted.has(item.state));
      }
      if (args.orderBy && typeof args.orderBy === 'object') {
        const direction = args.orderBy.direction === 'ASC' ? 1 : -1;
        items = [...items].sort((a, b) => direction * (a.number - b.number));
      } else {
        items = [...items].sort((a, b) => b.number - a.number);
      }
      const conn = connection(items.map((item) => issueNode(repo, item)), args);
      conn.__typename = 'IssueConnection';
      return conn;
    },
    pullRequest: (ctx, args, parent) => {
      const repo = parent.__repo;
      const item = getItem(repo, Number(args.number));
      return item && item.kind === 'pull' ? issueNode(repo, item) : null;
    },
    pullRequests: (ctx, args, parent) => {
      const repo = parent.__repo;
      let items = listItems(repo, { state: 'all', kind: 'pull' });
      if (Array.isArray(args.states) && args.states.length > 0) {
        const wanted = new Set(args.states.map((s) => String(s).toLowerCase()));
        items = items.filter((item) => wanted.has(item.state));
      }
      if (args.orderBy && typeof args.orderBy === 'object') {
        const direction = args.orderBy.direction === 'ASC' ? 1 : -1;
        items = [...items].sort((a, b) => direction * (a.number - b.number));
      } else {
        items = [...items].sort((a, b) => b.number - a.number);
      }
      const conn = connection(items.map((item) => issueNode(repo, item)), args);
      conn.__typename = 'PullRequestConnection';
      return conn;
    },
  },
  Issue: {
    state: (ctx, _args, parent) => parent.__item.state.toUpperCase(),
    title: (ctx, _args, parent) => parent.__item.title,
    body: (ctx, _args, parent) => parent.__item.body,
    createdAt: (ctx, _args, parent) => iso(parent.__item.createdAt),
    updatedAt: (ctx, _args, parent) => iso(parent.__item.updatedAt),
    closedAt: (ctx, _args, parent) => (parent.__item.closedAt ? iso(parent.__item.closedAt) : null),
    author: () => userNode(),
    repository: (ctx, _args, parent) => repoNode(parent.__repo),
    url: (ctx, _args, parent) => `https://github.com/${parent.__repo.owner}/${parent.__repo.name}/issues/${parent.__item.number}`,
  },
  PullRequest: {
    state: (ctx, _args, parent) => {
      const item = parent.__item;
      if (item.merged) return 'MERGED';
      return item.state.toUpperCase();
    },
    title: (ctx, _args, parent) => parent.__item.title,
    body: (ctx, _args, parent) => parent.__item.body,
    headRefName: (ctx, _args, parent) => parent.__item.head.ref,
    baseRefName: (ctx, _args, parent) => parent.__item.base.ref,
    mergeable: (ctx, _args, parent) => mergeableState(parent.__repo, parent.__item),
    merged: (ctx, _args, parent) => parent.__item.merged,
    mergedAt: (ctx, _args, parent) => (parent.__item.mergedAt ? iso(parent.__item.mergedAt) : null),
    createdAt: (ctx, _args, parent) => iso(parent.__item.createdAt),
    updatedAt: (ctx, _args, parent) => iso(parent.__item.updatedAt),
    author: () => userNode(),
    repository: (ctx, _args, parent) => repoNode(parent.__repo),
    url: (ctx, _args, parent) => `https://github.com/${parent.__repo.owner}/${parent.__repo.name}/pull/${parent.__item.number}`,
    files: (ctx, args, parent) => {
      const files = pullFiles(parent.__repo, parent.__item).map((file) => ({
        __typename: 'PullRequestFile',
        path: file.filename,
        additions: file.additions,
        deletions: file.deletions,
        changeType: file.status.toUpperCase(),
      }));
      const conn = connection(files, args);
      conn.__typename = 'PullRequestFileConnection';
      return conn;
    },
  },
  __Type: {
    fields: (ctx, _args, parent) => {
      const entry = parent.__schema;
      if (!entry || entry.kind !== 'OBJECT' || !entry.fields) return null;
      return entry.fields.map((name) => ({
        __typename: '__Field',
        name,
        type: { __typename: '__Type', name: 'String', kind: 'SCALAR' },
        args: [],
      }));
    },
    enumValues: (ctx, _args, parent) => {
      const entry = parent.__schema;
      if (!entry || entry.kind !== 'ENUM' || !entry.enumValues) return null;
      return entry.enumValues.map((name) => ({ __typename: '__EnumValue', name }));
    },
  },
  __Field: {
    type: (ctx, _args, parent) => parent.type ?? null,
    args: (ctx, _args, parent) => parent.args ?? [],
  },
};

// Fallback resolvers for fields that are plain properties on the resolved
// value (id, databaseId, name, login, ...).
function resolveField(ctx, parent, parentType, field, variables, errors) {
  const responseKey = field.alias ?? field.name;
  const args = resolveArguments(field, variables);
  if (field.name === '__typename') {
    return { key: responseKey, value: parentType };
  }
  const typeResolvers = RESOLVERS[parentType] ?? {};
  let value;
  if (Object.prototype.hasOwnProperty.call(typeResolvers, field.name)) {
    value = typeResolvers[field.name](ctx, args, parent);
  } else if (parent !== null && typeof parent === 'object' && Object.prototype.hasOwnProperty.call(parent, field.name)) {
    value = parent[field.name];
  } else if (parent !== null && typeof parent === 'object' && field.name in parent) {
    value = parent[field.name];
  } else {
    errors.push({ message: `Cannot query field "${field.name}" on type "${parentType}".` });
    return { key: responseKey, value: null, error: true };
  }
  return { key: responseKey, value, args, field };
}

function executeSelectionSet(ctx, parent, parentType, selectionSet, variables, errors, fragments) {
  const out = {};
  for (const selection of selectionSet.selections) {
    if (selection.kind === 'FragmentSpread') {
      const fragment = fragments[selection.name];
      if (!fragment) {
        errors.push({ message: `Unknown fragment "${selection.name}".` });
        continue;
      }
      if (fragment.typeName !== parentType && parentType !== 'Query' && parentType !== 'Mutation') {
        // A fragment on a different type simply does not apply here.
        continue;
      }
      const nested = executeSelectionSet(ctx, parent, parentType, fragment.selectionSet, variables, errors, fragments);
      Object.assign(out, nested);
      continue;
    }
    if (selection.kind === 'InlineFragment') {
      if (selection.typeName && selection.typeName !== parentType) continue;
      const nested = executeSelectionSet(ctx, parent, parentType, selection.selectionSet, variables, errors, fragments);
      Object.assign(out, nested);
      continue;
    }
    const resolved = resolveField(ctx, parent, parentType, selection, variables, errors);
    if (resolved.error) {
      out[resolved.key] = null;
      continue;
    }
    let value = resolved.value;
    if (selection.selectionSet && value !== null && value !== undefined) {
      value = executeValue(ctx, value, selection.selectionSet, variables, errors, fragments);
    }
    out[resolved.key] = value;
  }
  return out;
}

function executeValue(ctx, value, selectionSet, variables, errors, fragments) {
  if (Array.isArray(value)) {
    return value.map((entry) => {
      if (entry === null || entry === undefined) return null;
      const type = entry.__typename ?? 'Object';
      return executeSelectionSet(ctx, entry, type, selectionSet, variables, errors, fragments);
    });
  }
  if (value !== null && typeof value === 'object') {
    const type = value.__typename ?? 'Object';
    return executeSelectionSet(ctx, value, type, selectionSet, variables, errors, fragments);
  }
  return value;
}

function executeOperation(ctx, document, operation, variables) {
  const errors = [];
  const fragments = {};
  for (const definition of document.definitions) {
    if (definition.kind === 'FragmentDefinition') fragments[definition.name] = definition;
  }
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const root = { __typename: rootType };
  if (operation.operation === 'mutation') {
    return executeMutation(ctx, operation, variables, errors, fragments);
  }
  const data = executeSelectionSet(ctx, root, rootType, operation.selectionSet, variables, errors, fragments);
  const response = { data };
  if (errors.length > 0) response.errors = errors;
  return response;
}

function executeMutation(ctx, operation, variables, errors, fragments) {
  // Mutations run their top-level fields in order, each against the store.
  const data = {};
  for (const selection of operation.selectionSet.selections) {
    if (selection.kind !== 'Field') continue;
    const responseKey = selection.alias ?? selection.name;
    const args = resolveArguments(selection, variables);
    const input = args.input ?? {};
    let result = null;
    try {
      if (selection.name === 'createIssue') {
        const decoded = decodeGlobalId(input.repositoryId);
        if (!decoded || decoded.kind !== 'R') throw new Error('repositoryId is not a repository id');
        const dbId = Number(decoded.rest[0]);
        let repo = null;
        for (const candidate of ctx.store.repos.values()) if (candidate.dbId === dbId) repo = candidate;
        if (!repo) throw new Error('repository not found');
        const created = createIssue(ctx.store, repo, { title: input.title, body: input.body ?? '', labels: [] });
        if (created.error) throw new Error(created.error);
        result = { __typename: 'CreateIssuePayload', clientMutationId: input.clientMutationId ?? null, issue: issueNode(repo, created.item) };
      } else if (selection.name === 'closeIssue') {
        const decoded = decodeGlobalId(input.issueId);
        if (!decoded || decoded.kind !== 'I') throw new Error('issueId is not an issue id');
        const [owner, name, numberText] = decoded.rest;
        const repo = getRepo(ctx.store, owner, name);
        const item = repo ? getItem(repo, Number(numberText)) : null;
        if (!item) throw new Error('issue not found');
        item.state = 'closed';
        item.closedAt = EPOCH_SEC;
        item.updatedAt = EPOCH_SEC;
        result = { __typename: 'CloseIssuePayload', clientMutationId: input.clientMutationId ?? null, issue: issueNode(repo, item) };
      } else if (selection.name === 'createPullRequest') {
        const decoded = decodeGlobalId(input.repositoryId);
        if (!decoded || decoded.kind !== 'R') throw new Error('repositoryId is not a repository id');
        const dbId = Number(decoded.rest[0]);
        let repo = null;
        for (const candidate of ctx.store.repos.values()) if (candidate.dbId === dbId) repo = candidate;
        if (!repo) throw new Error('repository not found');
        const created = createPull(ctx.store, repo, {
          title: input.title,
          body: input.body ?? '',
          head: input.headRefName,
          base: input.baseRefName,
        });
        if (created.error) throw new Error(created.error);
        result = { __typename: 'CreatePullRequestPayload', clientMutationId: input.clientMutationId ?? null, pullRequest: issueNode(repo, created.item) };
      } else if (selection.name === 'mergePullRequest') {
        const decoded = decodeGlobalId(input.pullRequestId);
        if (!decoded || decoded.kind !== 'PR') throw new Error('pullRequestId is not a pull request id');
        const [owner, name, numberText] = decoded.rest;
        const repo = getRepo(ctx.store, owner, name);
        const item = repo ? getItem(repo, Number(numberText)) : null;
        if (!item || item.kind !== 'pull') throw new Error('pull request not found');
        const merged = mergePull(repo, item, input.mergeMethod === 'MERGE' ? 'merge' : 'squash');
        if (merged.error) throw new Error(merged.error);
        result = { __typename: 'MergePullRequestPayload', clientMutationId: input.clientMutationId ?? null, pullRequest: issueNode(repo, item) };
      } else if (selection.name === 'addComment') {
        const decoded = decodeGlobalId(input.subjectId);
        if (!decoded || (decoded.kind !== 'I' && decoded.kind !== 'PR')) throw new Error('subjectId is not an issue id');
        const [owner, name, numberText] = decoded.rest;
        const repo = getRepo(ctx.store, owner, name);
        const item = repo ? getItem(repo, Number(numberText)) : null;
        if (!item) throw new Error('issue not found');
        const comment = addComment(ctx.store, repo, item.number, input.body);
        result = {
          __typename: 'AddCommentPayload',
          clientMutationId: input.clientMutationId ?? null,
          commentEdge: {
            __typename: 'IssueCommentEdge',
            node: {
              __typename: 'IssueComment',
              __repo: repo,
              __item: item,
              __comment: comment,
              id: globalId('C', owner, name, item.number, comment.id),
              databaseId: comment.id,
              body: comment.body,
            },
          },
        };
      } else {
        errors.push({ message: `Unknown mutation "${selection.name}".` });
        data[responseKey] = null;
        continue;
      }
    } catch (err) {
      errors.push({ message: err.message });
      data[responseKey] = null;
      continue;
    }
    if (selection.selectionSet && result !== null) {
      data[responseKey] = executeValue(ctx, result, selection.selectionSet, variables, errors, fragments);
    } else {
      data[responseKey] = result;
    }
  }
  const response = { data };
  if (errors.length > 0) response.errors = errors;
  return response;
}

// -------------------------------------------------------------------------------------------
// handler
// -------------------------------------------------------------------------------------------

export function handleGraphql(store, req) {
  if (req.pathname !== '/api/graphql' || req.method !== 'POST') return null;
  let body;
  try {
    body = parseJsonBody(req.body);
  } catch {
    return error(400, 'Problems parsing JSON');
  }
  const ctx = { store };
  const runOne = (operation) => {
    if (!operation || typeof operation.query !== 'string') {
      return { errors: [{ message: 'A query is required.' }] };
    }
    let document;
    try {
      document = parseGraphql(operation.query);
    } catch (err) {
      return { errors: [{ message: err.message }] };
    }
    const variables = operation.variables && typeof operation.variables === 'object' ? operation.variables : {};
    const operations = document.definitions.filter((d) => d.kind === 'OperationDefinition');
    if (operations.length === 0) return { errors: [{ message: 'No operation found.' }] };
    let chosen = operations[0];
    if (operation.operationName) {
      chosen = operations.find((op) => op.name === operation.operationName) ?? chosen;
    }
    // Apply variable defaults.
    const vars = { ...variables };
    for (const def of chosen.variableDefinitions ?? []) {
      if (vars[def.name] === undefined && def.defaultValue !== undefined) {
        vars[def.name] = resolveValue(def.defaultValue, {});
      }
    }
    return executeOperation(ctx, document, chosen, vars);
  };
  if (Array.isArray(body)) {
    return json(200, body.map((operation) => runOne(operation)));
  }
  return json(200, runOne(body));
}
