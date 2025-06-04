import { writeStream, logger } from "../utils";
import { InstanceAccess } from "../access/DicomAccess";
import fsBase from "fs";
import { pipeline } from "node:stream/promises";

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

    await this.storeBulkdata(source);

    await this.storeFrames(source);
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
      await this.storeFrame(source, frame);
    }
    await this.storeRendered(source);
  }

  /** Opens the frame.  Options allow choosing to get compressed/encapsulated data back */
  public async openFrame(frame = 1, _options?) {
    const path = `${this.url}/frames/${frame}.mht`;
    if (fsBase.existsSync(path)) {
      console.warn("Getting uncompressed but encapsulated");
      return {
        stream: await fsBase.createReadStream(path),
        compressed: false,
        encapsulated: true,
      };
    }
    const gzPath = `${path}.gz`;
    if (fsBase.existsSync(gzPath)) {
      console.warn("Get compressed and encapsulated data");
      return {
        stream: await fsBase.createReadStream(gzPath),
        compressed: true,
        encapsulated: true,
      };
    }
    console.warn("No frame file found for", this.url, frame);
  }

  public async storeFrame(source, frame) {
    log.warn("**************************** Storing frame", frame);
    const { stream, buffer, compressed, encapsulated } = await source.openFrame(
      frame,
      {
        compressed: true,
        encapsulated: true,
      }
    );
    log.info("Read from", frame, stream.length);
    const destFile = writeStream(
      `${this.url}/frames`,
      `${frame}${encapsulated ? ".mht" : ""}${compressed ? ".gz" : ""}`,
      {
        mkdir: true,
        compressed,
      }
    );
    if (stream.pipe) {
      log.trace("Found pipe");
      await stream.pipe(destFile);
    } else if (buffer) {
      log.trace("Writing buffer direct");
      await destFile.write(buffer);
    }
    await destFile.closePromise;
  }

  public async storeRendered(source, frame) {
    log.debug("TODO - Storing rendered frame", frame);
  }
}
