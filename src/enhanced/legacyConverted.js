// src/enhanced/legacyConverted.js
//
// Legacy Converted Enhanced CT, MR and PET images (PS3.3 A.70 to A.72) from
// classic single-frame images. Pure functions on tag-keyed dicts: the
// command reads the headers from Part 10 files or from Static-DICOMweb
// metadata, and moves the frames itself.

import dcmjs from "../dcmjsBundle.js";
import { binaryReplacer } from "../io.js";
import { BODY_PART_CODES } from "./bodyPartCodes.js";

const { DicomMetaDictionary } = dcmjs.data;

/** Classic SOP class -> the Legacy Converted Enhanced SOP class. */
export const LEGACY_CLASSES = {
  "1.2.840.10008.5.1.4.1.1.2": {
    name: "CT",
    uid: "1.2.840.10008.5.1.4.1.1.2.2",
    frameType: "CTImageFrameTypeSequence",
    pixelValueTransformation: "HU",
    frameVoiLut: true,
  },
  "1.2.840.10008.5.1.4.1.1.4": {
    name: "MR",
    uid: "1.2.840.10008.5.1.4.1.1.4.4",
    frameType: "MRImageFrameTypeSequence",
  },
  "1.2.840.10008.5.1.4.1.1.128": {
    name: "PET",
    uid: "1.2.840.10008.5.1.4.1.1.128.1",
    frameType: "PETFrameTypeSequence",
    pixelValueTransformation: "US",
    frameVoiLut: true,
  },
};

/** "PatientName" -> "00100010". */
export const tagOf = (keyword) => {
  const entry = DicomMetaDictionary.nameMap[keyword];
  if (!entry) {
    throw new Error(`unknown keyword ${keyword}`);
  }
  return entry.tag.replace(/[(),]/g, "");
};
const vrOf = (keyword) => DicomMetaDictionary.nameMap[keyword].vr;
const el = (keyword, ...Value) => ({ vr: vrOf(keyword), Value });
const sq = (...items) => ({ vr: "SQ", Value: items });
const first = (dict, tag) => dict?.[tag]?.Value?.[0];
const item = (pairs) =>
  Object.fromEntries(
    Object.entries(pairs)
      .filter(([, element]) => element)
      .map(([keyword, element]) => [tagOf(keyword), element])
  );
const code = (value, scheme, meaning) =>
  item({
    CodeValue: el("CodeValue", value),
    CodingSchemeDesignator: el("CodingSchemeDesignator", scheme),
    CodeMeaning: el("CodeMeaning", meaning),
  });

const T = Object.fromEntries(
  [
    "SOPClassUID",
    "SOPInstanceUID",
    "SeriesInstanceUID",
    "FrameOfReferenceUID",
    "SpecificCharacterSet",
    "InstanceNumber",
    "NumberOfFrames",
    "ImageType",
    "ImagePositionPatient",
    "ImageOrientationPatient",
    "PixelSpacing",
    "SliceThickness",
    "SpacingBetweenSlices",
    "WindowCenter",
    "WindowWidth",
    "WindowCenterWidthExplanation",
    "VOILUTFunction",
    "RescaleIntercept",
    "RescaleSlope",
    "RescaleType",
    "Units",
    "ReferencedImageSequence",
    "AnatomicRegionSequence",
    "BodyPartExamined",
    "Laterality",
    "ImageLaterality",
    "IrradiationEventUID",
    "AcquisitionNumber",
    "AcquisitionDateTime",
    "AcquisitionDate",
    "AcquisitionTime",
    "ContentDate",
    "ContentTime",
    "InstanceCreationDate",
    "InstanceCreationTime",
    "PhotometricInterpretation",
    "SamplesPerPixel",
    "Rows",
    "Columns",
    "BitsAllocated",
    "BitsStored",
    "HighBit",
    "PixelRepresentation",
    "AcquisitionContextSequence",
    "ContributingEquipmentSequence",
    "ReferencedSOPClassUID",
    "ReferencedSOPInstanceUID",
    "EchoNumbers",
    "TemporalPositionIdentifier",
    "DiffusionBValue",
  ].map((keyword) => [keyword, tagOf(keyword)])
);

/**
 * Attributes that move into a functional group macro (PS3.3 C.7.6.16.2),
 * or that the conversion sets again. They are not copied as they are.
 */
const MOVED = new Set(
  [
    "SOPClassUID",
    "SOPInstanceUID",
    "NumberOfFrames",
    "ImagePositionPatient",
    "ImageOrientationPatient",
    "PixelSpacing",
    "SliceThickness",
    "SpacingBetweenSlices",
    "WindowCenter",
    "WindowWidth",
    "WindowCenterWidthExplanation",
    "VOILUTFunction",
    "RescaleIntercept",
    "RescaleSlope",
    "RescaleType",
    "ReferencedImageSequence",
    "AnatomicRegionSequence",
    "IrradiationEventUID",
  ].map(tagOf)
);

/**
 * Attributes that the conversion drops and reports: the VOI LUT and Overlay
 * Plane Modules are not allowed (A.70.3), an icon of one frame does not
 * describe the new image, and a signature no longer matches.
 */
const DISCARDED = new Set(
  [
    "VOILUTSequence",
    "IconImageSequence",
    "DigitalSignaturesSequence",
    "MACParametersSequence",
  ].map(tagOf)
);

/**
 * Attributes whose value the conversion changes: the new value goes to the
 * top level, and the source values go to the Unassigned groups.
 */
