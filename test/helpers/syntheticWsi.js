// test/helpers/syntheticWsi.js
//
// Writes a small JPEG Baseline whole-slide pyramid for the transcode and
// wsiresize tests: a base level whose frames are stored out of raster order
// (TILED_SPARSE with per-frame positions), a half-size level, and a LABEL.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const dicomCodec = require("@cornerstonejs/dicom-codec");

const VL_WHOLE_SLIDE = "1.2.840.10008.5.1.4.1.1.77.1.6";
const JPEG_BASELINE = "1.2.840.10008.1.2.4.50";

/** A smooth RGB pattern that JPEG keeps close. */
function pixel(x, y) {
  return [(x * 255) / 600, (y * 255) / 400, ((x + y) * 255) / 1000].map(
    (v) => Math.round(v) & 0xff
  );
}

async function encodeTile(x0, y0, tile, scale) {
  const data = new Uint8Array(tile * tile * 3);
  for (let y = 0; y < tile; y++) {
    for (let x = 0; x < tile; x++) {
      data.set(pixel((x0 + x) * scale, (y0 + y) * scale), (y * tile + x) * 3);
    }
  }
  const { imageFrame } = await dicomCodec.encode(
    data,
    {
      rows: tile,
      columns: tile,
      bitsAllocated: 8,
      samplesPerPixel: 3,
      signed: false,
    },
    JPEG_BASELINE,
    { beforeEncode: (encoder) => encoder.setQuality(95) }
  );
  return imageFrame.slice().buffer;
}

async function writeLevel(
  dcmjs,
  file,
  { width, height, tile, scale, imageType, series, order }
) {
  const { DicomMetaDictionary, DicomDict } = dcmjs.data;
  const tilesX = Math.ceil(width / tile);
  const tilesY = Math.ceil(height / tile);
  const positions = [];
  for (let ty = 0; ty < tilesY; ty++) {
    for (let tx = 0; tx < tilesX; tx++) {
      positions.push({ x: tx * tile, y: ty * tile });
    }
  }
  const frames = order ? order.map((i) => positions[i]) : positions;
  const sop = DicomMetaDictionary.uid();

  const dataset = {
    SOPClassUID: VL_WHOLE_SLIDE,
    SOPInstanceUID: sop,
    StudyInstanceUID: series.study,
    SeriesInstanceUID: series.uid,
    FrameOfReferenceUID: series.frameOfReference,
    Modality: "SM",
    PatientName: "TEST^WSI",
    PatientID: "WSI001",
    ImageType: ["DERIVED", "PRIMARY", imageType, "NONE"],
    InstanceNumber: 1,
    Rows: tile,
    Columns: tile,
    NumberOfFrames: frames.length,
    SamplesPerPixel: 3,
    PhotometricInterpretation: "YBR_FULL_422",
    PlanarConfiguration: 0,
    BitsAllocated: 8,
    BitsStored: 8,
    HighBit: 7,
    PixelRepresentation: 0,
    LossyImageCompression: "01",
    LossyImageCompressionRatio: 10,
    LossyImageCompressionMethod: "ISO_10918_1",
    TotalPixelMatrixColumns: width,
    TotalPixelMatrixRows: height,
    TotalPixelMatrixFocalPlanes: 1,
    NumberOfOpticalPaths: 1,
    DimensionOrganizationType: order ? "TILED_SPARSE" : "TILED_FULL",
    SharedFunctionalGroupsSequence: [
      {
        PixelMeasuresSequence: [
          { PixelSpacing: [0.0005 * scale, 0.0005 * scale] },
        ],
      },
    ],
    PerFrameFunctionalGroupsSequence: order
      ? frames.map(({ x, y }) => ({
          PlanePositionSlideSequence: [
            {
              ColumnPositionInTotalImagePixelMatrix: x + 1,
              RowPositionInTotalImagePixelMatrix: y + 1,
            },
          ],
        }))
      : undefined,
  };
  if (!order) {
    delete dataset.PerFrameFunctionalGroupsSequence;
  }

  const dict = DicomMetaDictionary.denaturalizeDataset(dataset);
  dict["7FE00010"] = {
    vr: "OB",
    Value: await Promise.all(
      frames.map(({ x, y }) => encodeTile(x, y, tile, scale))
    ),
  };
  const meta = DicomMetaDictionary.denaturalizeDataset({
    FileMetaInformationVersion: new Uint8Array([0, 1]).buffer,
    MediaStorageSOPClassUID: VL_WHOLE_SLIDE,
    MediaStorageSOPInstanceUID: sop,
    TransferSyntaxUID: JPEG_BASELINE,
    ImplementationClassUID: "2.25.80302813137786398554742050926734630921",
  });
  const part10 = new DicomDict(meta);
  part10.dict = dict;
  fs.writeFileSync(
    file,
    Buffer.from(part10.write({ fragmentMultiframe: false }))
  );
  return { path: file, sop, frames: frames.length };
}

/**
 * Writes the pyramid into `dir`. The base is 600 x 400 in 256 px tiles,
 * stored in the order 4, 1, 5, 0, 2, 3.
 */
export async function writeSyntheticWsi(dcmjs, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const { uid } = dcmjs.data.DicomMetaDictionary;
  const series = { study: uid(), uid: uid(), frameOfReference: uid() };
  const base = await writeLevel(dcmjs, path.join(dir, "base.dcm"), {
    width: 600,
    height: 400,
    tile: 256,
    scale: 1,
    imageType: "VOLUME",
    series,
    order: [4, 1, 5, 0, 2, 3],
  });
  const half = await writeLevel(dcmjs, path.join(dir, "half.dcm"), {
    width: 300,
    height: 200,
    tile: 256,
    scale: 2,
    imageType: "VOLUME",
    series,
  });
  const label = await writeLevel(dcmjs, path.join(dir, "label.dcm"), {
    width: 128,
    height: 128,
    tile: 128,
    scale: 1,
    imageType: "LABEL",
    series,
  });
  return { series, base, half, label };
}
