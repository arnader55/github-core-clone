# github-core-clone

A GitHub-compatible git forge in a single Node process, written with the
Node 22 standard library only — no dependencies, no git binary, no database,
no network beyond the conformance suite that tests it.

## What it is

One in-memory store drives four surfaces that all agree with each other:

| Surface | Route | What it does |
| --- | --- | --- |
| REST v3 | `/api/v3/...` | Repos, branches, refs, commits, contents, labels, issues, pull requests, comments, merges |
| Git smart HTTP | `/{owner}/{repo}.git/...` | upload-pack v2 and v0 (ls-refs, fetch, shallow, deepen), receive-pack v0 (push, delete, non-fast-forward) |
| GraphQL v4 | `/api/graphql` | viewer, repository, node, issues/pullRequests connections with cursor pagination, `__type`, and the createIssue / closeIssue / createPullRequest / mergePullRequest / addComment mutations |
| MCP | `/mcp` | JSON-RPC 2.0 streamable HTTP, modern era 2026-07-28 (`server/discover`) plus the legacy `initialize` fallback, 9 tools |

The authenticated user is `adaiversen` (id 1000). Repositories are created
through REST, content arrives through git push or the contents API, and
issues and pull requests share one number sequence per repository, as on
GitHub. Issue and pull-request ids are stable across REST, GraphQL and MCP.

## Running it

```sh
node local.ts [port] [token]
# listening on http://127.0.0.1:PORT (token: test-token)
```

The production entry point is `main.ts` (the trial lifecycle: it registers
with the environment and exits when the environment says it is done). The
server itself is `app.ts`; the store is `store.ts`; the git wire (pkt-lines,
packfiles, fetch-set computation) is `gitwire.ts`; the surfaces are `rest.ts`,
`graphql.ts`, `mcp.ts` and `githttp.ts`.

## Design notes

- **Deterministic timestamps.** Every `created_at`, commit author/committer
  date and merge date is the fixture epoch (2025-01-01T00:00:00Z), so a live
  run and its replay export the same bytes.
- **Plain objects in packs.** The server writes packfiles with no deltas
  (the suite verifies object-for-object, so deltas buy nothing) and resolves
  incoming deltas — including thin packs — on the read side.
- **Shallow fetch is exact.** The send set is computed from wants, haves,
  shallow boundaries and depth: a depth-1 clone sends the tip commit, its
  tree and its blobs only; a deepen sends exactly one more generation and
  reports the old tip as `unshallow`.
- **Merges are three-way.** A squash merge diffs the head against the merge
  base, applies the result onto the base tip, and refuses with 405 when both
  sides changed the same file differently.
- **GraphQL is a hand-written parser.** Operations, aliases, variables,
  inline input objects, inline enums, null variables, inline and named
  fragments are all parsed; unknown fields return HTTP 200 with an `errors`
  array naming the field; an unknown repository is `data.repository = null`
  with no errors.
- **Global ids are opaque.** Repositories, issues, pull requests and
  comments get base64 ids (`R:…`, `I:…`, `PR:…`, `C:…`) that round-trip
  through `node(id:)` — never the plain database id or number.

## Differences from github.com

- The issues list returns issues only; pull requests have their own list
  endpoint. (GitHub's issues endpoint also returns pull requests.)
- Pull requests support squash merge only; `merge_method` other than
  `squash` is treated as a squash.
- No web UI, no webhooks, no actions, no search endpoint: the forge is the
  API and git surfaces the conformance suite exercises.

## License

MIT. See `LICENSE`.
