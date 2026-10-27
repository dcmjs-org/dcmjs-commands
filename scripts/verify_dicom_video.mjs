#!/usr/bin/env node
// Streaming verifier for the fragmentable DICOM video fixture (Supplement 225).
// Plain Node, no dcmjs imports — an independent cross-implementation check of
// build_dicom_video.py output (and, later, of `dcmjs encode` output).
//
// Walks the Part 10 structure with a constant-size read buffer, asserts the
// Sup 225 requirements (undefined-length Pixel Data, empty Basic Offset Table,
// even fragment lengths, sequence delimiter, (7FE0,0003) total), then proves
// requirement 8 by SHA-256: the concatenated fragment values, truncated to the
// declared total, must hash identically to the source MP4.
//
// Usage: node verify_dicom_video.mjs FILE.dcm SOURCE.mp4
// Run under `/usr/bin/time -l` to confirm peak RSS stays bounded.

import { openSync, readSync, closeSync, fstatSync } from 'node:fs';
import { createHash } from 'node:crypto';

const LONG_VRS = new Set(['OB', 'OW', 'OF', 'OD', 'OL', 'OV', 'SQ', 'UC', 'UR', 'UT', 'UN', 'UV']);
const CHUNK = 8 * 1024 * 1024;

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

class Reader {
  constructor(path) {
    this.fd = openSync(path, 'r');
    this.pos = 0;
    this.size = fstatSync(this.fd).size;
  }

  read(n) {
    const buf = Buffer.alloc(n);
    this.readInto(buf, n);
    return buf;
  }

  readInto(buf, n) {
    const got = readSync(this.fd, buf, 0, n, this.pos);
    if (got !== n) fail(`unexpected EOF at offset ${this.pos} (wanted ${n} bytes, got ${got})`);
    this.pos += n;
  }

  skip(n) {
    this.pos += n;
  }

  close() {
    closeSync(this.fd);
  }
}

function sha256File(path) {
  const reader = new Reader(path);
  const hash = createHash('sha256');
  const buf = Buffer.alloc(CHUNK);
  let left = reader.size;
  while (left > 0) {
    const n = Math.min(CHUNK, left);
    reader.readInto(buf, n);
    hash.update(buf.subarray(0, n));
    left -= n;
  }
  reader.close();
  return hash.digest('hex');
}

const [dcmPath, srcPath] = process.argv.slice(2);
if (!dcmPath || !srcPath) {
  console.error('usage: node verify_dicom_video.mjs FILE.dcm SOURCE.mp4');
  process.exit(2);
}

const r = new Reader(dcmPath);
const preamble = r.read(132);
if (preamble.toString('latin1', 128) !== 'DICM') fail('not a DICOM Part 10 file');

let declaredTotal = null;
let transferSyntax = null;
for (;;) {
  const head = r.read(8);
  const group = head.readUInt16LE(0);
  const elem = head.readUInt16LE(2);
  const vr = head.toString('latin1', 4, 6);
  const length = LONG_VRS.has(vr) ? r.read(4).readUInt32LE(0) : head.readUInt16LE(6);

  if (group === 0x7fe0 && elem === 0x0003) {
    if (vr !== 'UV' || length !== 8) fail(`(7FE0,0003) must be VR UV length 8, got ${vr}/${length}`);
    declaredTotal = Number(r.read(8).readBigUInt64LE(0));
  } else if (group === 0x7fe0 && elem === 0x0010) {
    if (vr !== 'OB') fail(`Pixel Data VR must be OB, got ${vr}`);
    if (length !== 0xffffffff) fail('Pixel Data must have undefined length (FFFFFFFF)');
    break;
  } else if (group === 0x0002 && elem === 0x0010) {
    transferSyntax = r.read(length).toString('latin1').replace(/\0+$/, '');
  } else {
    r.skip(length);
  }
}
if (declaredTotal === null) fail('(7FE0,0003) not found before Pixel Data');

let itemHead = r.read(8);
if (itemHead.readUInt16LE(0) !== 0xfffe || itemHead.readUInt16LE(2) !== 0xe000) {
  fail('expected Basic Offset Table item after Pixel Data');
}
if (itemHead.readUInt32LE(4) !== 0) fail('Basic Offset Table must be empty');

const hash = createHash('sha256');
const buf = Buffer.alloc(CHUNK);
const fragments = [];
let fed = 0;
for (;;) {
  itemHead = r.read(8);
  const group = itemHead.readUInt16LE(0);
  const elem = itemHead.readUInt16LE(2);
  const length = itemHead.readUInt32LE(4);
  if (group === 0xfffe && elem === 0xe0dd) {
    if (length !== 0) fail('Sequence Delimiter Item must have length 0');
    break;
  }
  if (group !== 0xfffe || elem !== 0xe000) {
    fail(`unexpected tag in Pixel Data at offset ${r.pos - 8}: (${group.toString(16)},${elem.toString(16)})`);
  }
  if (length % 2) fail(`fragment ${fragments.length + 1} has odd length ${length}`);
  fragments.push(length);
  let left = length;
  while (left > 0) {
    const n = Math.min(CHUNK, left);
    r.readInto(buf, n);
    const take = Math.min(n, Math.max(0, declaredTotal - fed));
    if (take > 0) {
      hash.update(buf.subarray(0, take));
      fed += take;
    }
    left -= n;
  }
}
if (r.pos !== r.size) fail(`${r.size - r.pos} trailing byte(s) after Sequence Delimiter`);
r.close();

const fragmentSum = fragments.reduce((a, b) => a + b, 0);
const fmt = n => n.toLocaleString('en-US');
console.log(`transfer syntax: ${transferSyntax}`);
console.log(
  `fragments: ${fragments.length} (${fragments.slice(0, 3).map(fmt).join(', ')}${fragments.length > 3 ? ', …' : ''})`
);
console.log(
  `declared (7FE0,0003): ${fmt(declaredTotal)}  reconstructed: ${fmt(fed)}  padding: ${fragmentSum - declaredTotal} byte(s)`
);
if (fed !== declaredTotal) fail('reconstructed byte count differs from declared total');

const reconstructed = hash.digest('hex');
const source = sha256File(srcPath);
console.log(`sha256 source:        ${source}`);
console.log(`sha256 reconstructed: ${reconstructed}`);
if (reconstructed !== source) fail('MISMATCH — reconstructed stream differs from source');
console.log('MATCH — byte-identical round trip');
