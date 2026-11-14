// githttp.ts — the git smart-HTTP surface (/{owner}/{repo}.git).
//
// upload-pack protocol v2 (Git-Protocol: version=2) and v0, receive-pack v0
// only. Packs are plain objects (no deltas) on the write side; deltas are
// resolved on the read side. Every push stores its unpacked objects even when
// a ref update is refused, and the report is sideband-framed band 1.
//
// `handleGit(store, req)` returns a response object or null when the path is
// not a git route.

import {
  getRepo, lookupObject, commitInfo, peel,
  listAdvertisedRefs, getRef, setRef, deleteRef, storeObjects,
} from './store.ts';
import {
  ZERO_OID, isObjectId,
  pktLine, pktLines, parsePktLines, pktTextLines,
  writePack, readPack, verifyPackChecksum,
  collectReachable, computeSendSet,
  sidebandWrap, advertisementV2, advertisementV0,
  PKT_FLUSH,
} from './gitwire.ts';

const UPLOAD_CAPS_V2 = [
  ['agent', 'github-core-clone/1.0'],
  ['ls-refs', 'unborn'],
  ['fetch', 'shallow filter'],
  ['object-format', 'sha1'],
];

function textResponse(status, body, contentType = 'text/plain') {
  return {
    status,
    headers: { 'content-type': contentType, 'x-github-request-id': `git-${Date.now().toString(36)}${Math.floor(Math.random() * 0xffff).toString(16)}` },
    body: typeof body === 'string' ? Buffer.from(body, 'utf8') : body,
  };
}

function gitError(status, message) {
  return textResponse(status, `${message}\n`);
}

/** Is `descendant` a descendant of (or equal to) `ancestor`? */
function isDescendant(repo, descendant, ancestor) {
  if (descendant === ancestor) return true;
  const stack = [descendant];
  const seen = new Set();
  while (stack.length > 0) {
    const oid = stack.pop();
    if (!oid || oid === ZERO_OID || seen.has(oid)) continue;
    seen.add(oid);
    const meta = commitInfo(repo, oid);
    if (!meta) continue;
    for (const parent of meta.parents) {
      if (parent === ancestor) return true;
      stack.push(parent);
    }
  }
  return false;
}

export function handleGit(store, req) {
  const { method, pathname, query } = req;
  const match = /^\/([^/]+)\/([^/]+)\.git\/(.+)$/.exec(pathname);
  if (!match) return null;
  const owner = decodeURIComponent(match[1]);
  const repoName = decodeURIComponent(match[2]);
  const rest = match[3];
  const repo = getRepo(store, owner, repoName);
  if (repo === null) return gitError(404, 'Not Found');
  const headTarget = `refs/heads/${repo.defaultBranch}`;

  // ---- info/refs --------------------------------------------------------
  if (rest === 'info/refs' && method === 'GET') {
    const service = query.get('service') ?? '';
    if (service === 'git-upload-pack') {
      const protocol = String(req.headers['git-protocol'] ?? '');
      if (protocol.includes('version=2')) {
        return textResponse(200, advertisementV2(UPLOAD_CAPS_V2), 'application/x-git-upload-pack-advertisement');
      }
      const refs = listAdvertisedRefs(repo);
      const caps = [
        `symref=HEAD:${headTarget}`,
        'side-band-64k',
        'thin-pack',
        'ofs-delta',
        'agent=github-core-clone/1.0',
      ];
      return textResponse(200, advertisementV0({ service: 'git-upload-pack', refs, headTarget, capabilities: caps }), 'application/x-git-upload-pack-advertisement');
    }
    if (service === 'git-receive-pack') {
      const refs = listAdvertisedRefs(repo);
      const caps = ['report-status', 'side-band-64k', 'delete-refs', 'agent=github-core-clone/1.0'];
      return textResponse(200, advertisementV0({ service: 'git-receive-pack', refs, headTarget, capabilities: caps }), 'application/x-git-receive-pack-advertisement');
    }
    return gitError(400, 'unknown service');
  }

  // ---- git-upload-pack --------------------------------------------------
  if (rest === 'git-upload-pack' && method === 'POST') {
    let packets;
    try {
      packets = parsePktLines(req.body ?? Buffer.alloc(0));
    } catch {
      return gitError(400, 'malformed pkt-line stream');
    }
    const protocol = String(req.headers['git-protocol'] ?? '');
    const lookup = (oid) => repo.objects.get(oid);
    const ci = (oid) => repo.commitMeta.get(oid);
    if (protocol.includes('version=2')) {
      return handleUploadPackV2(repo, packets, lookup, ci);
    }
    return handleUploadPackV0(repo, packets, lookup, ci);
  }

  // ---- git-receive-pack -------------------------------------------------
  if (rest === 'git-receive-pack' && method === 'POST') {
    return handleReceivePack(repo, req.body ?? Buffer.alloc(0));
  }

  return gitError(404, 'Not Found');
}