const CHANGED = new Set(
  [
    "InstanceNumber",
    "ImageType",
    "ContentDate",
    "ContentTime",
    "InstanceCreationDate",
    "InstanceCreationTime",
    "ContributingEquipmentSequence",
  ].map(tagOf)
);

/**
 * Attributes of the Modules of the Legacy Converted IODs (Tables A.70-1,
 * A.71-1, A.72-1): a value that is the same in every frame stays at the top
 * level. A shared value of any other attribute goes to the Unassigned
 * Shared Converted Attributes Sequence, because the General Image, Image
 * Plane and modality Image Modules are not in these IODs.
 */
const TOP_LEVEL = new Set(
  [
    // Patient, Clinical Trial Subject
    "PatientName",
    "PatientID",
    "IssuerOfPatientID",
    "IssuerOfPatientIDQualifiersSequence",
    "TypeOfPatientID",
    "PatientBirthDate",
    "PatientBirthTime",
    "PatientSex",
    "QualityControlSubject",
    "ReferencedPatientSequence",
    "OtherPatientIDsSequence",
    "OtherPatientNames",
    "EthnicGroup",
    "PatientComments",
    "PatientSpeciesDescription",
    "PatientSpeciesCodeSequence",
    "PatientBreedDescription",
    "PatientBreedCodeSequence",
    "BreedRegistrationSequence",
    "ResponsiblePerson",
    "ResponsiblePersonRole",
    "ResponsibleOrganization",
    "PatientIdentityRemoved",
    "DeidentificationMethod",
    "DeidentificationMethodCodeSequence",
    "ClinicalTrialSponsorName",
    "ClinicalTrialProtocolID",
    "ClinicalTrialProtocolName",
    "ClinicalTrialSiteID",
    "ClinicalTrialSiteName",
    "ClinicalTrialSubjectID",
    "ClinicalTrialSubjectReadingID",
    // General Study, Patient Study, Clinical Trial Study
    "StudyInstanceUID",
    "StudyDate",
    "StudyTime",
    "ReferringPhysicianName",
    "ReferringPhysicianIdentificationSequence",
    "StudyID",
    "AccessionNumber",
    "IssuerOfAccessionNumberSequence",
    "StudyDescription",
    "PhysiciansOfRecord",
    "NameOfPhysiciansReadingStudy",
    "ReferencedStudySequence",
    "ProcedureCodeSequence",
    "AdmittingDiagnosesDescription",
    "AdmittingDiagnosesCodeSequence",
    "PatientAge",
    "PatientSize",
    "PatientWeight",
    "Occupation",
    "AdditionalPatientHistory",
    "AdmissionID",
    "PregnancyStatus",
    "MedicalAlerts",
    "Allergies",
    "SmokingStatus",
    "ClinicalTrialTimePointID",
    "ClinicalTrialTimePointDescription",
    // General Series, CT/MR/Enhanced PET Series, Clinical Trial Series
    "Modality",
    "SeriesInstanceUID",
    "SeriesNumber",
    "Laterality",
    "SeriesDate",
    "SeriesTime",
    "PerformingPhysicianName",
    "ProtocolName",
    "SeriesDescription",
    "SeriesDescriptionCodeSequence",
    "OperatorsName",
    "ReferencedPerformedProcedureStepSequence",
    "RelatedSeriesSequence",
    "BodyPartExamined",
    "PatientPosition",
    "SmallestPixelValueInSeries",
    "LargestPixelValueInSeries",
    "RequestAttributesSequence",
    "PerformedProcedureStepID",
    "PerformedProcedureStepStartDate",
    "PerformedProcedureStepStartTime",
    "PerformedProcedureStepDescription",
    "PerformedProtocolCodeSequence",
    "CommentsOnThePerformedProcedureStep",
    "AnatomicalOrientationType",
    "ClinicalTrialCoordinatingCenterName",
    "ClinicalTrialSeriesID",
    "ClinicalTrialSeriesDescription",
    // Frame of Reference, Synchronization
    "FrameOfReferenceUID",
    "PositionReferenceIndicator",
    "SynchronizationFrameOfReferenceUID",
    "SynchronizationTrigger",
    "AcquisitionTimeSynchronized",
    "TimeSource",
    // General and Enhanced General Equipment
    "Manufacturer",
    "InstitutionName",
    "InstitutionAddress",
    "StationName",
    "InstitutionalDepartmentName",
    "ManufacturerModelName",
    "DeviceSerialNumber",
    "SoftwareVersions",
    "GantryID",
    "SpatialResolution",
    "DateOfLastCalibration",
    "TimeOfLastCalibration",
    "PixelPaddingValue",
    // Image Pixel
    "SamplesPerPixel",
    "PhotometricInterpretation",
    "Rows",
    "Columns",
    "BitsAllocated",
    "BitsStored",
    "HighBit",
    "PixelRepresentation",
    "SmallestImagePixelValue",
    "LargestImagePixelValue",
    // Contrast/Bolus, Acquisition Context, Device
    "ContrastBolusAgent",
    "ContrastBolusAgentSequence",
    "ContrastBolusRoute",
    "ContrastBolusVolume",
    "ContrastBolusStartTime",
    "ContrastBolusStopTime",
    "ContrastBolusTotalDose",
    "ContrastFlowRate",
    "ContrastFlowDuration",
    "ContrastBolusIngredient",
    "ContrastBolusIngredientConcentration",
    "AcquisitionContextSequence",
    "AcquisitionContextDescription",
    "DeviceSequence",
    // Enhanced CT/MR/PET Image
    "AcquisitionNumber",
    "AcquisitionDateTime",
    "AcquisitionDuration",
    "BurnedInAnnotation",
    "RecognizableVisualFeatures",
    "LossyImageCompression",
    "LossyImageCompressionRatio",
    "LossyImageCompressionMethod",
    "PresentationLUTShape",
    // SOP Common
    "SpecificCharacterSet",
    "InstanceCreatorUID",
    "TimezoneOffsetFromUTC",
  ].map(tagOf)
);

