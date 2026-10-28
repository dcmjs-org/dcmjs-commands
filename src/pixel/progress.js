// src/pixel/progress.js
//
// Line-based progress on stderr for `transcode` and `wsiresize`. A file with
// many frames gets its own start line and a line at each tenth of its
// frames or every 10 seconds; small files are reported in batches. Lines,
// not carriage returns, so the output reads the same in a terminal and in a
// log.

const n = (value) => value.toLocaleString("en-US");

/** 75000 → "1m15s", 4000000 → "1h06m". */
function duration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) {
    return `${s}s`;
  }
  if (s < 3600) {
    return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
  }
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

export class Progress {
  /**
   * @param {object} args
   * @param {string} args.command prefix of each line
   * @param {number} args.totalFiles
   * @param {(line: string) => void} args.write
   * @param {boolean} [args.quiet] print nothing
   * @param {number} [args.largeFrames] frames from which a file is reported
   *   on its own (default 500)
   * @param {number} [args.batchFiles] small files per batch line (default 20)
   * @param {number} [args.intervalMs] longest time between lines of a large
   *   file (default 10 s)
   * @param {() => number} [args.now] clock, for tests
   */
  constructor({
    command,
    totalFiles,
    write,
    quiet,
    largeFrames = 500,
    batchFiles = 20,
    intervalMs = 10000,
    now = Date.now,
  }) {
    this.intervalMs = intervalMs;
    this.now = now;
    this.command = command;
    this.totalFiles = totalFiles;
    this.write = quiet ? () => {} : write;
    this.largeFrames = largeFrames;
    this.batchFiles = batchFiles;
    this.fileIndex = 0;
    this.batch = { first: 0, files: 0, frames: 0 };
    this.file = null;
  }

  /**
   * Call when a file's frame count is known. `tiles` is the number of output
   * tiles (wsiresize), whose encoding can run long after the frames are read.
   */
  startFile(file, frames, { tiles } = {}) {
    this.fileIndex++;
    this.file = { file, frames, done: 0, nextStep: 1, tiles, tilesDone: 0 };
    if (frames >= this.largeFrames) {
      this.flushBatch();
      this.file.large = true;
      this.file.started = this.now();
      this.file.lastLine = this.file.started;
      this.write(
        `${this.command}: [${this.fileIndex}/${this.totalFiles}] ${file}: ` +
          `${n(frames)} frames${tiles ? ` → ${n(tiles)} tiles` : ""}`
      );
    }
  }

  /** Call after each frame of the current file. */
  frame() {
    const f = this.file;
    if (!f?.large) {
      return;
    }
    f.done++;
    let step = false;
    while (f.done >= (f.frames * f.nextStep) / 10) {
      f.nextStep++;
      step = true;
    }
    this.report(step && f.done < f.frames);
  }

  /**
   * Call for each frame copied to a spool before the real work (wsiresize
   * input out of raster order); prints at most once per `intervalMs`.
   */
  spooled() {
    const f = this.file;
    if (!f?.large) {
      return;
    }
    f.spooled = (f.spooled ?? 0) + 1;
    const now = this.now();
    if (now - f.lastLine >= this.intervalMs) {
      f.lastLine = now;
      this.write(
        `  spooled ${n(f.spooled)}/${n(f.frames)} frames (not in raster order), ` +
          duration(now - f.started)
      );
    }
  }

  /** Call after each output tile of the current file. */
  tile() {
    if (this.file?.large) {
      this.file.tilesDone++;
      this.report(false);
    }
  }

  /**
   * Prints a line at a 10% step of the frames, or when `intervalMs` has
   * passed since the last line, so slow encoding never looks stuck.
   */
  report(step) {
    const f = this.file;
    const now = this.now();
    if (!step && now - f.lastLine < this.intervalMs) {
      return;
    }
    f.lastLine = now;
    const elapsed = now - f.started;
    const fraction = f.tiles ? f.tilesDone / f.tiles : f.done / f.frames;
    const left =
      fraction > 0 && elapsed >= 1000
        ? `, about ${duration((elapsed * (1 - fraction)) / fraction)} left`
        : "";
    this.write(
      `  ${n(f.done)}/${n(f.frames)} frames (${Math.floor((f.done / f.frames) * 100)}%)` +
        (f.tiles ? `, ${n(f.tilesDone)}/${n(f.tiles)} tiles` : "") +
        `, ${duration(elapsed)}${left}`
    );
  }

  /** Call when the current file is written (or skipped). */
  endFile() {
    let f = this.file;
    this.file = null;
    if (!f) {
      // No header was reached: no pixel data, or the read failed.
      this.fileIndex++;
      f = { frames: 0 };
    }
    if (f.large) {
      this.write(
        `  ${n(f.frames)}/${n(f.frames)} frames done in ${duration(this.now() - f.started)}`
      );
      return;
    }
    if (!this.batch.files) {
      this.batch.first = this.fileIndex;
    }
    this.batch.files++;
    this.batch.frames += f.frames;
    if (this.batch.files >= this.batchFiles) {
      this.flushBatch();
    }
  }

  /** Prints the pending batch line; call once at the end. */
  flushBatch() {
    const { first, files, frames } = this.batch;
    if (!files) {
      return;
    }
    const range = files === 1 ? `${first}` : `${first}-${first + files - 1}`;
    this.write(
      `${this.command}: [${range}/${this.totalFiles}] ${files} file` +
        `${files === 1 ? "" : "s"}, ${n(frames)} frames`
    );
    this.batch = { first: 0, files: 0, frames: 0 };
  }
}
