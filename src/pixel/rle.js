// src/pixel/rle.js
//
// RLE Lossless (1.2.840.10008.1.2.5) encoding, PS3.5 Annex G. The codec
// package only decodes RLE, so the encoder lives here.

const HEADER_BYTES = 64;
const MAX_SEGMENTS = 15;

/**
 * PackBits-encodes `src[start, end)` into `out` at `pos`; returns the new
 * position. Runs of 3 or more equal bytes become replicate runs, everything
 * else literal runs, each at most 128 bytes (PS3.5 G.3.1).
 */
function packBits(src, start, end, out, pos) {
  let i = start;
  while (i < end) {
    let run = 1;
    while (i + run < end && run < 128 && src[i + run] === src[i]) {
      run++;
    }
    if (run >= 3) {
      out[pos++] = 257 - run;
      out[pos++] = src[i];
      i += run;
      continue;
    }
    // A literal run stops where a replicate run of 3 starts.
    let literal = run;
    while (
      i + literal < end &&
      literal < 128 &&
      !(
        i + literal + 2 < end &&
        src[i + literal] === src[i + literal + 1] &&
        src[i + literal] === src[i + literal + 2]
      )
    ) {
      literal++;
    }
    out[pos++] = literal - 1;
    out.set(src.subarray(i, i + literal), pos);
    pos += literal;
    i += literal;
  }
  return pos;
}

/**
 * Encodes one native frame (interleaved samples, little endian) as an RLE
 * frame: a 64-byte header of segment offsets, then one segment per byte
 * plane, most significant byte first (G.2). Each row is encoded separately.
 *
 * Bits Allocated 1 (BINARY segmentations, CP-2301) has one segment: the
 * packed frame bytes, with rows of Columns / 8 bytes when that is whole.
 */
export function encodeRleFrame(pixels, imageInfo) {
  const { rows, columns, bitsAllocated } = imageInfo;
  const samples = imageInfo.samplesPerPixel ?? 1;
  const bytesPerSample = bitsAllocated === 1 ? 1 : bitsAllocated / 8;
  const segments = bitsAllocated === 1 ? 1 : samples * bytesPerSample;
  if (segments > MAX_SEGMENTS) {
    throw new Error(
      `RLE allows ${MAX_SEGMENTS} segments, this frame needs ${segments}`
    );
  }

  let rowLength = columns;
  let rowCount = rows;
  let planes;
  if (bitsAllocated === 1) {
    const frameBytes = pixels.byteLength;
    rowLength = columns % 8 === 0 ? columns / 8 : frameBytes;
    rowCount = frameBytes / rowLength;
    planes = [pixels];
  } else {
    // Byte plane s*bytesPerSample + b holds byte (bytesPerSample-1-b) of
    // sample s: the most significant byte comes first.
    const stride = samples * bytesPerSample;
    const pixelCount = rows * columns;
    planes = [];
    for (let s = 0; s < samples; s++) {
      for (let b = bytesPerSample - 1; b >= 0; b--) {
        const plane = new Uint8Array(pixelCount);
        for (
          let p = 0, o = s * bytesPerSample + b;
          p < pixelCount;
          p++, o += stride
        ) {
          plane[p] = pixels[o];
        }
        planes.push(plane);
      }
    }
  }

  // Worst case: one header byte per 128 literal bytes, plus a byte per row.
  const planeBytes = rowLength * rowCount;
  const out = new Uint8Array(
    HEADER_BYTES +
      segments * (planeBytes + Math.ceil(planeBytes / 128) + rowCount + 1)
  );
  const header = new DataView(out.buffer);
  header.setUint32(0, segments, true);
  let pos = HEADER_BYTES;
  planes.forEach((plane, s) => {
    header.setUint32(4 + s * 4, pos, true);
    for (let r = 0; r < rowCount; r++) {
      pos = packBits(plane, r * rowLength, (r + 1) * rowLength, out, pos);
    }
    if (pos % 2) {
      out[pos++] = 0; // G.3.1: segments are padded to even with zero
    }
  });
  return out.subarray(0, pos);
}
