import { logger, naturalize, fixValue, getVr, getValue } from "../utils";
import type { JsonData, StudyNatural, SeriesNatural } from "./DicomWebTypes";
import { selectSeries, selectInstance } from "./DicomWebTypes";

const log = logger.commandsLog.getLogger("DicomAccess");
const { dicomIssueLog } = logger;

// Abstract base class for DICOM access implementations
export abstract class DicomAccess {
  public static readonly childInfo = {
    childUid: "StudyInstanceUID",
  };

  public static DICOMWEB_OPTIONS = {
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

  public static PART10_OPTIONS = {
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

  public readonly url: string;
  public readonly options;
  protected client;

  private studies = new Map<string, StudyAccess>();

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
      const { DicomWebAccess } = await import("./DicomWebAccess");
      return new DicomWebAccess(url, options);
    }
    if (scheme.startsWith("file")) {
      const { StaticDicomWebAccess } = await import(
        "../staticdicomweb/StaticDicomWebAccess"
      );
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

  public add(studyUID: string): StudyAccess {
    let study = this.studies.get(studyUID);
    if (study) {
      return study;
    }
    study = this.createAccess(studyUID);
    this.studies.set(studyUID, study);
    return study;
  }

  public store(study: StudyAccess, options): Promise<StudyAccess> {
    const studyDestination = this.add(study.studyUID);
    return studyDestination.store(study, options);
  }

  public abstract createAccess(studyUID: string): StudyAccess;
}

export abstract class ChildType<ParentT, ChildT, NaturalT> {
  public readonly uid: string;
  public url: string;

  public static thisInfo: {
    name: string;
    shortUidName: string;
  };

  public static childInfo: {
    childUid: string;
  };

  public readonly childrenMap = new Map<
    string,
    ChildType<this, ChildT, unknown>
  >();
  public readonly parent: ParentT;
  public jsonData: JsonData;
  public natural?: NaturalT;
  public readonly dicomAccess: DicomAccess;

  constructor(parent: ParentT, uid: string, natural?: NaturalT) {
    if (typeof uid !== "string") {
      throw new Error(
        `The provided uid (${JSON.stringify(uid)}) must be a string`
      );
    }
    this.uid = uid;
    this.parent = parent;
    this.dicomAccess = (parent as any).dicomAccess || parent;
    this.natural = natural;
  }

  public add(child: ChildType<this, ChildT, any>) {
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

  public addJson(json) {
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

  public async forEach(childListener) {
    const processed = [];
    const children = await this.queryChildren();
    for (const child of children) {
      processed.push(await childListener(child));
    }
    return processed;
  }

  /**
   * Store data at hte current level and children levels (if any)
   */
  public async store(source, options) {
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

  public get name() {
    return (this.constructor as any).thisInfo.name;
  }

  public get childUid() {
    return (this.constructor as any).childInfo.childUid;
  }

  public abstract queryChildren(): Promise<ChildT[]>;
  public abstract createAccess(uid: string, natural?: NaturalT);

  public storeCurrentLevel(_source, _options) {
    console.warn("Storing current level", this.name, "is unimplemented");
  }

  public isBulkdata(jsonNode) {
    return jsonNode && jsonNode.BulkDataURI;
  }

  public getNatural() {
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
  public getChild() {
    return this.childrenMap.values().find(() => true);
  }
}

export abstract class StudyAccess extends ChildType<
  DicomAccess,
  SeriesAccess,
  StudyNatural
> {
  public static readonly thisInfo = {
    shortUidName: "studyUID",
    name: "Study",
  };

  public static readonly childInfo = {
    childUid: "SeriesInstanceUID",
  };

  public readonly studyUID: string;
  public readonly url: string;

  constructor(dicomAccess, studyUID, natural?: StudyNormal) {
    super(dicomAccess, studyUID, natural);
    this.studyUID = studyUID;
    log.debug("study access url", dicomAccess.url, studyUID);
    this.url = `${dicomAccess.url}/studies/${studyUID}`;
  }

  public storeStudyData(source: StudyAccess) {
    log.warn("No study store implemented for", this);
  }
}

/**
 * A series access allow getting to the series objects within a study.
 */
export abstract class SeriesAccess extends ChildType<
  StudyAccess,
  InstanceAccess,
  SeriesNatural
> {
  public static readonly thisInfo = {
    shortUidName: "seriesUID",
    name: "Series",
  };

  public static readonly childInfo = {
    childUid: "SOPInstanceUID",
  };

  public readonly seriesUID: string;

  constructor(parent, seriesUID, natural?: SeriesNatural) {
    super(parent, seriesUID, natural);
    this.url = `${parent.url}/series/${seriesUID}`;
    this.seriesUID = seriesUID;
  }

  public getNumberOfFrames() {
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
  public createSeriesQuery() {
    const naturalSeries = selectSeries(this.getChild().getNatural());
    naturalSeries.NumberOfSeriesRelatedInstances = this.childrenMap.size;
    naturalSeries.NumberOfFrames = this.getNumberOfFrames();
    return naturalSeries;
  }

  /**
   * Adds all the instance natural items to natural inside the
   * instances object, considering each one as though it were a frame.
   */
  public addInstanceNaturalQuery(
    natural,
    children = [...this.childrenMap.values()]
  ) {
    natural.Instances = children;
  }
}

export class InstanceAccess extends ChildType<SeriesAccess, object, object> {
  public static readonly thisInfo = {
    shortUidName: "sopUID",
    name: "Instance",
  };

  public static readonly childInfo = {
    childUid: "FrameNumber",
  };

  public readonly sopInstanceUID: string;

  constructor(parent: SeriesAccess, sopUID: string, natural?) {
    super(parent, sopUID, natural);
    this.url = `${parent.url}/instances/${sopUID}`;
    this.sopInstanceUID = sopUID;
  }

  public async queryChildren() {
    return [];
  }

  public async openFrame(frame = 1, _options?) {
    throw new Error("Unsupported operation: openFrame");
  }

  public createAccess(sopUID, natural?) {
    return null;
  }

  public openBulkdata(_tag, _jsonNode, _options) {
    throw new Error("Open bulkdata not implemented");
  }

  /** Returns the json data for the current series query */
  public createInstanceQuery() {
    return selectInstance(this.getNatural());
  }

  /**
   * Imports BulkDataURI and frame data into the json object.
   */
  public async importBulkdata(json, options, fmi?) {
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
        console.warn("Found pixel data", value);
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

  public async fillFrames(json, key, value, fmi) {
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

  public async readBulkdata(json, key, value, fmi) {
    const { buffer } = await this.openBulkdata(key, value, { asBuffer: true });
    value.Value = buffer;
  }
}