// -------------------------------------------------------------------------------------------
// upload-pack v2
// -------------------------------------------------------------------------------------------

function handleUploadPackV2(repo, packets, lookup, ci) {
  // A v2 request is a list of commands. Each command is its command line,
  // then capability lines (agent=, object-format=), then a delim packet, then
  // the command's argument lines, then a flush packet. A client that omits
  // the delim is tolerated: the handlers only act on recognised lines.
  const commands = [];
  let current = null;
  let afterDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      if (current) commands.push(current);
      current = null;
      afterDelim = false;
      continue;
    }
    if (packet.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (current === null) {
      current = { name: line, lines: [] };
      afterDelim = false;
    } else {
      current.lines.push(line);
    }
  }
  if (current) commands.push(current);
  const command = commands[0];
  if (!command) return gitError(400, 'no command');
  if (command.name === 'command=ls-refs') return lsRefsResponse(repo, command.lines);
  if (command.name === 'command=fetch') return fetchResponseV2(repo, command.lines, lookup, ci);
  return gitError(400, `unknown command ${command.name}`);
}

function lsRefsResponse(repo, args) {
  let wantPeel = false;
  let wantSymrefs = false;
  let wantUnborn = false;
  const prefixes = [];
  for (const arg of args) {
    if (arg === 'peel') wantPeel = true;
    else if (arg === 'symrefs') wantSymrefs = true;
    else if (arg === 'unborn') wantUnborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
    // agent= and object-format= are accepted and ignored (sha1 only).
  }
  const refs = listAdvertisedRefs(repo);
  const lines = [];
  const matches = (name) => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  if (refs.length === 0) {
    if (wantUnborn && matches('HEAD')) {
      lines.push(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
    }
  } else {
    const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? ZERO_OID;
    if (matches('HEAD')) {
      let line = `${headOid} HEAD`;
      if (wantSymrefs) line += ` symref-target:refs/heads/${repo.defaultBranch}`;
      lines.push(`${line}\n`);
    }
    for (const ref of refs) {
      if (!matches(ref.name)) continue;
      let line = `${ref.oid} ${ref.name}`;
      if (wantPeel && ref.peeled) line += ` peeled:${ref.peeled}`;
      lines.push(`${line}\n`);
    }
  }
  return textResponse(200, pktLines(lines), 'application/x-git-upload-pack-result');
}

function fetchResponseV2(repo, args, lookup, ci) {
  const wants = [];
  const haves = [];
  const shallow = [];
  let depth = null;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) {
      const n = Number.parseInt(arg.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) depth = n;
    }
    // thin-pack, no-progress, ofs-delta, filter, done: accepted, no action.
  }
  if (wants.length === 0) return gitError(400, 'fetch without want');
  const { send, shallow: newShallow, unshallow } = computeSendSet({
    wants, haves, shallow, depth, lookup, commitInfo: ci,
  });
  const objects = [...send].map((oid) => {
    const object = lookup(oid);
    return { type: object.type, data: object.data };
  });
  const pack = writePack(objects);
  const parts = [];
  // Section: acknowledgments.
  parts.push(pktLine('acknowledgments\n'));
  const acked = haves.find((have) => lookup(have) !== undefined);
  parts.push(pktLine(acked ? `ACK ${acked}\n` : 'NAK\n'));
  parts.push(PKT_FLUSH);
  // Section: shallow-info.
  parts.push(pktLine('shallow-info\n'));
  for (const oid of newShallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(PKT_FLUSH);
  // Section: packfile.
  parts.push(pktLine('packfile\n'));
  parts.push(sidebandWrap(pack));
  parts.push(PKT_FLUSH);
  return textResponse(200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

// -------------------------------------------------------------------------------------------
// upload-pack v0
// -------------------------------------------------------------------------------------------

function handleUploadPackV0(repo, packets, lookup, ci) {
  const wants = [];
  const haves = [];
  const shallow = [];
  let depth = null;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) depth = n;
    }
    // 'done' ends the request; anything else is ignored.
  }
  if (wants.length === 0) return gitError(400, 'fetch without want');
  const { send, shallow: newShallow, unshallow } = computeSendSet({
    wants, haves, shallow, depth, lookup, commitInfo: ci,
  });
  const objects = [...send].map((oid) => {
    const object = lookup(oid);
    return { type: object.type, data: object.data };
  });
  const pack = writePack(objects);
  const parts = [];
  const acked = haves.find((have) => lookup(have) !== undefined);
  parts.push(pktLine(acked ? `ACK ${acked}\n` : 'NAK\n'));
  for (const oid of newShallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(sidebandWrap(pack));
  parts.push(PKT_FLUSH);
  return textResponse(200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

// -------------------------------------------------------------------------------------------
// receive-pack v0
// -------------------------------------------------------------------------------------------

function handleReceivePack(repo, body) {
  // Split the pkt-line section from the pack: the section ends at the first
  // flush packet; everything after it is the raw pack (absent for delete-only).
  let packets;
  let packStart = body.length;
  try {
    let pos = 0;
    const parsed = [];
    while (pos < body.length) {
      if (pos + 4 > body.length) throw new Error('truncated pkt-line');
      const head = body.subarray(pos, pos + 4).toString('ascii');
      if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error('bad pkt-line length');
      const len = parseInt(head, 16);
      if (len === 0) {
        parsed.push({ kind: 'flush', payload: Buffer.alloc(0) });
        pos += 4;
        packStart = pos;
        break;
      }
      if (len < 4 || pos + len > body.length) throw new Error('pkt-line length out of range');
      parsed.push({ kind: 'data', payload: body.subarray(pos + 4, pos + len) });
      pos += len;
    }
    packets = parsed;
  } catch {
    return gitError(400, 'malformed pkt-line stream');
  }
  const lines = pktTextLines(packets);
  if (lines.length === 0) return gitError(400, 'empty receive-pack request');
  // The first command line carries the capabilities after a NUL.
  const commands = [];
  for (const line of lines) {
    const clean = line.split('\0')[0];
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(clean);
    if (!match) return gitError(400, 'malformed ref update line');
    commands.push({ oldOid: match[1], newOid: match[2], ref: match[3] });
  }
  // Unpack first: every object lands in the store even when a ref is refused.
  const packBytes = body.subarray(packStart);
  if (packBytes.length > 0) {
    let unpacked;
    try {
      unpacked = readPack(packBytes, (oid) => repo.objects.get(oid));
    } catch {
      return gitError(400, 'malformed packfile');
    }
    const checksum = verifyPackChecksum(packBytes);
    if (!checksum.ok) return gitError(400, 'pack checksum mismatch');
    storeObjects(repo, unpacked.objects);
  }
  // Then the ref updates, one at a time.
  const report = ['unpack ok\n'];
  for (const { oldOid, newOid, ref } of commands) {
    const current = repo.refs.get(ref) ?? ZERO_OID;
    let reason = null;
    if (oldOid !== current) {
      reason = 'non-fast-forward';
    } else if (newOid === ZERO_OID) {
      // Delete: old matched, so this is a clean delete.
      reason = null;
    } else if (current !== ZERO_OID && !isDescendant(repo, newOid, current)) {
      reason = 'non-fast-forward';
    } else if (!repo.objects.has(newOid)) {
      reason = 'object not found';
    }
    if (reason !== null) {
      report.push(`ng ${ref} ${reason}\n`);
      continue;
    }
    if (newOid === ZERO_OID) deleteRef(repo, ref);
    else setRef(repo, ref, newOid);
    report.push(`ok ${ref}\n`);
  }
  const response = Buffer.concat([sidebandWrap(Buffer.from(report.join(''), 'utf8')), PKT_FLUSH]);
  return textResponse(200, response, 'application/x-git-receive-pack-result');
}