const BIG_ENDIAN = "1.2.840.10008.1.2.2";

/** Values compare as the standard says: absent equals present and empty. */
function canon(element) {
  if (!element) {
    return "[]";
  }
  const value =
    element.Value ??
    (element.BulkDataURI && { uri: element.BulkDataURI }) ??
    (element.InlineBinary && { inline: element.InlineBinary }) ??
    [];
  return JSON.stringify(value, binaryReplacer("base64"));
}

const sameIn = (dicts, tag) =>
  new Set(dicts.map((dict) => canon(dict[tag]))).size === 1;

const isPrivate = (tag) => parseInt(tag.slice(0, 4), 16) % 2 === 1;
const isPrivateCreator = (tag) =>
  isPrivate(tag) && parseInt(tag.slice(4, 6), 16) === 0;
/** Overlay and curve groups (60xx, 50xx). */
const isOverlayOrCurve = (tag) => /^(60|50)[0-9A-F]{2}/.test(tag);
/** File meta, group lengths, pixel data and padding: never copied. */
const isStructural = (tag) =>
  tag.startsWith("0002") || tag.endsWith("0000") || tag >= "7FE00000";

const numbers = (dict, tag) => dict[tag]?.Value?.map(Number);
/** The values of a string element; a value joined with "\" is split. */
const strings = (dict, tag) =>
  (dict[tag]?.Value ?? []).flatMap((v) => String(v ?? "").split("\\"));

/** Why this classic image cannot be converted, or undefined. */
function refusal(dict, transferSyntaxUID) {
  if (Number(first(dict, T.NumberOfFrames) ?? 1) > 1) {
    return "the image already has more than one frame";
  }
  if (first(dict, T.PhotometricInterpretation) !== "MONOCHROME2") {
    return (
      `PhotometricInterpretation ${first(dict, T.PhotometricInterpretation)} ` +
      "is not MONOCHROME2, which the Legacy Converted IODs require"
    );
  }
  if (numbers(dict, T.ImagePositionPatient)?.length !== 3) {
    return "the image has no ImagePositionPatient";
  }
  if (numbers(dict, T.ImageOrientationPatient)?.length !== 6) {
    return "the image has no ImageOrientationPatient";
  }
  if (transferSyntaxUID === BIG_ENDIAN) {
    return "Explicit VR Big Endian is not supported; transcode it first";
  }
  return undefined;
}

/** The slice normal of an ImageOrientationPatient value. */
function normalOf([rx, ry, rz, cx, cy, cz]) {
  return [ry * cz - rz * cy, rz * cx - rx * cz, rx * cy - ry * cx];
}

const PIXEL_KEY = [
  "SpecificCharacterSet",
  "FrameOfReferenceUID",
  "Rows",
  "Columns",
  "BitsAllocated",
  "BitsStored",
  "HighBit",
  "PixelRepresentation",
  "SamplesPerPixel",
].map(tagOf);

/** The values of the `layout` option of `groupInstances`. */
export const LAYOUTS = ["split", "grouped", "interleaved"];

/**
 * Groups classic CT, MR and PET images into the stacks that become one
 * Legacy Converted Enhanced instance each. A group has one series, SOP
 * class, frame of reference, transfer syntax, pixel layout and orientation
 * (to 1e-4). A group with more than one volume (echoes, or Dixon types, see
 * `volumesOf`) becomes:
 * - `split`: one stack for each volume;
 * - `grouped`: one stack, volume after volume, StackID = volume number;
 * - `interleaved`: one stack, by position, with the volumes in their order
 *   at each position, StackID = volume number.
 * A stack of one image is skipped.
 *
 * @param {Array<{id: string, dict: object, transferSyntaxUID: string}>}
 *   instances
 * @param {{ layout?: "split"|"grouped"|"interleaved" }} [options]
 * @returns {{ stacks: Array<{ seriesUID, sourceClass, target,
 *   transferSyntaxUID, layout, volumes, instances, frames, isStack }>,
 *   refused: Array<{ id, reason }>, skipped: Array<{ id, reason }> }}
 *   `instances` of each stack are in frame order, and `frames` gives the
 *   StackID and InStackPositionNumber of each. `isStack` is true when every
 *   frame of a volume has its own position along the slice normal.
 */
