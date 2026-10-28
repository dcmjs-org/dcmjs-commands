// src/pixel/sizeReport.js
//
// The before/after totals that `transcode` and `wsiresize` print. "Image
// bytes" is the PixelData value (the encoded frames); "header bytes" is the
// rest of each file.

export function emptyTotals() {
  return {
    instances: 0,
    frames: 0,
    headerBytes: 0,
    pixelBytes: 0,
    fileBytes: 0,
  };
}

export function addTotals(totals, { frames, pixelBytes, fileBytes }) {
  totals.instances += 1;
  totals.frames += frames;
  totals.pixelBytes += pixelBytes;
  totals.fileBytes += fileBytes;
  totals.headerBytes += fileBytes - pixelBytes;
  return totals;
}

const n = (value) => value.toLocaleString("en-US");

function change(before, after) {
  if (!before) {
    return "";
  }
  const pct = ((after - before) / before) * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
}

/** Fixed-width table of `before` against `after`. */
export function formatSizeReport(before, after) {
  const columns = [
    ["instances", (t) => t.instances],
    ["frames", (t) => t.frames],
    ["header bytes", (t) => t.headerBytes],
    ["image bytes", (t) => t.pixelBytes],
    ["file bytes", (t) => t.fileBytes],
  ];
  const rows = [
    ["before", ...columns.map(([, get]) => n(get(before)))],
    ["after", ...columns.map(([, get]) => n(get(after)))],
    ["change", ...columns.map(([, get]) => change(get(before), get(after)))],
  ];
  const header = ["", ...columns.map(([label]) => label)];
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length))
  );
  const line = (cells) =>
    "  " +
    cells
      .map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i])))
      .join("   ");
  return [line(header), ...rows.map(line)].join("\n");
}
