import { writeStream, logger } from "../utils";
import { InstanceAccess } from "../access/DicomAccess";
import { promises as fs } from "fs";

const log = logger.commandsLog.getLogger("StaticDicomWeb", "Series");

export class StaticDicomWebInstance extends InstanceAccess {
  public async storeCurrentLevel(source: InstanceAccess): void {
    if (!source.jsonData) {
      throw new Error(`No json data for instance ${source.uid}`);
    }
    log.warn(
      "Storing instance access",
      source.uid,
      "to destination with jsonData"
    );

    this.jsonData = structuredClone(source.jsonData);

    this.storeBulkdata(source);

    this.storeFrames(source);
  }

  /**
   * Stores bulkdata to the local bulkdata directory from the given source
   */
  public async storeBulkdata(
    source: InstanceAccess,
    sourceData = source.jsonData,
    thisData = this.jsonData
  ) {
    if (!sourceData || typeof sourceData !== "object") {
      return;
    }
    for (const [key, child] of Object.entries(sourceData)) {
      if (!child) continue;
      const destChild = thisData[key];
      if (key === "7FE00010" || key === "7fe00010") {
        destChild.BulkDataURI = `instances/${this.uid}/frames`;
        continue;
      }
      if (child.BulkDataURI) {
        destChild.BulkDataURI = await this.storeBulkdataItem(
          key,
          source,
          child
        );
      } else if (Array.isArray(child.Value)) {
        for (let i = 0; i < child.Value.length; i++) {
          const childI = child.Value[i];
          const destI = destChild.Value[i];
          await this.storeBulkdata(source, childI, destI);
        }
      }
    }
  }

  public async storeBulkdataItem(key, source, child) {
    console.warn("Storing child bulkdata", key, child);
    const { hashcode, extension, contentType } = await getBulkdataInfo(
      key,
      child
    );
    const bulkdata = await source.openBulkdata(key, child);

    const bulkdataSeriesName = `../../bulkdata/${hashcode.substring(0, 3)}/${hashcode.substring(3, 6)}/${hashcode}.${extension}`;
    const bulkdataInstanceName = `../../${bulkdataSeriesName}`;
    const destBulkdata = writeStream(this.url, bulkdataInstanceName, {
      mkdir: true,
    });
    await destBulkdata.write(bulkdata);
    destBulkdata.close();

    // Use the series name as all the paths are series relative
    return bulkdataSeriesName;
  }

  public async storeFrames(source: InstanceAccess) {
    const naturalSource = source.getNatural();
    if (!naturalSource?.PhotometricInterpretation) {
      log.warn("DICOM has no images", this.uid, naturalSource);
      return;
    }
    const numFrames = naturalSource.NumberOfFrames || 1;

    for (let frame = 1; frame <= numFrames; frame++) {
      this.storeFrame(source, frame);
      this.storeRenderedFrame(source, frame);
      this.storeThumbnailFrame(source, frame);
    }
    this.storeThumbnail(source);
    this.storeRendered(source);
  }

  public async openFrame(frame = 1) {
    const path = `${this.url}/frames/${frame}.mht.gz`;
    return fs.readFile(path);
  }

  public async storeFrame(source, frame) {
    log.warn("Storing frame", frame);
    const sourceFrame = await source.openFrame(frame);
    const destFrame = writeStream(`${this.url}/frames`, `${frame}.mht.gz`, {
      mkdir: true,
    });
    if (sourceFrame.pipe) {
      await sourceFrame.pipe(destFrame);
    } else {
      log.warn("Storing frame data", sourceFrame.length);
      await destFrame.write(sourceFrame);
    }
    destFrame.close();
  }

  public async storeRenderedFrame(source, frame) {
    log.debug("Storing rendered frame", frame);
  }
  public async storeThumbnailFrame(source, frame) {
    log.debug("Storing thumbnail frame", frame);
  }
  public async storeThumbnail(source) {
    log.warn("Storing thumbnail for instance overall");
  }

  public async storeRendered(source) {
    log.warn("Storing rendered overall for instance", this.uid);
  }
}