export function groupInstances(instances, { layout = "split" } = {}) {
  const groups = new Map();
  const refused = [];
  for (const instance of instances) {
    const { dict, transferSyntaxUID } = instance;
    const sourceClass = first(dict, T.SOPClassUID);
    if (!LEGACY_CLASSES[sourceClass]) {
      continue;
    }
    const reason = refusal(dict, transferSyntaxUID);
    if (reason) {
      refused.push({ id: instance.id, reason });
      continue;
    }
    const orientation = numbers(dict, T.ImageOrientationPatient);
    const key = JSON.stringify([
      first(dict, T.SeriesInstanceUID),
      sourceClass,
      transferSyntaxUID,
      ...PIXEL_KEY.map((tag) => canon(dict[tag])),
      orientation.map((v) => Math.round(v * 1e4)),
    ]);
    if (!groups.has(key)) {
      groups.set(key, {
        seriesUID: first(dict, T.SeriesInstanceUID),
        sourceClass,
        target: LEGACY_CLASSES[sourceClass],
        transferSyntaxUID,
        normal: normalOf(orientation),
        instances: [],
      });
    }
    groups.get(key).instances.push(instance);
  }

  const stacks = [];
  const skipped = [];
  for (const group of groups.values()) {
    const volumes = volumesOf(group);
    const parts =
      layout === "split" ? volumes.map((volume) => [volume]) : [volumes];
    for (const part of parts) {
      const frames =
        layout === "interleaved" ? interleave(part) : part.flatMap(framesOf);
      if (frames.length < 2) {
        skipped.push(
          ...frames.map((f) => ({
            id: f.instance.id,
            reason: "a stack of one image is not converted",
          }))
        );
        continue;
      }
      stacks.push({
        seriesUID: group.seriesUID,
        sourceClass: group.sourceClass,
        target: group.target,
        transferSyntaxUID: group.transferSyntaxUID,
        layout: part.length > 1 ? layout : "split",
        volumes: part.map((v) => v.label),
        instances: frames.map((f) => f.instance),
        frames: frames.map((f) => ({
          stackId: part.length > 1 ? f.stackId : "1",
          at: f.index + 1,
        })),
        isStack: part.every((v) => v.isStack),
      });
    }
  }
  return { stacks, refused, skipped };
}

/** A number of an attribute, or null when it is absent or not a number. */
function numberOrNull(dict, tag) {
  const value = Number(first(dict, tag) ?? NaN);
  return Number.isFinite(value) ? value : null;
}

/**
 * The first value of the private element `offset` (2 hex digits) of the
 * block of `creator` in `group`, or undefined.
 */
function privateValue(dict, group, creator, offset) {
  for (let block = 0x10; block <= 0xff; block++) {
    const hex = block.toString(16).toUpperCase().padStart(2, "0");
    const name = first(dict, `${group}00${hex}`);
    if (String(name ?? "").trim() === creator) {
      return first(dict, `${group}${hex}${offset}`);
    }
  }
  return undefined;
}

/**
 * The diffusion b-value: DiffusionBValue, else the private b-value of
 * Siemens, GE (which can add 1e9 to it) or Philips classic MR images.
 */
function bValueOf(dict) {
  const value = [
    first(dict, T.DiffusionBValue),
    privateValue(dict, "0019", "SIEMENS MR HEADER", "0C"),
    privateValue(dict, "0043", "GEMS_PARM_01", "39"),
    privateValue(dict, "2001", "Philips Imaging DD 001", "03"),
  ].find((v) => v !== undefined && v !== "");
  const number = Number(value ?? NaN);
  return Number.isFinite(number) ? number % 1e9 : null;
}

/** Sorts null before the numbers. */
const byNumber = (a, b) =>
  a === b ? 0 : a === null ? -1 : b === null ? 1 : a - b;

/**
 * The volumes of one group: the images with one temporal position, b-value
 * (`bValueOf`) and EchoNumbers value, and one ImageType from value 4 on
 * (for example FAT or IN_PHASE of a Dixon series). The volumes are ordered
 * by temporal position, b-value, echo and type, so the echoes of a time
 * point or a b-value are in echo order. The images of a volume are in slice
 * order along the normal; images at one position keep the order of
 * AcquisitionNumber, InstanceNumber and SOPInstanceUID.
 *
 * The temporal position is TemporalPositionIdentifier. When no image has
 * one and positions repeat, AcquisitionNumber is the temporal position if
 * it makes every volume a stack of 2 or more images (the phases of a
 * dynamic series). It is not used otherwise, because many CT series give
 * each slice its own AcquisitionNumber.
 */
function volumesOf(group) {
  const volumes = volumesBy(group, T.TemporalPositionIdentifier);
  if (
    volumes.every((volume) => volume.isStack) ||
    volumes.some((volume) => volume.time !== null)
  ) {
    return volumes;
  }
  const phases = volumesBy(group, T.AcquisitionNumber, "acquisition");
  return phases.every((v) => v.isStack && v.sorted.length > 1)
    ? phases
    : volumes;
}

