#!/usr/bin/env python3
"""Build a fragmentable DICOM video SOP Instance (Supplement 225) from an MP4.

Produces a Part 10 file, Explicit VR Little Endian, transfer syntax
1.2.840.10008.1.2.4.104.1 (MPEG-4 AVC/H.264 High Profile / Level 4.2 For 2D
Video, Fragmentable). The MP4 byte stream is split into consecutive Pixel Data
fragments that are byte ranges of ONE stream. Streaming: constant memory,
8 MiB chunks. Deliberately independent of dcmjs (this file is the reference
oracle its future `encode` command is verified against).

Usage:
    python3 build_dicom_video.py build IN.mp4 OUT.dcm \
        [--fragment-bytes N] [--frames N]

See EXAMPLES.md ("Trust, but verify" and "Obtaining the large test fixtures").
"""
import argparse
import struct
import uuid
from pathlib import Path

CHUNK = 8 * 1024 * 1024
TSUID = '1.2.840.10008.1.2.4.104.1'
SOP_CLASS = '1.2.840.10008.5.1.4.1.1.77.1.4.1'  # Video Photographic Image Storage
IMPL_CLASS = '2.25.734992827155631017894333721952'
LONG_VRS = {'OB', 'OW', 'OF', 'OD', 'OL', 'OV', 'SQ', 'UC', 'UR', 'UT', 'UN', 'UV'}


def new_uid():
    return '2.25.' + str(uuid.uuid4().int)


def element(group, elem, vr, value):
    if len(value) % 2:
        value += b'\x00' if vr in ('UI', 'OB') else b' '
    head = struct.pack('<HH', group, elem) + vr.encode('ascii')
    if vr in LONG_VRS:
        return head + b'\x00\x00' + struct.pack('<I', len(value)) + value
    return head + struct.pack('<H', len(value)) + value


def txt(group, elem, vr, s):
    return element(group, elem, vr, s.encode('ascii'))


def us(group, elem, v):
    return element(group, elem, 'US', struct.pack('<H', v))


def file_meta(sop_instance_uid):
    body = b''.join([
        element(0x0002, 0x0001, 'OB', b'\x00\x01'),
        txt(0x0002, 0x0002, 'UI', SOP_CLASS),
        txt(0x0002, 0x0003, 'UI', sop_instance_uid),
        txt(0x0002, 0x0010, 'UI', TSUID),
        txt(0x0002, 0x0012, 'UI', IMPL_CLASS),
        txt(0x0002, 0x0013, 'SH', 'LARGE-FILES'),
    ])
    return element(0x0002, 0x0000, 'UL', struct.pack('<I', len(body))) + body


def dataset(uids, frames, total_len):
    return b''.join([
        txt(0x0008, 0x0016, 'UI', SOP_CLASS),
        txt(0x0008, 0x0018, 'UI', uids['sop']),
        txt(0x0008, 0x0020, 'DA', '20220324'),
        txt(0x0008, 0x0030, 'TM', '131424'),
        txt(0x0008, 0x0060, 'CS', 'XC'),
        txt(0x0010, 0x0010, 'PN', 'BACKPRESSURE^TEST'),
        txt(0x0010, 0x0020, 'LO', 'BP-001'),
        txt(0x0018, 0x0040, 'IS', '60'),
        txt(0x0018, 0x1063, 'DS', '16.666667'),
        txt(0x0020, 0x000D, 'UI', uids['study']),
        txt(0x0020, 0x000E, 'UI', uids['series']),
        txt(0x0020, 0x0010, 'SH', '1'),
        txt(0x0020, 0x0011, 'IS', '1'),
        txt(0x0020, 0x0013, 'IS', '1'),
        us(0x0028, 0x0002, 3),
        txt(0x0028, 0x0004, 'CS', 'YBR_PARTIAL_420'),
        us(0x0028, 0x0006, 0),
        txt(0x0028, 0x0008, 'IS', str(frames)),
        us(0x0028, 0x0010, 1080),
        us(0x0028, 0x0011, 1920),
        us(0x0028, 0x0100, 8),
        us(0x0028, 0x0101, 8),
        us(0x0028, 0x0102, 7),
        us(0x0028, 0x0103, 0),
        txt(0x0028, 0x2110, 'CS', '01'),
        # Encapsulated Pixel Data Value Total Length: exact stream length,
        # excluding the trailing pad byte on the final fragment (Sup 225 req 6)
        element(0x7FE0, 0x0003, 'UV', struct.pack('<Q', total_len)),
    ])


def item(length):
    return struct.pack('<HHI', 0xFFFE, 0xE000, length)


def build(args):
    src, out = Path(args.src), Path(args.out)
    total = src.stat().st_size
    frag = args.fragment_bytes
    if frag % 2:
        raise SystemExit('--fragment-bytes must be even (fragment lengths must be even)')
    if not 0 < frag < 0xFFFFFFFE:
        raise SystemExit('--fragment-bytes must fit a 32-bit item length')
    uids = {'sop': new_uid(), 'study': new_uid(), 'series': new_uid()}
    with src.open('rb') as fin, out.open('wb') as fout:
        fout.write(b'\x00' * 128 + b'DICM')
        fout.write(file_meta(uids['sop']))
        fout.write(dataset(uids, args.frames, total))
        # Pixel Data (7FE0,0010) OB, undefined length (Sup 225 req 4)
        fout.write(struct.pack('<HH', 0x7FE0, 0x0010) + b'OB\x00\x00'
                   + struct.pack('<I', 0xFFFFFFFF))
        fout.write(item(0))  # empty Basic Offset Table (req 5)
        remaining, index = total, 0
        while remaining > 0:
            n = min(frag, remaining)
            padded = n + (n % 2)
            fout.write(item(padded))
            left = n
            while left:
                chunk = fin.read(min(CHUNK, left))
                if not chunk:
                    raise SystemExit('source file shrank while reading')
                fout.write(chunk)
                left -= len(chunk)
            if n % 2:
                fout.write(b'\x00')
            index += 1
            note = ' (includes 1 pad byte)' if n % 2 else ''
            print(f'fragment {index}: {padded:,} bytes{note}')
            remaining -= n
        fout.write(struct.pack('<HHI', 0xFFFE, 0xE0DD, 0))  # Sequence Delimiter (req 7)
    print(f'SOP Instance UID: {uids["sop"]}')
    print(f'(7FE0,0003) total length: {total:,}')
    print(f'wrote {out}: {out.stat().st_size:,} bytes, {index} fragments')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='cmd', required=True)
    b = sub.add_parser('build', help='encapsulate an MP4 as a fragmentable DICOM instance')
    b.add_argument('src')
    b.add_argument('out')
    b.add_argument('--fragment-bytes', type=int, default=1 << 30)
    b.add_argument('--frames', type=int, default=208948)
    b.set_defaults(fn=build)
    args = parser.parse_args()
    args.fn(args)


if __name__ == '__main__':
    main()
