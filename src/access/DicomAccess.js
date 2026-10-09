import {
  logger,
  naturalize,
  fixValue,
  getVr,
  getValue,
} from "../utils/index.js";
import { selectSeries, selectInstance } from "./DicomWebTypes.js";

const log = logger.commandsLog.getLogger("DicomAccess");
const { dicomIssueLog } = logger;

/**
 * Abstract base class for DICOM access implementations.
 * @abstract
 */
export class DicomAccess {
  static childInfo = {
    childUid: "StudyInstanceUID",
  };

  static DICOMWEB_OPTIONS = {
    singleStudy: true,
    singleSeries: true,
    part10: false,
    seriesMetadata: true,
    frames: true,
    rendered: false,
    thumbnail: false,
    studyMetadata: false,
    instanceMetadata: false,
    bulkdata: true,
  };

  static PART10_OPTIONS = {
    singleStudy: false,
    singleSeries: false,
    part10: true,
    seriesMetadata: false,
    frames: false,
    rendered: false,
    thumbnail: false,
    studyMetadata: false,
    instanceMetadata: false,
    bulkdata: false,
  };

  studies = new Map();

  constructor(url, options) {
    if (typeof url !== "string") {
      throw new Error(`Invalid URL specified ${url}`);
    }
    this.url = url;
    this.options = { ...options };
  }

  static async createInstance(url, options) {
    const colonIndex = url.indexOf(":");
    const scheme =
      (colonIndex > 1 && url.substring(0, colonIndex)) ||
      options?.scheme ||
      "file";

    if (scheme.startsWith("http")) {
      // Use lazy imports to prevent loops
      const { DicomWebAccess } = await import("./DicomWebAccess.js");
      return new DicomWebAccess(url, options);
    }
    if (scheme.startsWith("file")) {
      // Destinations are always the Static-DICOMweb layout — never sniff
      // them (the default "." could contain stray .dcm files).
      if (!options?.isDestination) {
        const { looksLikeStaticDicomWeb, looksLikePart10Directory } =
          await import("../io.js");
        if (!looksLikeStaticDicomWeb(url) && looksLikePart10Directory(url)) {
          // A plain directory of Part 10 files: serve it as a source.
          const { Part10DirectoryAccess } =
            await import("../part10/Part10DirectoryAccess.js");
          return new Part10DirectoryAccess(url, options);
        }
      }
      const { StaticDicomWebAccess } =
        await import("../staticdicomweb/StaticDicomWebAccess.js");
      // Static dicomweb directory format, basically files in a structure
      // like dicomweb but named so they work in a file system.
      return new StaticDicomWebAccess(url, options);
    }
    log.warn("Unknown scheme", scheme, "for source", url);
    throw new Error(`Unsupported DICOM source: ${url}`);
  }

  async queryStudy(studyInstanceUID) {
    if (typeof this.url !== "string") {
      throw new Error(`Wrong type of url: ${this.url}`);
    }

    const studyAccess = this.add(studyInstanceUID);
    await studyAccess.read();
    return studyAccess;
  }

  add(studyUID) {
    let study = this.studies.get(studyUID);
    if (study) {
      return study;
    }
    study = this.createAccess(studyUID);
    this.studies.set(studyUID, study);
    return study;
  }

  store(study, options) {
    const studyDestination = this.add(study.studyUID);
    return studyDestination.store(study, options);
  }

  /** @abstract Creates a StudyAccess for the given study UID. */
  createAccess(_studyUID) {
    throw new Error("createAccess must be implemented by subclasses");
  }
}

/**
 * Base for the study/series/instance hierarchy. Each level caches its
 * children in childrenMap and knows how to create/read/store them.
 * @abstract
 */
export class ChildType {
  childrenMap = new Map();

  constructor(parent, uid, natural) {
    if (typeof uid !== "string") {
      throw new Error(
        `The provided uid (${JSON.stringify(uid)}) must be a string`
      );
    }
    this.uid = uid;
    this.parent = parent;
    this.dicomAccess = parent.dicomAccess || parent;
    this.natural = natural;
  }

