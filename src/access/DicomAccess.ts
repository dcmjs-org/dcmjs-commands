import { logger, naturalize } from "../utils";
import type { JsonData, StudyNatural, SeriesNatural } from "./DicomWebTypes";
const log = logger.commandsLog.getLogger("DicomAccess");

// Abstract base class for DICOM access implementations
export abstract class DicomAccess {
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

  public static childInfo: {
    uidName: string;
  };

  public readonly childrenMap = new Map<string, ChildType<this, ChildT>>();
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
    const { uidName } = this.constructor.childInfo;
    console.warn("Adding json data", uidName, !json.StudyInstanceUID && json);
    const natural = json[uidName] ? json : naturalize(json);
    const uid = json[uidName];
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

  public abstract queryChildren(): Promise<ChildT[]>;
  public abstract createAccess(uid: string, natural?: NaturalT);
}

export abstract class StudyAccess extends ChildType<
  DicomAccess,
  SeriesAccess,
  StudyNatural
> {
  public static readonly childInfo = {
    uidName: "StudyInstanceUID",
    shortUidName: "studyUID",
    name: "Study",
  };

  public readonly studyUID: string;
  public readonly url: string;

  constructor(dicomAccess, studyUID, natural?: StudyNormal) {
    super(dicomAccess, studyUID);
    this.studyUID = studyUID;
    console.warn("study access url", dicomAccess.url, studyUID);
    this.url = `${dicomAccess.url}/${studyUID}`;
  }

  // Store all study-related content to the local SDW structure
  public async store(source) {
    log.warn("Storing source", source.studyUID, "to destination", this.url);
    await source.forEach(async (sourceSeries) => {
      log.warn("Got source series", sourceSeries.seriesUID);
      const destSeries = this.add(sourceSeries);
      if (!destSeries) {
        throw new Error(`Unable to create series ${sourceSeries.seriesUID}`);
      }
      await destSeries.store(sourceSeries);
    });
    log.warn("About to store study data");
    await this.storeStudyData(source);
    return this;
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
> {}

export class InstanceAccess extends ChildType<SeriesAccess, object, object> {
  public readonly sopInstanceUID: string;
  public readonly sopClassUID: string;
}