/** The volumes of `volumesOf`, with `timeTag` as the temporal position. */
function volumesBy(group, timeTag, timeName = "time") {
  const position = ({ dict }) => {
    const p = numbers(dict, T.ImagePositionPatient);
    return (
      p[0] * group.normal[0] + p[1] * group.normal[1] + p[2] * group.normal[2]
    );
  };
  const rank = (dict) => [
    Number(first(dict, T.AcquisitionNumber) ?? 0),
    Number(first(dict, T.InstanceNumber) ?? 0),
    String(first(dict, T.SOPInstanceUID)),
  ];
  const byKey = new Map();
  for (const instance of group.instances) {
    const { dict } = instance;
    const time = numberOrNull(dict, timeTag);
    const bValue = bValueOf(dict);
    const echo = Number(first(dict, T.EchoNumbers) ?? 0);
    const type = strings(dict, T.ImageType).slice(3).join("\\");
    const key = JSON.stringify([time, bValue, echo, type]);
    if (!byKey.has(key)) {
      byKey.set(key, { time, bValue, echo, type, instances: [] });
    }
    byKey.get(key).instances.push({ instance, at: position(instance) });
  }
  const volumes = [...byKey.values()].sort(
    (a, b) =>
      byNumber(a.time, b.time) ||
      byNumber(a.bValue, b.bValue) ||
      a.echo - b.echo ||
      a.type.localeCompare(b.type)
  );
  // Only the keys that differ between the volumes name a volume.
  const differs = (field) =>
    new Set(volumes.map((volume) => volume[field])).size > 1;
  const named = {
    time: differs("time"),
    bValue: differs("bValue"),
    echo: differs("echo"),
    type: differs("type"),
  };
  return volumes.map((volume, v) => {
    const sorted = volume.instances.sort((a, b) => {
      if (Math.abs(a.at - b.at) > 1e-4) {
        return a.at - b.at;
      }
      const [ra, rb] = [rank(a.instance.dict), rank(b.instance.dict)];
      return ra[0] - rb[0] || ra[1] - rb[1] || ra[2].localeCompare(rb[2]);
    });
    return {
      label:
        volumes.length > 1
          ? [
              named.time &&
                volume.time !== null &&
                `${timeName} ${volume.time}`,
              named.bValue && volume.bValue !== null && `b ${volume.bValue}`,
              named.echo && volume.echo && `echo ${volume.echo}`,
              named.type && volume.type,
            ]
              .filter(Boolean)
              .join(" ")
          : "",
      stackId: String(v + 1),
      time: volume.time,
      isStack: sorted.every(
        (s, i) => !i || Math.abs(s.at - sorted[i - 1].at) > 1e-4
      ),
      sorted,
    };
  });
}

/** The frames of one volume, in slice order. */
const framesOf = (volume) =>
  volume.sorted.map((s, index) => ({ ...s, index, stackId: volume.stackId }));

/** The frames of all volumes by position, then in the volume order. */
function interleave(volumes) {
  return volumes
    .flatMap(framesOf)
    .map((frame, order) => ({ ...frame, order }))
    .sort((a, b) =>
      Math.abs(a.at - b.at) > 1e-4 ? a.at - b.at : a.order - b.order
    );
}

/**
 * One macro of all frames: `{ shared }` when every frame has the same
 * items, else `{ perFrame }`, or undefined when no frame has the macro.
 */
function macro(perFrame) {
  if (perFrame.every((value) => value === undefined)) {
    return undefined;
  }
  const canonical = new Set(
    perFrame.map((value) => JSON.stringify(value, binaryReplacer("base64")))
  );
  return canonical.size === 1 ? { shared: perFrame[0] } : { perFrame };
}

/** "20240102" + "101530.5" -> "20240102101530.5", or undefined. */
function dateTime(dict) {
  const dt = first(dict, T.AcquisitionDateTime);
  if (dt) {
    return String(dt);
  }
  const date = first(dict, T.AcquisitionDate);
  const time = first(dict, T.AcquisitionTime);
  return date && time ? `${date}${time}` : undefined;
}

/** A window that shows the whole stored range, in rescaled values. */
function fullRangeWindow(dict) {
  const bits = Number(first(dict, T.BitsStored) ?? 16);
  const signed = Number(first(dict, T.PixelRepresentation) ?? 0) === 1;
  const min = signed ? -(2 ** (bits - 1)) : 0;
  const max = signed ? 2 ** (bits - 1) - 1 : 2 ** bits - 1;
  const slope = Number(first(dict, T.RescaleSlope) ?? 1);
  const intercept = Number(first(dict, T.RescaleIntercept) ?? 0);
  return {
    center: intercept + (slope * (min + max)) / 2,
    width: Math.abs(slope) * (max - min + 1),
  };
}

const copy = (element) => element && structuredClone(element);

