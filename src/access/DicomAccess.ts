import { logger, naturalize } from "../utils";
import type { JsonData, StudyNatural, SeriesNatural } from "./DicomWebTypes";
const log = logger.commandsLog.getLogger("DicomAccess");

// Abstract base class for DICOM access implementations
export abstract class DicomAccess {
  public static readonly childInfo = {
    childUid: "StudyInstanceUID",
  };

  public readonly url: string;
  public readonly options;

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

  public store(study: StudyAccess): Promise<StudyAccess> {
    const studyDestination = this.add(study.studyUID);
    return studyDestination.store(study);
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
    console.warn(
      "Adding child",
      child.name,
      child.uid,
      "to",
      this.name,
      this.url[0] === "." ? "destination" : "srouce"
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
    console.warn(
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
  public async store(source) {
    log.warn(
      "Storing source",
      this.name,
      source.uid,
      source.url,
      "to destination",
      this.url
    );
    await source.forEach(async (childSource) => {
      log.warn("Got source", this.name, childSource.uid);
      const destChild = this.add(childSource);
      if (!destChild) {
        throw new Error(
          `Unable to create ${childSource.name} ${childSource.uid}`
        );
      }
      await destChild.store(childSource);
    });
    log.warn(
      "Finished storing children for",
      this.name,
      this.uid,
      this.childrenMap.size,
      source.childrenMap.size
    );
    await this.storeCurrentLevel(source);
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

  public storeCurrentLevel(source) {
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
    console.warn("study access url", dicomAccess.url, studyUID);
    this.url = `${dicomAccess.url}/${studyUID}`;
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

  public createAccess(sopUID, natural?) {
    return null;
  }

  public openBulkdata(jsonNode) {
    log.warn("Open bulkdata not implemented");
    return null;
  }
}
