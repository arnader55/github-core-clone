// gitwire.ts — the git object model and smart-HTTP wire, stdlib only.
//
// Everything here is pure bytes: SHA-1 object ids, pkt-line framing, packfiles
// (read and write, plain objects only on the write side; deltas resolved on the
// read side), commit/tree/tag parsing and building, and the fetch-set walk the
// upload-pack fetch path uses. No I/O, no clock, no randomness.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';
const OID_RE = /^[0-9a-f]{40}$/;
export const PKT_LINE_MAX = 65520;

export function isObjectId(value) {
  return typeof value === 'string' && OID_RE.test(value);
}

/** SHA-1 hex of `data`. */
export function sha1hex(data) {
  return createHash('sha1').update(data).digest('hex');
}

/** A git object's id: SHA-1 over `<type> <size>\0` + bytes. */
export function hashObject(type, data) {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return sha1hex(Buffer.concat([header, data]));
}

// -------------------------------------------------------------------------------------------
// pkt-lines
// -------------------------------------------------------------------------------------------

/** One pkt-line: 4 hex digits of (payload length + 4), then the payload. */
export function pktLine(payload) {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = data.length + 4;
  const head = Buffer.alloc(4);
  head.write(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

/** Encode several data lines and end with a flush packet. */
export function pktLines(items) {
  const parts = items.map((item) => pktLine(item));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/**
 * Parse a pkt-line stream. Returns [{kind, payload}] where kind is 'data',
 * 'flush', 'delim' or 'response-end'. Throws on a malformed length prefix.
 */
export function parsePktLines(buf) {
  const out = [];
  let pos = 0;
  while (pos < buf.length) {
    if (pos + 4 > buf.length) throw new Error('truncated pkt-line length');
    const head = buf.subarray(pos, pos + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error(`bad pkt-line length ${JSON.stringify(head)}`);
    const len = parseInt(head, 16);
    if (len === 0) {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      pos += 4;
      continue;
    }
    if (len === 1) {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      pos += 4;
      continue;
    }
    if (len === 2) {
      out.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      pos += 4;
      continue;
    }
    if (len < 4 || pos + len > buf.length) throw new Error('pkt-line length out of range');
    out.push({ kind: 'data', payload: buf.subarray(pos + 4, pos + len) });
    pos += len;
  }
  return out;
}

/** Split parsed pkt-lines into their text lines (without trailing \n), ignoring flush/delim. */
export function pktTextLines(packets) {
  const lines = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  return lines;
}

// -------------------------------------------------------------------------------------------
// object parsing and building
// -------------------------------------------------------------------------------------------

/** Parse a commit's bytes: tree, parents, author/committer lines, message. */
export function parseCommit(data) {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd === -1 ? text : text.slice(0, headEnd);
  const message = headEnd === -1 ? '' : text.slice(headEnd + 2);
  let tree = '';
  const parents = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

/** Parse a tree's bytes into [{mode, name, oid}] in stored order. */
export function parseTree(data) {
  const entries = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    if (space === -1) throw new Error('malformed tree: no mode terminator');
    const mode = data.subarray(pos, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    if (nul === -1 || nul + 21 > data.length) throw new Error('malformed tree: no name terminator');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    pos = nul + 21;
  }
  return entries;
}

/** Parse an annotated tag's bytes. */
export function parseTag(data) {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd === -1 ? text : text.slice(0, headEnd);
  const message = headEnd === -1 ? '' : text.slice(headEnd + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

/** Git's tree sort: entries by name, directories compared as name + '/'. */
export function sortTreeEntries(entries) {
  const key = (entry) => (entry.mode === '40000' ? `${entry.name}/` : entry.name);
  return [...entries].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

/** Build a tree object's bytes from entries (sorted git-style). */
export function buildTree(entries) {
  const parts = [];
  for (const entry of sortTreeEntries(entries)) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Build a commit object's bytes. `who` is "Name <email>"; timestamp is epoch seconds. */
export function buildCommit({ tree, parents = [], message, author, committer, timestamp }) {
  const ts = timestamp ?? Math.floor(Date.now() / 1000);
  const who = author ?? 'ada iversen <adaiversen@example.invalid>';
  const whoC = committer ?? who;
  const lines = [`tree ${tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${who} ${ts} +0000`);
  lines.push(`committer ${whoC} ${ts} +0000`);
  lines.push('');
  lines.push(message.endsWith('\n') ? message : `${message}\n`);
  return Buffer.from(lines.join('\n'), 'utf8');
}

/** Build an annotated tag object's bytes. */
export function buildTag({ object, type, tag, message, tagger, timestamp }) {
  const ts = timestamp ?? Math.floor(Date.now() / 1000);
  const who = tagger ?? 'ada iversen <adaiversen@example.invalid>';
  const lines = [`object ${object}`, `type ${type}`, `tag ${tag}`, `tagger ${who} ${ts} +0000`, ''];
  lines.push(message.endsWith('\n') ? message : `${message}\n`);
  return Buffer.from(lines.join('\n'), 'utf8');
}

// -------------------------------------------------------------------------------------------
// packfiles
// -------------------------------------------------------------------------------------------

const OBJ_COMMIT = 1;
const OBJ_TREE = 2;
const OBJ_BLOB = 3;
const OBJ_TAG = 4;
const OBJ_OFS_DELTA = 6;
const OBJ_REF_DELTA = 7;
const TYPE_TO_NUM = { commit: OBJ_COMMIT, tree: OBJ_TREE, blob: OBJ_BLOB, tag: OBJ_TAG };
const NUM_TO_TYPE = { [OBJ_COMMIT]: 'commit', [OBJ_TREE]: 'tree', [OBJ_BLOB]: 'blob', [OBJ_TAG]: 'tag' };

/** Write a packfile (version 2, plain objects, no deltas) for the given objects. */
export function writePack(objects) {
  const chunks = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  chunks.push(header);
  const body = [];
  for (const object of objects) {
    const typeNum = TYPE_TO_NUM[object.type];
    if (typeNum === undefined) throw new Error(`cannot pack type ${object.type}`);
    const size = object.data.length;
    // varint: low 4 bits of the first byte are the size's low bits, then 7-bit groups.
    const sizeBytes = [];
    let remaining = size;
    let first = (typeNum << 4) | (remaining & 0x0f);
    remaining >>>= 4;
    if (remaining > 0) first |= 0x80;
    sizeBytes.push(first);
    while (remaining > 0) {
      let byte = remaining & 0x7f;
      remaining >>>= 7;
      if (remaining > 0) byte |= 0x80;
      sizeBytes.push(byte);
    }
    body.push(Buffer.from(sizeBytes));
    body.push(deflateSync(object.data));
  }
  const packWithoutTrailer = Buffer.concat([header, ...body]);
  const trailer = createHash('sha1').update(packWithoutTrailer).digest();
  chunks.push(...body, trailer);
  return Buffer.concat(chunks);
}

/** Verify a packfile's trailer checksum. */
export function verifyPackChecksum(pack) {
  if (pack.length < 32) return { ok: false, actual: '', expected: '' };
  const expected = sha1hex(pack.subarray(0, pack.length - 20));
  const actual = pack.subarray(pack.length - 20).toString('hex');
  return { ok: expected === actual, actual, expected };
}

/** Apply a git delta to a base buffer. */
export function applyDelta(base, delta) {
  let pos = 0;
  const readDeltaVarint = () => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos];
      pos += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const srcSize = readDeltaVarint();
  const dstSize = readDeltaVarint();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const out = [];
  let outLen = 0;
  while (pos < delta.length) {
    const op = delta[pos];
    pos += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i += 1) {
        if (op & (1 << i)) {
          offset |= delta[pos] << (8 * i);
          pos += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if (op & (0x10 << i)) {
          size |= delta[pos] << (8 * i);
          pos += 1;
        }
      }
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      outLen += size;
    } else if (op !== 0) {
      out.push(delta.subarray(pos, pos + op));
      outLen += op;
      pos += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== dstSize || outLen !== dstSize) throw new Error('delta result size mismatch');
  return result;
}

/**
 * Read a packfile. `resolveBase(oid)` answers a base object the pack does not
 * carry (a thin pack's base, from the server's store); it may return undefined.
 * Returns {version, declaredCount, objects: Map<oid, {type, data}>, deltaCount}.
 */
export function readPack(pack, resolveBase) {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = pack.readUInt32BE(4);
  const declaredCount = pack.readUInt32BE(8);
  let pos = 12;
  const raw = []; // {typeNum, data, baseOid?, baseOffset?}
  const byOffset = new Map();
  for (let i = 0; i < declaredCount; i += 1) {
    const startOffset = pos;
    if (pos >= pack.length - 20) throw new Error('pack ends before its declared entries');
    let byte = pack[pos];
    pos += 1;
    const typeNum = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[pos];
      pos += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    if (typeNum === OBJ_OFS_DELTA) {
      byte = pack[pos];
      pos += 1;
      let offset = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[pos];
        pos += 1;
        offset = ((offset + 1) << 7) | (byte & 0x7f);
      }
      const baseOffset = startOffset - offset;
      const inflated = inflateAt(pack, pos, size);
      pos = inflated.next;
      raw.push({ typeNum, data: inflated.data, baseOffset });
      byOffset.set(startOffset, raw.length - 1);
    } else if (typeNum === OBJ_REF_DELTA) {
      const baseOid = pack.subarray(pos, pos + 20).toString('hex');
      pos += 20;
      const inflated = inflateAt(pack, pos, size);
      pos = inflated.next;
      raw.push({ typeNum, data: inflated.data, baseOid });
      byOffset.set(startOffset, raw.length - 1);
    } else {
      const inflated = inflateAt(pack, pos, size);
      pos = inflated.next;
      raw.push({ typeNum, data: inflated.data });
      byOffset.set(startOffset, raw.length - 1);
    }
  }
  const objects = new Map();
  let deltaCount = 0;
  const resolve = (index, seen) => {
    const entry = raw[index];
    if (entry.resolved !== undefined) return entry.resolved;
    if (seen.has(index)) throw new Error('delta cycle in pack');
    seen.add(index);
    if (entry.typeNum === OBJ_OFS_DELTA || entry.typeNum === OBJ_REF_DELTA) {
      deltaCount += 1;
      let base = null;
      if (entry.typeNum === OBJ_OFS_DELTA) {
        const baseIndex = byOffset.get(entry.baseOffset);
        if (baseIndex === undefined) throw new Error('ofs-delta base is outside the pack');
        base = resolve(baseIndex, seen);
      } else {
        if (objects.has(entry.baseOid)) {
          base = objects.get(entry.baseOid);
        } else if (resolveBase) {
          base = resolveBase(entry.baseOid) ?? null;
        }
        if (base === null) throw new Error(`ref-delta base ${entry.baseOid} is unknown`);
      }
      const data = applyDelta(base.data, entry.data);
      const resolved = { type: base.type, data };
      entry.resolved = resolved;
      return resolved;
    }
    const type = NUM_TO_TYPE[entry.typeNum];
    if (type === undefined) throw new Error(`unknown pack object type ${entry.typeNum}`);
    const resolved = { type, data: entry.data };
    entry.resolved = resolved;
    return resolved;
  };
  for (let i = 0; i < raw.length; i += 1) {
    const resolved = resolve(i, new Set());
    objects.set(hashObject(resolved.type, resolved.data), resolved);
  }
  return { version, declaredCount, objects, deltaCount };
}

// Inflate one deflate stream starting at `pos`, which must inflate to exactly
// `size` bytes. Returns {data, next}: the inflated bytes and the position just
// past the stream. Node's inflateSync does not report how many bytes it
// consumed, so the stream end is found by binary search: a slice shorter than
// the stream fails (or yields too few bytes), a slice at or past its end yields
// exactly `size` bytes, so the predicate is monotonic in the end position.
function inflateAt(pack, pos, size) {
  const limit = pack.length - 20; // never read into the trailer
  const tryEnd = (end) => {
    try {
      const out = inflateSync(pack.subarray(pos, end));
      return out.length === size ? out : null;
    } catch {
      return null;
    }
  };
  // Exponential probe: a deflate stream for `size` bytes is at most ~size bytes
  // long (plus a few header/block bytes), so the window that contains the stream
  // end is found in a handful of probes on small slices.
  let window = Math.max(32, size + 16);
  let hi = Math.min(limit, pos + window);
  let data = tryEnd(hi);
  while (data === null && hi < limit) {
    window *= 2;
    hi = Math.min(limit, pos + window);
    data = tryEnd(hi);
  }
  if (data === null) throw new Error('deflate stream does not terminate inside the pack');
  // Binary search for the smallest end that inflates to exactly `size` bytes.
  // inflateSync ignores bytes after a complete stream, so "inflates fully" is
  // monotonic in the end position and the smallest such end is the stream end.
  let lo = pos;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tryEnd(mid) !== null) hi = mid;
    else lo = mid + 1;
  }
  return { data: tryEnd(lo), next: lo };
}

// -------------------------------------------------------------------------------------------
// reachability
// -------------------------------------------------------------------------------------------

/**
 * All object ids reachable from `roots` (commits, tags, trees, blobs), using
 * `lookup(oid)` for objects. Throws when a reachable object is missing.
 * `commitInfo(oid)` may answer {parents, tree} for a commit without parsing.
 */
export function collectReachable(roots, lookup, commitInfo) {
  const seen = new Set();
  const stack = [...roots];
  while (stack.length > 0) {
    const oid = stack.pop();
    if (seen.has(oid) || oid === ZERO_OID) continue;
    const object = lookup(oid);
    if (object === undefined) throw new Error(`missing object ${oid}`);
    seen.add(oid);
    if (object.type === 'commit') {
      const info = commitInfo ? commitInfo(oid) : null;
      if (info) {
        if (info.tree) stack.push(info.tree);
        for (const parent of info.parents) stack.push(parent);
      } else {
        const parsed = parseCommit(object.data);
        if (parsed.tree) stack.push(parsed.tree);
        for (const parent of parsed.parents) stack.push(parent);
      }
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue; // gitlink: not stored here
        stack.push(entry.oid);
      }
    } else if (object.type === 'tag') {
      const parsed = parseTag(object.data);
      if (parsed.object) stack.push(parsed.object);
    }
  }
  return seen;
}

/** The commit (or tag target) a ref oid resolves to, following annotated tags. */
export function peelToCommit(oid, lookup) {
  let current = oid;
  for (let hops = 0; hops < 16; hops += 1) {
    const object = lookup(current);
    if (object === undefined || object.type !== 'tag') return current;
    current = parseTag(object.data).object;
  }
  return current;
}

// -------------------------------------------------------------------------------------------
// fetch-set computation
// -------------------------------------------------------------------------------------------

/**
 * Which objects a fetch must send.
 *
 * wants: tip oids the client wants. haves: oids the client holds. shallow:
 * the client's shallow boundary oids. depth: max commit generations from a
 * want (1 = the wants themselves), or null for the full history.
 *
 * Returns {send: Set<oid>, shallow: string[], unshallow: string[]}.
 * `send` holds only objects the client does not already hold (held objects
 * are the haves' closure, except that a shallow boundary's ancestors are NOT
 * held — the client has the boundary commit but not its history).
 */
export function computeSendSet({ wants, haves = [], shallow = [], depth = null, lookup, commitInfo }) {
  const shallowSet = new Set(shallow);
  // Held: the closure of the haves, stopping below shallow boundaries.
  const held = new Set();
  const heldStack = [...haves];
  while (heldStack.length > 0) {
    const oid = heldStack.pop();
    if (held.has(oid) || oid === ZERO_OID) continue;
    const object = lookup(oid);
    if (object === undefined) continue;
    held.add(oid);
    if (object.type === 'commit') {
      const info = commitInfo ? commitInfo(oid) : null;
      const tree = info ? info.tree : parseCommit(object.data).tree;
      const parents = info ? info.parents : parseCommit(object.data).parents;
      if (tree) heldStack.push(tree);
      if (!shallowSet.has(oid)) for (const parent of parents) heldStack.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') heldStack.push(entry.oid);
      }
    } else if (object.type === 'tag') {
      const target = parseTag(object.data).object;
      if (target) heldStack.push(target);
    }
  }
  // Walk from the wants, honouring the depth limit.
  const send = new Set();
  const newShallow = [];
  const queue = []; // [oid, distance]
  for (const want of wants) queue.push([want, 0]);
  const visited = new Set();
  while (queue.length > 0) {
    const [oid, dist] = queue.shift();
    if (oid === ZERO_OID) continue;
    const key = `${oid}:${dist}`;
    if (visited.has(key)) continue;
    visited.add(key);
    const object = lookup(oid);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      if (!held.has(oid)) send.add(oid);
      const target = parseTag(object.data).object;
      if (target) queue.push([target, dist]);
      continue;
    }
    if (object.type !== 'commit') {
      if (!held.has(oid)) send.add(oid);
      continue;
    }
    const info = commitInfo ? commitInfo(oid) : null;
    const tree = info ? info.tree : parseCommit(object.data).tree;
    const parents = info ? info.parents : parseCommit(object.data).parents;
    // A commit at distance d from a want is included only when d < depth.
    // (depth 1 = the wants themselves.) At d == depth - 1 the commit is a new
    // shallow boundary and its parents are not traversed.
    if (depth !== null && dist >= depth) continue;
    if (!held.has(oid)) {
      send.add(oid);
      // The commit's tree and blobs travel with it.
      const treeStack = [tree];
      while (treeStack.length > 0) {
        const treeOid = treeStack.pop();
        if (treeOid === ZERO_OID || held.has(treeOid) || send.has(treeOid)) continue;
        const treeObj = lookup(treeOid);
        if (treeObj === undefined || treeObj.type !== 'tree') continue;
        send.add(treeOid);
        for (const entry of parseTree(treeObj.data)) {
          if (entry.mode === '160000') continue;
          if (entry.mode === '40000') treeStack.push(entry.oid);
          else if (!held.has(entry.oid)) send.add(entry.oid);
        }
      }
    }
    if (depth !== null && dist === depth - 1) {
      if (parents.length > 0 && !newShallow.includes(oid)) newShallow.push(oid);
      continue;
    }
    for (const parent of parents) {
      if (!held.has(parent)) queue.push([parent, dist + 1]);
      else if (shallowSet.has(parent)) queue.push([parent, dist + 1]);
    }
    // A held non-shallow parent is a barrier; a held shallow parent is
    // traversable (its history is what the deepen is buying).
  }
  // Unshallow: a requested shallow boundary whose parents are all present
  // after this fetch (held or sent).
  const unshallow = [];
  for (const boundary of shallow) {
    const object = lookup(boundary);
    if (object === undefined || object.type !== 'commit') continue;
    const info = commitInfo ? commitInfo(boundary) : null;
    const parents = info ? info.parents : parseCommit(object.data).parents;
    if (parents.length === 0) continue;
    if (parents.every((parent) => held.has(parent) || send.has(parent))) unshallow.push(boundary);
  }
  return { send, shallow: newShallow, unshallow };
}

// -------------------------------------------------------------------------------------------
// advertisements and sideband
// -------------------------------------------------------------------------------------------

/** Wrap `data` in sideband band-1 pkt-lines (each pkt-line <= 65520 bytes). */
export function sidebandWrap(data) {
  const parts = [];
  const CHUNK = PKT_LINE_MAX - 4 - 1; // pkt-line header + band byte
  for (let pos = 0; pos < data.length; pos += CHUNK) {
    const slice = data.subarray(pos, Math.min(data.length, pos + CHUNK));
    const framed = Buffer.concat([Buffer.from([1]), slice]);
    parts.push(pktLine(framed));
  }
  return Buffer.concat(parts);
}

/**
 * A v2 capability advertisement body: the service preamble, "version 2" and
 * the capability lines, each pkt-lined, ending with a flush.
 */
export function advertisementV2(capabilities) {
  const lines = ['# service=git-upload-pack\n', 'version 2\n'];
  for (const [key, value] of capabilities) lines.push(value === '' ? `${key}\n` : `${key}=${value}\n`);
  return pktLines(lines);
}

/**
 * A v0 ref advertisement body: the service preamble, then the HEAD line (with
 * the capabilities after NUL) or the capabilities^{} pseudo-ref for an empty
 * repo, then one line per ref plus peeled lines for annotated tags.
 */
export function advertisementV0({ service, refs, headTarget, capabilities }) {
  const lines = [`# service=${service}\n`];
  const caps = capabilities.join(' ');
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    const headOid = headTarget ? (refs.find((ref) => ref.name === headTarget)?.oid ?? ZERO_OID) : ZERO_OID;
    lines.push(`${headOid} HEAD\0${caps}\n`);
    for (const ref of refs) lines.push(`${ref.oid} ${ref.name}\n`);
    for (const ref of refs) {
      if (ref.peeled) lines.push(`${ref.peeled} ${ref.name}^{}\n`);
    }
  }
  return pktLines(lines);
}