/** The items of each functional group macro of one frame, by keyword. */
function frameMacros(dict, target) {
  const macros = {};
  macros.PixelMeasuresSequence = item({
    PixelSpacing: copy(dict[T.PixelSpacing]),
    SliceThickness: copy(dict[T.SliceThickness]),
    SpacingBetweenSlices: copy(dict[T.SpacingBetweenSlices]),
  });
  macros.PlanePositionSequence = item({
    ImagePositionPatient: copy(dict[T.ImagePositionPatient]),
  });
  macros.PlaneOrientationSequence = item({
    ImageOrientationPatient: copy(dict[T.ImageOrientationPatient]),
  });

  if (
    dict[T.WindowCenter]?.Value?.length &&
    dict[T.WindowWidth]?.Value?.length
  ) {
    macros.FrameVOILUTSequence = item({
      WindowCenter: copy(dict[T.WindowCenter]),
      WindowWidth: copy(dict[T.WindowWidth]),
      WindowCenterWidthExplanation: copy(dict[T.WindowCenterWidthExplanation]),
      VOILUTFunction: copy(dict[T.VOILUTFunction]),
    });
  } else if (target.frameVoiLut) {
    const { center, width } = fullRangeWindow(dict);
    macros.FrameVOILUTSequence = item({
      WindowCenter: el("WindowCenter", center),
      WindowWidth: el("WindowWidth", width),
    });
  }

  const hasRescale = dict[T.RescaleIntercept] || dict[T.RescaleSlope];
  if (target.pixelValueTransformation || hasRescale) {
    macros.PixelValueTransformationSequence = item({
      RescaleIntercept:
        copy(dict[T.RescaleIntercept]) ?? el("RescaleIntercept", 0),
      RescaleSlope: copy(dict[T.RescaleSlope]) ?? el("RescaleSlope", 1),
      RescaleType:
        copy(dict[T.RescaleType]) ??
        el(
          "RescaleType",
          (target.name === "PET" && first(dict, T.Units)) ||
            target.pixelValueTransformation ||
            "US"
        ),
    });
  }

  const imageType = strings(dict, T.ImageType);
  macros[target.frameType] = item({
    FrameType: el(
      "FrameType",
      imageType[0] ?? "ORIGINAL",
      imageType[1] ?? "PRIMARY",
      imageType[2] ?? "",
      // Value 4 may be empty in a Legacy Converted image (C.8.16.1); a
      // source value (FAT, IN_PHASE, ...) names the volume of the frame.
      imageType[3] ?? ""
    ),
    PixelPresentation: el("PixelPresentation", "MONOCHROME"),
    VolumetricProperties: el("VolumetricProperties", "VOLUME"),
    VolumeBasedCalculationTechnique: el(
      "VolumeBasedCalculationTechnique",
      "NONE"
    ),
    ComplexImageComponent:
      target.name === "MR"
        ? el("ComplexImageComponent", "MAGNITUDE")
        : undefined,
    AcquisitionContrast:
      target.name === "MR" ? el("AcquisitionContrast", "UNKNOWN") : undefined,
  });

  if (dict[T.ReferencedImageSequence]?.Value?.length) {
    const items = structuredClone(dict[T.ReferencedImageSequence].Value);
    for (const reference of items) {
      reference[tagOf("PurposeOfReferenceCodeSequence")] ??= sq(
        code("121311", "DCM", "Localizer")
      );
    }
    // The macro sequence holds the references themselves.
    macros.ReferencedImageSequence = items;
  }

  const region =
    copy(dict[T.AnatomicRegionSequence]) ??
    (BODY_PART_CODES[first(dict, T.BodyPartExamined)] &&
      sq(
        code(...withScheme(BODY_PART_CODES[first(dict, T.BodyPartExamined)]))
      ));
  if (region?.Value?.length) {
    macros.FrameAnatomySequence = item({
      AnatomicRegionSequence: region,
      FrameLaterality: el(
        "FrameLaterality",
        first(dict, T.ImageLaterality) ?? first(dict, T.Laterality) ?? "U"
      ),
    });
  }

  if (target.name !== "MR" && dict[T.IrradiationEventUID]?.Value?.length) {
    macros.IrradiationEventIdentificationSequence = item({
      IrradiationEventUID: copy(dict[T.IrradiationEventUID]),
    });
  }
  return Object.fromEntries(
    Object.entries(macros).map(([keyword, items]) => [
      keyword,
      Array.isArray(items) ? items : [items],
    ])
  );
}

const withScheme = ([value, meaning]) => [value, "SCT", meaning];

/**
 * The evidence sequence of the images that the frames refer to through
 * `sequenceTag`: ReferencedImageSequence gives ReferencedImageEvidenceSequence
 * and SourceImageSequence gives SourceImageEvidenceSequence (both Type 1C
 * in the Enhanced CT, MR and PET Image Modules). A classic reference names
 * no series, so `locate(sop)` gives `{ study, series }`; a reference that it
 * cannot place is added to `unlocated`.
 */
function imageEvidence(dicts, sequenceTag, locate, unlocated) {
  const studies = new Map();
  for (const dict of dicts) {
    for (const reference of dict[sequenceTag]?.Value ?? []) {
      const sop = first(reference, T.ReferencedSOPInstanceUID);
      const where = sop && locate?.(sop);
      if (!where) {
        if (sop) {
          unlocated.add(sop);
        }
        continue;
      }
      if (!studies.has(where.study)) {
        studies.set(where.study, new Map());
      }
      const series = studies.get(where.study);
      if (!series.has(where.series)) {
        series.set(where.series, new Map());
      }
      series
        .get(where.series)
        .set(sop, first(reference, T.ReferencedSOPClassUID));
    }
  }
  const evidence = [...studies].map(([study, series]) =>
    item({
      StudyInstanceUID: el("StudyInstanceUID", study),
      ReferencedSeriesSequence: sq(
        ...[...series].map(([seriesUID, sops]) =>
          item({
            SeriesInstanceUID: el("SeriesInstanceUID", seriesUID),
            ReferencedSOPSequence: sq(
              ...[...sops].map(([sop, sopClass]) =>
                item({
                  ReferencedSOPClassUID: el("ReferencedSOPClassUID", sopClass),
                  ReferencedSOPInstanceUID: el("ReferencedSOPInstanceUID", sop),
                })
              )
            ),
          })
        )
      ),
    })
  );
  return { vr: "SQ", Value: evidence };
}

/** Copies `tag` and, for a private element, its Private Creator. */
function copyWithCreator(target, dict, tag) {
  target[tag] = structuredClone(dict[tag]);
  if (isPrivate(tag) && !isPrivateCreator(tag)) {
    const creator = `${tag.slice(0, 4)}00${tag.slice(4, 6)}`;
    if (dict[creator]) {
      target[creator] = structuredClone(dict[creator]);
    }
  }
}

/** DICOM date and time of `now`, local time. */
function nowDateTime(now) {
  const pad = (v, n = 2) => String(v).padStart(n, "0");
  return {
    date: `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`,
    time: `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`,
  };
}

