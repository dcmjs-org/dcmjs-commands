import { InstanceAccess } from "../access/DicomAccess.js";
import { OCTET_STREAM_ACCEPT } from "./DicomWebFetch.js";

/** Reads the first part of a parts iterable into a Uint8Array. */
async function firstPart(parts) {
  for await (const { headers, body } of parts) {
    const type = headers.get("content-type") || "application/octet-stream";
    const contentType = type.split(";")[0].trim();
    return {
      buffer: new Uint8Array(await new Response(body).arrayBuffer()),
      contentType,
      // PS3.18: octet-stream without transfer-syntax is Explicit VR LE
      transferSyntaxUID:
        /transfer-syntax="?([^;\s"]+)/i.exec(type)?.[1] ??
        (contentType === "application/octet-stream"
          ? "1.2.840.10008.1.2.1"
          : undefined),
    };
  }
  throw new Error("Empty multipart response");
}

export class DicomWebInstance extends InstanceAccess {
  /**
   * Opens the frame as uncompressed data (the Part 10 writer builds its
   * transfer syntax from the response).
   */
  async openFrame(frame = 1, _options) {
    const { client } = this.dicomAccess;
    const part = await firstPart(
      await client.retrieveFrames(
        this.parent.parent.uid,
        this.parent.uid,
        this.uid,
        frame,
        { accept: OCTET_STREAM_ACCEPT }
      )
    );
    return { ...part, compressed: false };
  }

  async openBulkdata(key, child, _options) {
    let bulkDataURI = child.BulkDataURI;
    // Static DICOMweb references are study relative.
    if (bulkDataURI.startsWith("bulkdata/")) {
      bulkDataURI = `${this.parent.parent.url}/${bulkDataURI}`;
    }
    const { buffer } = await firstPart(
      await this.dicomAccess.client.retrieveBulkData(bulkDataURI)
    );
    return { buffer, encapsulated: false, compressed: false };
  }
}
