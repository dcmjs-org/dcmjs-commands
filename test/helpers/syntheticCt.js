// test/helpers/syntheticCt.js
//
// Writes a small classic CT (or multi-echo MR) series for the multiframe
// tests: single-frame slices of 16 x 16 signed 16-bit pixels, in a file
// order that is not the slice order.

import fs from "node:fs";
import path from "node:path";

const CT = "1.2.840.10008.5.1.4.1.1.2";
const MR = "1.2.840.10008.5.1.4.1.1.4";
const EXPLICIT_LE = "1.2.840.10008.1.2.1";
const SIZE = 16;

function write(dcmjs, file, dataset, pixelData) {
  const { DicomMetaDictionary, DicomDict } = dcmjs.data;
  const dict = DicomMetaDictionary.denaturalizeDataset(dataset);
  dict["7FE00010"] = pixelData;
  const meta = DicomMetaDictionary.denaturalizeDataset({
    FileMetaInformationVersion: new Uint8Array([0, 1]).buffer,
    MediaStorageSOPClassUID: dataset.SOPClassUID,
    MediaStorageSOPInstanceUID: dataset.SOPInstanceUID,
    TransferSyntaxUID: EXPLICIT_LE,
    ImplementationClassUID: "2.25.80302813137786398554742050926734630921",
  });
  const part10 = new DicomDict(meta);
  part10.dict = dict;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(part10.write()));
}

/** The pixels of slice `z` of `echo`: echo * 1000 + z * 100 + the index. */
export function slicePixels(z, echo = 0) {
  const pixels = new Int16Array(SIZE * SIZE);
  pixels.forEach((_, i) => (pixels[i] = echo * 1000 + z * 100 + i));
  return pixels;
}

/**
 * Writes the series into `dir`. The slices are at z = 0, 2, 4, ...
 * `photometric` labels slice index 1 (to test a refusal).
 *
 * With `echoes` > 1, the series is MR, with each echo at every position.
 * The InstanceNumber interleaves the echoes, and at every second position
 * echo 2 has the lower InstanceNumber, so that only EchoNumbers gives the
 * order of the echoes. Otherwise the series is CT and the InstanceNumber
 * counts down from the first slice.
 *
 * @returns {{ study, series, frameOfReference,
 *   slices: Array<{ path, sop, z, echo }> }} `slices` is in echo order,
 *   then in z order.
 */
export function writeSyntheticCt(
  dcmjs,
  dir,
  { count = 4, photometric, echoes = 1 } = {}
) {
  const { uid } = dcmjs.data.DicomMetaDictionary;
  const study = uid();
  const series = uid();
  const frameOfReference = uid();
  const mr = echoes > 1;
  const slices = [];
  for (let echo = 1; echo <= echoes; echo++) {
    for (let i = 0; i < count; i++) {
      const swap = mr && i % 2 === 1 ? echoes - echo : echo - 1;
      const number = mr ? i * echoes + swap + 1 : count - i;
      slices.push({
        sop: uid(),
        z: i * 2,
        echo: mr ? echo : 0,
        number,
        path: path.join(dir, `slice-${number}.dcm`),
      });
    }
  }
  for (const [i, slice] of slices.entries()) {
    write(
      dcmjs,
      slice.path,
      {
        PatientName: "TEST^CT",
        PatientID: "CT001",
        PatientBirthDate: "19700101",
        PatientSex: "O",
        StudyInstanceUID: study,
        StudyDate: "20260101",
        StudyTime: "080000",
        AccessionNumber: "A1",
        ReferringPhysicianName: "",
        StudyID: "1",
        Manufacturer: "Test",
        SOPClassUID: mr ? MR : CT,
        SOPInstanceUID: slice.sop,
        SeriesInstanceUID: series,
        SeriesDescription: mr ? "Dual echo" : "Chest",
        FrameOfReferenceUID: frameOfReference,
        PositionReferenceIndicator: "",
        Modality: mr ? "MR" : "CT",
        SeriesNumber: 2,
        InstanceNumber: slice.number,
        ImageType: ["ORIGINAL", "PRIMARY", mr ? "OTHER" : "AXIAL"],
        ContentDate: "20260101",
        ContentTime: `0800${String(10 + i).padStart(2, "0")}`,
        AcquisitionNumber: 1,
        BodyPartExamined: "CHEST",
        ...(mr
          ? {
              EchoNumbers: slice.echo,
              EchoTime: slice.echo * 2.4,
              ScanningSequence: "GR",
            }
          : { KVP: 120 }),
        SliceLocation: slice.z,
        ImagePositionPatient: [-4, -4, slice.z],
        ImageOrientationPatient: [1, 0, 0, 0, 1, 0],
        PixelSpacing: [0.5, 0.5],
        SliceThickness: 2,
        Rows: SIZE,
        Columns: SIZE,
        SamplesPerPixel: 1,
        PhotometricInterpretation:
          i === 1 && photometric ? photometric : "MONOCHROME2",
        BitsAllocated: 16,
        BitsStored: 16,
        HighBit: 15,
        PixelRepresentation: 1,
        ...(mr
          ? {}
          : { RescaleIntercept: -1024, RescaleSlope: 1, RescaleType: "HU" }),
        WindowCenter: 40,
        WindowWidth: 400,
      },
      { vr: "OW", Value: [slicePixels(slice.z, slice.echo).buffer] }
    );
  }
  return { study, series, frameOfReference, slices };
}