  add(child) {
    if (!child.childrenMap) {
      throw new Error(
        `Use this.addJson to add another child map type to ${JSON.stringify(child)}`
      );
    }
    const { uid } = child;
    if (this.childrenMap.has(uid)) {
      return this.childrenMap.get(uid);
    }
    log.info(
      "Adding child",
      child.name,
      child.uid,
      "to",
      this.name,
      this.url[0] === "." ? "destination" : "source"
    );
    const newChild = this.createAccess(uid, child.natural);
    this.childrenMap.set(uid, newChild);
    return newChild;
  }

  addJson(json) {
    if (json.childrenMap) {
      throw new Error(
        `Use this.add to add an access instance, have ${JSON.stringify(json.constructor?.childInfo)}`
      );
    }
    const { childUid } = this;
    const natural = json[childUid] ? json : naturalize(json);
    const uid = json[childUid];
    log.info(
      "Adding to",
      this.url[0] === "." ? "destination" : "source",
      this.name,
      this.uid,
      uid
    );
    if (this.childrenMap.has(uid)) {
      return this.childrenMap.get(uid);
    }
    const newChild = this.createAccess(uid, natural);
    this.childrenMap.set(uid, newChild);
    return newChild;
  }

  async forEach(childListener) {
    const processed = [];
    const children = await this.queryChildren();
    for (const child of children) {
      processed.push(await childListener(child));
    }
    return processed;
  }

  /**
   * Store data at the current level and children levels (if any)
   */
  async store(source, options) {
    log.info(
      "Storing source",
      this.name,
      source.uid,
      source.url,
      "to destination",
      this.url
    );
    await source.forEach(async (childSource) => {
      log.debug("Got source", this.name, childSource.uid);
      const destChild = this.add(childSource);
      if (!destChild) {
        throw new Error(
          `Unable to create ${childSource.name} ${childSource.uid}`
        );
      }
      await destChild.store(childSource, options);
    });
    log.info(
      "Finished storing children for",
      this.name,
      this.uid,
      this.childrenMap.size,
      source.childrenMap.size
    );
    await this.storeCurrentLevel(source, options);
    return this;
  }

  get name() {
    return this.constructor.thisInfo.name;
  }

  get childUid() {
    return this.constructor.childInfo.childUid;
  }

  /** @abstract Returns the children of this level. */
  queryChildren() {
    throw new Error("queryChildren must be implemented by subclasses");
  }

  /** @abstract Creates a child access object. */
  createAccess(_uid, _natural) {
    throw new Error("createAccess must be implemented by subclasses");
  }

  storeCurrentLevel(_source, _options) {
    log.warn("Storing current level", this.name, "is unimplemented");
  }

  isBulkdata(jsonNode) {
    return jsonNode && jsonNode.BulkDataURI;
  }

  getNatural() {
    if (this.natural) {
      return this.natural;
    }
    if (!this.jsonData) {
      throw new Error("No json data to source for getting natural data");
    }
    this.natural = naturalize(this.jsonData);
    return this.natural;
  }

  /** Gets a child if available */
  getChild() {
    return this.childrenMap.values().find(() => true);
  }
}

/** @abstract */
export class StudyAccess extends ChildType {
  static thisInfo = {
    shortUidName: "studyUID",
    name: "Study",
  };

  static childInfo = {
    childUid: "SeriesInstanceUID",
  };

  constructor(dicomAccess, studyUID, natural) {
    super(dicomAccess, studyUID, natural);
    this.studyUID = studyUID;
    log.debug("study access url", dicomAccess.url, studyUID);
    this.url = `${dicomAccess.url}/studies/${studyUID}`;
  }

  storeStudyData(_source) {
    log.warn("No study store implemented for", this);
  }
}

/**
 * A series access allow getting to the series objects within a study.
 * @abstract
 */
export class SeriesAccess extends ChildType {
  static thisInfo = {
    shortUidName: "seriesUID",
    name: "Series",
  };

  static childInfo = {
    childUid: "SOPInstanceUID",
  };

  constructor(parent, seriesUID, natural) {
    super(parent, seriesUID, natural);
    this.url = `${parent.url}/series/${seriesUID}`;
    this.seriesUID = seriesUID;
  }

