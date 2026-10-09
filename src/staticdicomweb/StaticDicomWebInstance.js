import { writeStream, logger, frameToBuffer } from "../utils/index.js";
import { InstanceAccess } from "../access/DicomAccess.js";
import fsBase from "fs";
import path from "node:path";
import crypto from "node:crypto";
import { finished } from "stream/promises";
import { getBulkdataInfo } from "../utils/getBulkdataInfo.js";
import dcmjs from "../dcmjsBundle.js";

const { DicomDict } = dcmjs.data;
const log = logger.commandsLog.getLogger("StaticDicomWeb", "Instance");

export class StaticDicomWebInstance extends InstanceAccess {
  async storeCurrentLevel(source, options) {
    if (!source.jsonData) {
      throw new Error(`No json data for instance ${source.uid}`);
    }
    log.info("Storing instance access", source.uid);

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

  async storePart10(source, options) {
    const json = structuredClone(source.jsonData);
    log.info("Storing part 10", this.uid);
    const fmi = await source.importBulkdata(json, options);
    const dicomDict = new DicomDict(fmi);
    dicomDict.dict = json;
    const part10Buffer = dicomDict.write({ fragmentMultiframe: false });
    const dicomOut = await writeStream(this.url, "part10.dcm", { mkdir: true });
    await dicomOut.writeWithPromise(part10Buffer);
    await dicomOut.close();
  }

  /**
   * Stores bulkdata to the local bulkdata directory from the given source
   */
  async storeBulkdata(
    source,
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

  async storeBulkdataItem(key, source, child) {
    const {
      buffer: bulkdata,
      encapsulated,
      contentType = "application/octet-stream",
      transferSyntaxUID = "1.2.840.10008.1.2.1",
    } = await source.openBulkdata(key, child, { asBuffer: true });
    if (!bulkdata) {
      throw new Error(`Unable to read bulkdata ${key} from source ${source}`);
    }
    const { hashCode, extension } = await getBulkdataInfo(key, child, bulkdata);

    const bulkdataSeriesDir = `../../bulkdata/${hashCode.substring(0, 3)}/${hashCode.substring(3, 6)}`;
    const bulkdataInstanceDir = `../../${bulkdataSeriesDir}`;
    const filename = `${hashCode}.${extension}`;
    const bulkdataSeriesName = `${bulkdataSeriesDir}/${filename}`;

    const rootBulkdata = `${this.url}/${bulkdataInstanceDir}`;
    if (fsBase.existsSync(`${rootBulkdata}/${filename}`)) {
      return bulkdataSeriesName;
    }
    const destBulkdata = await writeStream(rootBulkdata, filename, {
      mkdir: true,
    });
    log.info("Storing bulkdata item", bulkdataSeriesName, bulkdata.length);
    const boundary = crypto.randomUUID();
    if (!encapsulated) {
      await destBulkdata.writeWithPromise(
        `--${boundary}\r\nContent-Type: ${contentType};transfer-syntax=${transferSyntaxUID}\r\n\r\n`
      );
    }
    await destBulkdata.writeWithPromise(new Uint8Array(bulkdata));
    if (!encapsulated) {
      await destBulkdata.writeWithPromise(`\r\n--${boundary}--`);
    }
    await destBulkdata.close();

    // Use the series name as all the paths are series relative
    return bulkdataSeriesName;
  }

  async storeFrames(source) {
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
  async openFrame(frame = 1, options) {
    if (options?.buffer) {
      return frameToBuffer(await this.openFrame(frame));
    }
    const path = `${this.url}/frames/${frame}.mht`;
    if (fsBase.existsSync(path)) {
      log.debug("Getting uncompressed but encapsulated");
      return {
        stream: fsBase.createReadStream(path),
        compressed: false,
        encapsulated: true,
      };
    }
    const gzPath = `${path}.gz`;
    if (fsBase.existsSync(gzPath)) {
      log.debug("Get compressed and encapsulated data");
      return {
        stream: fsBase.createReadStream(gzPath),
        compressed: true,
        encapsulated: true,
      };
    }
    throw new Error(`No frame file found for ${this.url} for frame ${frame}`);
  }

  async storeFrame(source, frame) {
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
      log.warn("Unable to read frame", !!buffer, !!stream);
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

  async storeRendered(_source, frame) {
    log.debug("TODO - Storing rendered frame", frame);
  }

  /**
   * Read a bulkdata item back out of the tree. BulkDataURI values in
   * metadata.gz are series-relative ("../../bulkdata/<h>/<h>/<hash>.mht");
   * the stored file is the multipart-wrapped payload storeBulkdataItem
   * writes, so the boundary wrapper is stripped here.
   */
  async openBulkdata(key, jsonNode, _options) {
    const uri = jsonNode?.BulkDataURI;
    if (!uri) {
      throw new Error(`no BulkDataURI on tag ${key} in ${this.url}`);
    }
    // this.url = .../series/<uid>/instances/<sop>; URIs are series-relative
    const filePath = path.resolve(this.url, "../..", uri);
    if (!fsBase.existsSync(filePath)) {
      throw new Error(`bulkdata file not found for tag ${key}: ${filePath}`);
    }
    const raw = fsBase.readFileSync(filePath);
    const headerEnd = raw.indexOf("\r\n\r\n");
    const trailer = raw.lastIndexOf("\r\n--");
    if (headerEnd < 0 || trailer <= headerEnd) {
      // not multipart-wrapped (encapsulated write): return as-is
      return {
        buffer: raw.buffer.slice(
          raw.byteOffset,
          raw.byteOffset + raw.byteLength
        ),
        encapsulated: true,
        contentType: "application/octet-stream",
        transferSyntaxUID: "1.2.840.10008.1.2.1",
      };
    }
    const header = raw.toString("latin1", 0, headerEnd);
    const contentType =
      header.match(/Content-Type:\s*([^;\r\n]+)/i)?.[1] ||
      "application/octet-stream";
    const transferSyntaxUID =
      header.match(/transfer-syntax=([^;\s\r\n]+)/i)?.[1] ||
      "1.2.840.10008.1.2.1";
    const body = raw.subarray(headerEnd + 4, trailer);
    return {
      buffer: body.buffer.slice(
        body.byteOffset,
        body.byteOffset + body.byteLength
      ),
      encapsulated: false,
      contentType,
      transferSyntaxUID,
    };
  }
}
