import { logger } from "../utils";
import type { JsonData, StudyNormal } from "./DicomWebTypes";
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

  public abstract createAccess(studyUID: string): StudyAccess;
}

export abstract class StudyAccess {
  public readonly studyUID: string;
  public readonly dicomAccess: DicomAccess;
  public readonly url: string;

  public studyJson: JsonData;
  public studyNormal: StudyNormal;

  constructor(dicomAccess, studyUID) {
    if (typeof dicomAccess !== "object") {
      throw new Error(`DicomAccess must be an object ${dicomAccess}`);
    }
    this.dicomAccess = dicomAccess;
    this.studyUID = studyUID;
    if (!this.studyUID) {
      throw new Error("studyUID not defined");
    }
    console.warn("study access url", dicomAccess.url, studyUID);
    this.url = `${dicomAccess.url}/${studyUID}`;
  }

  // Store all study-related content to the local SDW structure
  public async store(source) {
    await source.forEachSeries(async (sourceSeries) => {
      log.warn("Got source series", sourceSeries.seriesUID);
      const destSeries = this.add(sourceSeries);
      if (!destSeries) {
        throw new Error(`Unable to create series ${sourceSeries.seriesUID}`);
      }
      await destSeries.store(sourceSeries);
    });
    await this.storeStudyData(source);
  }

  public storeStudyData(source: StudyAccess) {
    log.warn("No study store implemented for", this);
  }

  public abstract querySeries(constraints?): Promise<Array<SeriesAccess>>;

  protected series = new Map<string, SeriesAccess>();

  public add(series) {
    if (this.series.has(series.seriesInstanceUID)) {
      return this.series.get(series.seriesInstanceUID);
    }
    const newSeries = this.createAccess(series);
    this.series.set(series.seriesInstanceUID, newSeries);
    return newSeries;
  }

  public abstract createAccess(series);
}

/**
 * A series access allow getting to the series objects within a study.
 */
export abstract class SeriesAccess {
  public readonly seriesInstanceUID: string;

  protected instances = new Map<string, InstanceAccess>();

  constructor(seriesInstanceUID: string) {
    this.seriesInstanceUID = seriesInstanceUID;
  }

  public add(instance: InstanceAccess) {
    if (this.instances.has(instance.sopInstanceUID)) {
      return this.instances.get(instance.sopInstanceUID);
    }
    const newInstance = this.createAccess(instance);
    this.instances.set(instance.sopInstanceUID, newInstance);
    return newInstance;
  }
}

export class InstanceAccess {
  public readonly sopInstanceUID: string;
  public readonly sopClassUID: string;
}
