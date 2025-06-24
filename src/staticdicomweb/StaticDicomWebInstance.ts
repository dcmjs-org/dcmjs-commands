import { writeStream, logger } from "../utils";
import { InstanceAccess } from "../access/DicomAccess";
import fsBase from "fs";
import { finished } from "stream/promises";
import { getBulkdataInfo } from "../utils/getBulkdataInfo";
import dcmjs from "dcmjs";

const { DicomDict, WriteBufferStream, DicomMessage } = dcmjs.data;
const log = logger.commandsLog.getLogger("StaticDicomWeb", "Series");

export class StaticDicomWebInstance extends InstanceAccess {
  public async storeCurrentLevel(source: InstanceAccess, options): void {
    if (!source.jsonData) {
      throw new Error(`No json data for instance ${source.uid}`);
    }
    log.warn("Storing instance access", source.uid);

    this.jsonData = structuredClone(source.jsonData);

    if (options?.bulkdata !== false) {
      await this.storeBulkdata(source);
    }

    if (options?.frames !== false) {
      await this.storeFrames(source);
    }

    if (options?.part10) {
      await this.storePart10(source, options);
    }
  }

  public async storePart10(source, options) {
    const json = structuredClone(source.jsonData);
    console.warn("******** Storing part 10", this.uid);
    const fmi = await source.importBulkdata(json, options);
    console.warn("Generate fmi=", fmi);
    // console.warn("Converting to binary", json);
    const dicomDict = new DicomDict(fmi);
    dicomDict.dict = json;
    // const stream = new WriteBufferStream(1024);
    // const bytesWritten = DicomMessage.write(
    //   json,
    //   stream,
    //   "1.2.840.10008.1.2.4.50" // JPEG baseline (an encapsulated format)
    // );

    // console.warn("Got buffer", bytesWritten, stream.buffer.length);
    // const part10Buffer = stream.buffer.slice(0, bytesWritten);
    const part10Buffer = dicomDict.write(dicomDict);
    const dicomOut = await writeStream(this.url, "part10.dcm", { mkdir: true });
    await dicomOut.writeWithPromise(part10Buffer);
    await dicomOut.close();
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
    const bulkdata = await source.openBulkdata(key, child);
    if (!bulkdata) {
      throw new Error(`Unable to read bulkdata ${key} from source ${source}`);
    }
    const { hashCode, extension } = await getBulkdataInfo(key, child, bulkdata);

    const bulkdataSeriesDir = `../../bulkdata/${hashCode.substring(0, 3)}/${hashCode.substring(3, 6)}`;
    const bulkdataInstanceDir = `../../${bulkdataSeriesDir}`;
    const filename = `${hashCode}.${extension}`;
    const bulkdataSeriesName = `${bulkdataSeriesDir}/${filename}`;

    const rootBulkdata = `${this.url}/${bulkdataInstanceDir}`;
    if (await fsBase.promises.exists(`${rootBulkdata}/filename`)) {
      return bulkdataSeriesName;
    }
    const destBulkdata = await writeStream(rootBulkdata, filename, {
      mkdir: true,
    });
    log.info("Storing bulkdata item", bulkdataSeriesName, bulkdata.length);
    await destBulkdata.writeWithPromise(new Uint8Array(bulkdata));
    await destBulkdata.close();

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
      log.debug("Getting uncompressed but encapsulated");
      return {
        stream: await fsBase.createReadStream(path),
        compressed: false,
        encapsulated: true,
      };
    }
    const gzPath = `${path}.gz`;
    if (fsBase.existsSync(gzPath)) {
      log.debug("Get compressed and encapsulated data");
      return {
        stream: await fsBase.createReadStream(gzPath),
        compressed: true,
        encapsulated: true,
      };
    }
    throw new Error(`No frame file found for ${this.url} for frame ${frame}`);
  }

  public async storeFrame(source, frame) {
    log.debug("Storing frame", frame);
    const frameData = await source.openFrame(frame, {
      compressed: true,
      encapsulated: true,
    });
    const {
      stream,
      buffer,
      compressed,
      encapsulated,
      contentType = "application/octet-stream",
      transferSyntaxUID,
    } = frameData;
    if (!frameData || !(frameData.buffer || frameData.stream)) {
      console.warn("Unable to read frame", !!buffer, !!stream);
      return null;
    }
    const frameOut = await writeStream(
      `${this.url}/frames`,
      `${frame}.mht${compressed ? ".gz" : ""}`,
      {
        mkdir: true,
        compressed,
      }
    );
    if (stream?.pipe) {
      log.trace("Found pipe");
      stream.pipe(frameOut);
      await finished(frameOut);
    } else if (buffer) {
      const boundary = crypto.randomUUID();
      if (!encapsulated) {
        log.debug(
          "Writing multipart/related encapsulation",
          contentType,
          transferSyntaxUID
        );
        if (!transferSyntaxUID) {
          throw new Error(
            `Must supply a transferSyntaxUID for unencapsulated writes, but got only ${contentType}`
          );
        }
        await frameOut.writeWithPromise(
          `--${boundary}\r\nContent-Type: ${contentType};transfer-syntax=${transferSyntaxUID}\r\n\r\n`
        );
      }
      await frameOut.writeWithPromise(new Uint8Array(buffer));
      if (!encapsulated) {
        await frameOut.writeWithPromise(`\r\n--${boundary}--`);
      }
      await frameOut.close();
    }
    await frameOut.closePromise;
  }

  public async storeRendered(source, frame) {
    log.debug("TODO - Storing rendered frame", frame);
  }
}