/**
 * The dataset of one Legacy Converted Enhanced instance (no PixelData).
 *
 * The placement follows PS3.3 C.7.6.16.2.25: an attribute that a functional
 * group macro holds moves into that macro (shared when equal in all frames).
 * Any other attribute that is equal in all frames stays at the top level
 * when a Module of the IOD defines it, and goes to the Unassigned Shared
 * Converted Attributes Sequence otherwise. An attribute that differs goes to
 * the Unassigned Per-Frame Converted Attributes Sequence of each frame that
 * has it. Overlays, curves, icons and signatures are dropped and returned in
 * `dropped`, because the conversion invalidates them.
 *
 * @param {object} args
 * @param {object} args.stack one stack from `groupInstances`
 * @param {string} args.sopInstanceUID
 * @param {number} args.instanceNumber
 * @param {() => string} args.uid makes a new UID
 * @param {(sop: string) => {study, series}|undefined} [args.locate] the
 *   study and series of a referenced image, for the evidence sequence
 * @param {Date} [args.now]
 * @param {boolean} [args.json] AT values as DICOM JSON strings
 * @returns {{ dict: object, dropped: string[], unlocated: string[] }}
 *   `unlocated` lists referenced images that `locate` could not place.
 */
export function buildLegacyConverted({
  stack,
  sopInstanceUID,
  instanceNumber,
  uid,
  locate,
  now = new Date(),
  json = false,
}) {
  const dicts = stack.instances.map((instance) => instance.dict);
  const { target } = stack;
  const dict = {};
  const dropped = new Set();
  const sharedUnassigned = {};
  const perFrameUnassigned = dicts.map(() => ({}));

  const tags = [...new Set(dicts.flatMap((d) => Object.keys(d)))].sort();
  for (const tag of tags) {
    if (DISCARDED.has(tag) || isOverlayOrCurve(tag)) {
      dropped.add(tag);
      continue;
    }
    // A Private Creator goes with the elements of its block. The MR IOD has
    // no Irradiation Event Identification macro, so the UID stays unassigned.
    const moved =
      MOVED.has(tag) &&
      !(tag === T.IrradiationEventUID && target.name === "MR");
    if (isStructural(tag) || moved || isPrivateCreator(tag)) {
      continue;
    }
    if (sameIn(dicts, tag)) {
      const holder =
        TOP_LEVEL.has(tag) && !CHANGED.has(tag) ? dict : sharedUnassigned;
      const source = dicts.find((d) => d[tag]);
      copyWithCreator(holder, source, tag);
    } else {
      dicts.forEach(
        (d, i) => d[tag] && copyWithCreator(perFrameUnassigned[i], d, tag)
      );
    }
  }

  // Functional groups.
  const perFrameMacros = dicts.map((d) => frameMacros(d, target));
  const keywords = [...new Set(perFrameMacros.flatMap((m) => Object.keys(m)))];
  const shared = {};
  const perFrame = dicts.map(() => ({}));
  for (const keyword of keywords) {
    const placed = macro(perFrameMacros.map((m) => m[keyword]));
    if (placed?.shared) {
      shared[tagOf(keyword)] = sq(...placed.shared);
    } else if (placed) {
      placed.perFrame.forEach((items, i) => {
        if (items) {
          perFrame[i][tagOf(keyword)] = sq(...items);
        }
      });
    }
  }
  if (Object.keys(sharedUnassigned).length) {
    shared[tagOf("UnassignedSharedConvertedAttributesSequence")] =
      sq(sharedUnassigned);
  }
  const unlocated = new Set();
  for (const [sequence, evidenceSequence] of [
    ["ReferencedImageSequence", "ReferencedImageEvidenceSequence"],
    ["SourceImageSequence", "SourceImageEvidenceSequence"],
  ]) {
    const evidence = imageEvidence(dicts, tagOf(sequence), locate, unlocated);
    if (evidence.Value.length) {
      dict[tagOf(evidenceSequence)] = evidence;
    }
  }

  const dimensionOrganization = stack.isStack ? uid() : undefined;
  // The first dimension varies slowest in the frame order.
  const dimensions =
    stack.volumes.length < 2
      ? ["InStackPositionNumber"]
      : stack.layout === "grouped"
        ? ["StackID", "InStackPositionNumber"]
        : ["InStackPositionNumber", "StackID"];
  dicts.forEach((d, i) => {
    const acquired = dateTime(d);
    const { stackId, at } = stack.frames[i];
    const index = { StackID: Number(stackId), InStackPositionNumber: at };
    perFrame[i][tagOf("FrameContentSequence")] = sq(
      item({
        FrameAcquisitionNumber:
          first(d, T.AcquisitionNumber) !== undefined
            ? el(
                "FrameAcquisitionNumber",
                Number(first(d, T.AcquisitionNumber))
              )
            : undefined,
        FrameReferenceDateTime:
          acquired && el("FrameReferenceDateTime", acquired),
        FrameAcquisitionDateTime:
          acquired && el("FrameAcquisitionDateTime", acquired),
        StackID: stack.isStack ? el("StackID", stackId) : undefined,
        InStackPositionNumber: stack.isStack
          ? el("InStackPositionNumber", at)
          : undefined,
        DimensionIndexValues: stack.isStack
          ? el("DimensionIndexValues", ...dimensions.map((k) => index[k]))
          : undefined,
      })
    );
    perFrame[i][tagOf("ConversionSourceAttributesSequence")] = sq(
      item({
        ReferencedSOPClassUID: el(
          "ReferencedSOPClassUID",
          first(d, T.SOPClassUID)
        ),
        ReferencedSOPInstanceUID: el(
          "ReferencedSOPInstanceUID",
          first(d, T.SOPInstanceUID)
        ),
      })
    );
    // Present in every frame, with one item that can be empty (dciodvfy
    // checks the Type and the single item).
    perFrame[i][tagOf("UnassignedPerFrameConvertedAttributesSequence")] = sq(
      perFrameUnassigned[i]
    );
  });
  dict[tagOf("SharedFunctionalGroupsSequence")] = sq(shared);
  dict[tagOf("PerFrameFunctionalGroupsSequence")] = {
    vr: "SQ",
    Value: perFrame,
  };

  if (dimensionOrganization) {
    const pointer = (keyword) =>
      json ? tagOf(keyword) : parseInt(tagOf(keyword), 16);
    Object.assign(
      dict,
      item({
        DimensionOrganizationSequence: sq(
          item({
            DimensionOrganizationUID: el(
              "DimensionOrganizationUID",
              dimensionOrganization
            ),
          })
        ),
        // Volumes at the same positions are not one 3D volume.
        DimensionOrganizationType:
          dimensions.length === 1
            ? el("DimensionOrganizationType", "3D")
            : undefined,
        DimensionIndexSequence: sq(
          ...dimensions.map((keyword) =>
            item({
              DimensionOrganizationUID: el(
                "DimensionOrganizationUID",
                dimensionOrganization
              ),
              DimensionIndexPointer: el(
                "DimensionIndexPointer",
                pointer(keyword)
              ),
              FunctionalGroupPointer: el(
                "FunctionalGroupPointer",
                pointer("FrameContentSequence")
              ),
              DimensionDescriptionLabel: el(
                "DimensionDescriptionLabel",
                keyword === "StackID" ? "Stack ID" : "In-Stack Position"
              ),
            })
          )
        ),
      })
    );
  }

  // The top level of the new instance.
  const types = dicts.map((d) => strings(d, T.ImageType));
  const imageTypeValue = (i, fallback) => {
    const values = new Set(types.map((t) => t[i] ?? fallback));
    return values.size === 1 ? [...values][0] : "MIXED";
  };
  const { date, time } = nowDateTime(now);
  const contents = dicts
    .map((d) => [first(d, T.ContentDate), first(d, T.ContentTime)])
    .filter(([d]) => d)
    .map(([d, t]) => [String(d), String(t ?? "")])
    .sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1]));
  const [contentDate, contentTime] = contents[0] ?? [date, time];
  // Equipment that every source lists stays; the other lists are in the
  // Unassigned Per-Frame Converted Attributes of their frames.
  const equipment = structuredClone(
    sameIn(dicts, T.ContributingEquipmentSequence)
      ? (dicts[0][T.ContributingEquipmentSequence]?.Value ?? [])
      : []
  );
  equipment.push(
    item({
      Manufacturer: el("Manufacturer", "dcmjs.org"),
      ManufacturerModelName: el("ManufacturerModelName", "dcmjs multiframe"),
      ContributionDateTime: el("ContributionDateTime", `${date}${time}`),
      ContributionDescription: el(
        "ContributionDescription",
        "Legacy Converted Enhanced multi-frame conversion"
      ),
      PurposeOfReferenceCodeSequence: sq(
        code("109106", "DCM", "Enhanced Multi-frame Conversion Equipment")
      ),
    })
  );
  Object.assign(
    dict,
    item({
      SOPClassUID: el("SOPClassUID", target.uid),
      SOPInstanceUID: el("SOPInstanceUID", sopInstanceUID),
      InstanceNumber: el("InstanceNumber", instanceNumber),
      NumberOfFrames: el("NumberOfFrames", dicts.length),
      ContentDate: el("ContentDate", contentDate),
      ContentTime: el("ContentTime", contentTime || time),
      InstanceCreationDate: el("InstanceCreationDate", date),
      InstanceCreationTime: el("InstanceCreationTime", time),
      ImageType: el(
        "ImageType",
        imageTypeValue(0, "ORIGINAL"),
        imageTypeValue(1, "PRIMARY"),
        imageTypeValue(2, ""),
        imageTypeValue(3, "")
      ),
      PixelPresentation: el("PixelPresentation", "MONOCHROME"),
      VolumetricProperties: el("VolumetricProperties", "VOLUME"),
      VolumeBasedCalculationTechnique: el(
        "VolumeBasedCalculationTechnique",
        "NONE"
      ),
      ComplexImageComponent:
        target.name === "MR"
          ? el("ComplexImageComponent", "MAGNITUDE")
          : undefined,
      AcquisitionContrast:
        target.name === "MR" ? el("AcquisitionContrast", "UNKNOWN") : undefined,
      ContributingEquipmentSequence: { vr: "SQ", Value: equipment },
    })
  );
  dict[T.AcquisitionContextSequence] ??= { vr: "SQ", Value: [] };
  // Type 1 in the Enhanced CT and MR Image Modules; MONOCHROME2 only.
  dict[tagOf("PresentationLUTShape")] ??= el(
    "PresentationLUTShape",
    "IDENTITY"
  );

  const sorted = Object.fromEntries(
    Object.entries(dict).sort(([a], [b]) => a.localeCompare(b))
  );
  return {
    dict: sorted,
    dropped: [...dropped].sort(),
    unlocated: [...unlocated],
  };
}