  getNumberOfFrames() {
    let numberOfFrames = 0;
    for (const instance of this.childrenMap.values()) {
      const natural = instance.getNatural();
      if (!natural.PhotometricInterpretation) {
        continue;
      }
      const instanceFrames = natural.NumberOfFrames || 1;
      numberOfFrames += instanceFrames;
    }
    return numberOfFrames;
  }

  /** Returns the json data for the current series query */
  createSeriesQuery() {
    const naturalSeries = selectSeries(this.getChild().getNatural());
    naturalSeries.NumberOfSeriesRelatedInstances = this.childrenMap.size;
    naturalSeries.NumberOfFrames = this.getNumberOfFrames();
    return naturalSeries;
  }

  /**
   * Adds all the instance natural items to natural inside the
   * instances object, considering each one as though it were a frame.
   */
  addInstanceNaturalQuery(natural, children = [...this.childrenMap.values()]) {
    natural.Instances = children;
  }
}

export class InstanceAccess extends ChildType {
  static thisInfo = {
    shortUidName: "sopUID",
    name: "Instance",
  };

  static childInfo = {
    childUid: "FrameNumber",
  };

  constructor(parent, sopUID, natural) {
    super(parent, sopUID, natural);
    this.url = `${parent.url}/instances/${sopUID}`;
    this.sopInstanceUID = sopUID;
  }

  async queryChildren() {
    return [];
  }

  async openFrame(_frame = 1, _options) {
    throw new Error("Unsupported operation: openFrame");
  }

  createAccess(_sopUID, _natural) {
    return null;
  }

  openBulkdata(_tag, _jsonNode, _options) {
    throw new Error("Open bulkdata not implemented");
  }

  /** Returns the json data for the current series query */
  createInstanceQuery() {
    return selectInstance(this.getNatural());
  }

  /**
   * Imports BulkDataURI and frame data into the json object.
   */
  async importBulkdata(json, options, fmi) {
    if (!fmi) {
      fmi = {
        "00020010": { vr: "UI", Value: ["1.2.840.10008.1.2.1"] },
      };
    }
    for (const [key, value] of Object.entries(json)) {
      if (value.vr === "SQ" && value.Value) {
        for (const child of value.Value) {
          this.importBulkdata(child, options, fmi);
        }
        continue;
      }
      fixValue(value);
      if (!value.vr || value.vr === "UN") {
        value.vr = getVr(key, value);
      }
      if (value.vr === "CS" && value.Value?.[0]?.length > 16) {
        if (value.Value[0].length !== 17 || value.Value[0][16] !== "\\") {
          dicomIssueLog.warn(
            "Invalid tag",
            key,
            "CS value length>16",
            value.Value
          );
        }
        value.Value[0] = value.Value[0].substring(0, 16);
      }

      if (key === "7FE00010") {
        // Pixel Data
        await this.fillFrames(json, key, value, fmi);
        continue;
      }
      if (value.BulkDataURI) {
        await this.readBulkdata(json, key, value, fmi);
        continue;
      }
      if (!value.Value) {
        value.Value = [];
      }
    }
    return fmi;
  }

  async fillFrames(json, _key, value, fmi) {
    const numberOfFrames = getValue(json, "00280008") || 1;
    value.vr = "OB";

    value.Value = [];
    let useTransferSyntax = getValue(fmi, "00020010");
    for (let frame = 1; frame <= numberOfFrames; frame++) {
      const { buffer, transferSyntaxUID } = await this.openFrame(frame, {
        buffer: true,
      });
      if (!buffer) {
        throw new Error("Unable to read pixel data");
      }
      value.Value.push(buffer);
      useTransferSyntax = transferSyntaxUID || useTransferSyntax;
    }

    fmi["00020010"] = {
      vr: "UI",
      Value: [useTransferSyntax],
    };
  }

  async readBulkdata(json, key, value, _fmi) {
    const bulkdata = await this.openBulkdata(key, value, { asBuffer: true });
    value.Value = [bulkdata.buffer];
  }
}
