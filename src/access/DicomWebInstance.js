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
      transferSyntaxUID: /transfer-syntax="?([^;\s"]+)/i.exec(type)?.[1],
    };
  }
  throw new Error("Empty multipart response");
}

export class DicomWebInstance extends InstanceAccess {
  /**
   * Opens one frame as the server sends it, with its transfer syntax: the
   * transfer-syntax parameter of the part, else AvailableTransferSyntaxUID
   * when the frame is not the uncompressed size, else Explicit VR Little
   * Endian (PS3.18 octet-stream). A compressed frame stays compressed; the
   * Part 10 writer encapsulates it.
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
    if (!part.transferSyntaxUID) {
      const natural = this.jsonData || this.natural ? this.getNatural() : {};
      const uncompressedLength = Math.ceil(
        ((natural.Rows || 0) *
          (natural.Columns || 0) *
          (natural.SamplesPerPixel || 1) *
          (natural.BitsAllocated || 8)) /
          8
      );
      part.transferSyntaxUID =
        (part.buffer.length !== uncompressedLength &&
          [natural.AvailableTransferSyntaxUID].flat()[0]) ||
        "1.2.840.10008.1.2.1";
    }
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
