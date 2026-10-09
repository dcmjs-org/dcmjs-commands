// src/part10/Part10DirectoryAccess.js
//
// A plain directory of Part 10 DICOM files served through the DicomAccess
// source interface — so `dicomwebjs download` (and `dcmjs dicomweb`) can
// build a Static-DICOMweb tree straight from .dcm files, no server needed.
//
// The scan does one full parse per file (pixel buffers are not retained;
// frames are re-read on demand with a one-entry cache, so peak memory is
// about one file). Files missing Study/Series/SOP UIDs are skipped with a
// warning, never silently dropped.

import { DicomAccess } from "../access/DicomAccess.js";
import { discoverDicomFiles, readFileArrayBuffer } from "../io.js";
import { logger } from "../utils/index.js";
import dcmjs from "../dcmjsBundle.js";
import { part10ToEntry } from "./part10ToDicomWebJson.js";
import { Part10Study } from "./Part10Study.js";

const { DicomMessage } = dcmjs.data;
const log = logger.commandsLog.getLogger("Part10Directory");
const { dicomIssueLog } = logger;

export class Part10DirectoryAccess extends DicomAccess {
  createAccess(studyUID) {
    return new Part10Study(this, studyUID);
  }

  /** Memoized directory scan: Map<studyUID, Map<seriesUID, Map<sop, entry>>> */
  scan() {
    if (!this._scan) {
      this._scan = this.#doScan();
    }
    return this._scan;
  }

  async #doScan() {
    let files;
    try {
      files = discoverDicomFiles(this.url);
    } catch (err) {
      throw new Error(`cannot read ${this.url}: ${err.message}`);
    }
    if (!files.length) {
      throw new Error(`no DICOM (Part 10) files found under ${this.url}`);
    }

    const groups = new Map();
    const skipped = [];
    for (const filePath of files) {
      let entry = null;
      try {
        const dicomDict = DicomMessage.readFile(readFileArrayBuffer(filePath));
        entry = await part10ToEntry(dicomDict, filePath);
      } catch (err) {
        dicomIssueLog.warn("Skipping unreadable file", filePath, err.message);
        skipped.push({ file: filePath, error: err.message });
        continue;
      }
      if (!entry) {
        dicomIssueLog.warn(
          "Skipping file without Study/Series/SOP UIDs",
          filePath
        );
        skipped.push({ file: filePath, error: "missing identity UIDs" });
        continue;
      }
      let series = groups.get(entry.studyUID);
      if (!series) {
        series = new Map();
        groups.set(entry.studyUID, series);
      }
      let instances = series.get(entry.seriesUID);
      if (!instances) {
        instances = new Map();
        series.set(entry.seriesUID, instances);
      }
      instances.set(entry.sopUID, entry);
    }
    log.info(
      "Scanned",
      files.length,
      "files:",
      groups.size,
      "studies,",
      skipped.length,
      "skipped"
    );
    return { groups, skipped };
  }

  /** One-line description per study, for corrective "not found" errors. */
  async describeStudies() {
    const { groups } = await this.scan();
    const lines = [];
    for (const [studyUID, series] of groups) {
      const first = series.values().next().value.values().next().value;
      const instances = [...series.values()].reduce(
        (sum, m) => sum + m.size,
        0
      );
      const name = first.natural.PatientName;
      lines.push(
        `${studyUID}  (` +
          `${name ? `${name}, ` : ""}` +
          `${first.natural.StudyDescription || "no description"}, ` +
          `${series.size} series / ${instances} instances)`
      );
    }
    return lines;
  }

  /**
   * Pixel data re-read with a one-entry cache: the store walk visits
   * instances sequentially, so caching the last file covers the per-frame
   * loop without holding more than one file's pixels.
   */
  readPixelValue(filePath) {
    if (this._pixelCache?.filePath !== filePath) {
      const dicomDict = DicomMessage.readFile(readFileArrayBuffer(filePath));
      this._pixelCache = {
        filePath,
        value: dicomDict.dict["7FE00010"]?.Value,
      };
    }
    return this._pixelCache.value;
  }
}
