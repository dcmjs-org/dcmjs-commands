// Abstract base class for DICOM access implementations
export class DicomAccess {
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
  async queryStudy() {
    throw new Error("queryStudy() must be implemented by subclass");
  }

  // Subclasses must implement series query
  async querySeries() {
    throw new Error("querySeries() must be implemented by subclass");
  }
}

export class StudyAccess {
  store;

  async storeSeries(path, seriesAccess) {
    throw new Error("storeSeries() must be implemented by subclass");
  }

  async storeInstances(path, seriesAccess) {
    throw new Error("storeInstances() must be implemented by subclass");
  }

  async storeFrames(path, seriesAccess) {
    throw new Error("storeFrames() must be implemented by subclass");
  }

  async storeBulkData(path, seriesAccess) {
    throw new Error("storeBulkData() must be implemented by subclass");
  }
}
