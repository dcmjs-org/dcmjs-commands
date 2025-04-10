// Abstract base class for DICOM access implementations
export abstract class DicomAccess {
  public readonly url: string;
  public readonly options;

  constructor(url, options) {
    this.options = options;
  }

  static async createInstance(url, options) {
    const colonIndex = url.indexOf(":");
    const scheme =
      (colonIndex > 0 && url.substring(0, colonIndex)) ||
      options?.scheme ||
      "sdw";
    if (scheme.startsWith("http")) {
      // Use lazy imports to prevent loops
      const { DicomWebAccess } = await import("./DicomWebAccess");
      return new DicomWebAccess(url, options);
    }
    if (scheme.startsWith("sdw")) {
      const { StaticDicomWebAccess } = await import(
        "../staticdicomweb/StaticDicomWebAccess"
      );
      // Static dicomweb directory format, basically files in a structure
      // like dicomweb but named so they work in a file system.
      return new StaticDicomWebAccess(url, options);
    }

    throw new Error(`Unsupported DICOM source: ${url}`);
  }

  // Subclasses must implement study query
  abstract queryStudy(studyUID: string): Promise<StudyAccess>;
}

export abstract class StudyAccess {
  public store?: (study, options) => Promise<StudyAccess>;

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
