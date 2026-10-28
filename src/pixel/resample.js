// src/pixel/resample.js
//
// 8-bit interleaved image helpers for `wsiresize`. Images are
// `{ data: Uint8Array, width, height, spp }`, rows packed with no padding.

/**
 * Area-average (box) downsample by an integer `factor`. Blocks at the right
 * and bottom edges average only the pixels they hold, so a partial block
 * does not pull in padding.
 */
export function downsampleBox({ data, width, height, spp }, factor) {
  const outWidth = Math.ceil(width / factor);
  const outHeight = Math.ceil(height / factor);
  const out = new Uint8Array(outWidth * outHeight * spp);
  const sums = new Uint32Array(outWidth * spp);
  const counts = new Uint32Array(outWidth);

  for (let oy = 0; oy < outHeight; oy++) {
    sums.fill(0);
    counts.fill(0);
    const yEnd = Math.min(height, (oy + 1) * factor);
    for (let y = oy * factor; y < yEnd; y++) {
      let i = y * width * spp;
      for (let x = 0; x < width; x++) {
        const ox = (x / factor) | 0;
        counts[ox]++;
        for (let c = 0; c < spp; c++) {
          sums[ox * spp + c] += data[i++];
        }
      }
    }
    const row = oy * outWidth * spp;
    for (let ox = 0; ox < outWidth; ox++) {
      const half = counts[ox] >> 1;
      for (let c = 0; c < spp; c++) {
        out[row + ox * spp + c] = (sums[ox * spp + c] + half) / counts[ox];
      }
    }
  }
  return { data: out, width: outWidth, height: outHeight, spp };
}

/**
 * Copies the `w` x `h` rectangle at (`sx`, `sy`) of `src` to (`dx`, `dy`)
 * of `dst`, clipped to both images.
 */
export function copyRect(src, sx, sy, dst, dx, dy, w, h) {
  const { spp } = src;
  const width = Math.min(w, src.width - sx, dst.width - dx);
  const height = Math.min(h, src.height - sy, dst.height - dy);
  if (width <= 0 || height <= 0) {
    return;
  }
  for (let row = 0; row < height; row++) {
    const from = ((sy + row) * src.width + sx) * spp;
    dst.data.set(
      src.data.subarray(from, from + width * spp),
      ((dy + row) * dst.width + dx) * spp
    );
  }
}
