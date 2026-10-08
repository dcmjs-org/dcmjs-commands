// src/pixel/progress.js
//
// Line-based progress on stderr for `transcode` and `wsiresize`. A file with
// many frames gets its own start line and a line at each tenth of its
// frames; small files are reported in batches. Lines, not carriage returns,
// so the output reads the same in a terminal and in a log.

const n = (value) => value.toLocaleString("en-US");

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
   */
  constructor({
    command,
    totalFiles,
    write,
    quiet,
    largeFrames = 500,
    batchFiles = 20,
  }) {
    this.command = command;
    this.totalFiles = totalFiles;
    this.write = quiet ? () => {} : write;
    this.largeFrames = largeFrames;
    this.batchFiles = batchFiles;
    this.fileIndex = 0;
    this.batch = { first: 0, files: 0, frames: 0 };
    this.file = null;
  }

  /** Call when a file's frame count is known. */
  startFile(file, frames) {
    this.fileIndex++;
    this.file = { file, frames, done: 0, nextStep: 1 };
    if (frames >= this.largeFrames) {
      this.flushBatch();
      this.file.large = true;
      this.write(
        `${this.command}: [${this.fileIndex}/${this.totalFiles}] ${file}: ${n(frames)} frames`
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
    if (f.done >= (f.frames * f.nextStep) / 10 && f.done < f.frames) {
      while (f.done >= (f.frames * f.nextStep) / 10) {
        f.nextStep++;
      }
      this.write(
        `  ${n(f.done)}/${n(f.frames)} frames (${Math.floor((f.done / f.frames) * 100)}%)`
      );
    }
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
      this.write(`  ${n(f.frames)}/${n(f.frames)} frames done`);
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
