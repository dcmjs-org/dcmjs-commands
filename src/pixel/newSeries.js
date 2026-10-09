// src/pixel/newSeries.js
//
// `transcode --new-series`: copies of existing instances that an archive
// accepts as new data, for testing re-uploads. Every series, instance,
// pyramid and concatenation UID gets a new value, and every UI value in
// every file goes through the same map, so references between the copies
// (for example a bulk annotation to its image) stay valid. SeriesNumber
// goes up by 1000 and SeriesDescription gets "(copy N)", so each round of
// copies of copies is told apart.

import { readPart10Header } from "./frameReader.js";

/** UIDs that identify the copied objects themselves. */
const IDENTITY_TAGS = [
  "0020000E", // SeriesInstanceUID
  "00080018", // SOPInstanceUID
  "00080019", // PyramidUID
  "00209161", // ConcatenationUID
];

const SERIES_NUMBER = "00200011";
const SERIES_NUMBER_OFFSET = 1000;
const SERIES_DESCRIPTION = "0008103E";
const LO_MAX = 64;
const COPY_SUFFIX = / \(copy (\d+)\)$/;

/**
 * "Liver" → "Liver (copy 1)", "Liver (copy 1)" → "Liver (copy 2)", so each
 * round of re-uploads is told apart. The base text is cut to keep the LO
 * value within 64 characters.
 */
export function nextSeriesDescription(description = "") {
  const match = description.match(COPY_SUFFIX);
  const base = match ? description.slice(0, match.index) : description;
  const suffix = ` (copy ${match ? Number(match[1]) + 1 : 1})`;
  return (base.slice(0, LO_MAX - suffix.length) + suffix).trimStart();
}

/** Date and time elements set to the time of the run. */
const DATE_TIMES = [
  ["00080012", "00080013"], // InstanceCreationDate/Time
  ["00080021", "00080031"], // SeriesDate/Time
  ["00080023", "00080033"], // ContentDate/Time
];

const pad = (value, length = 2) => String(value).padStart(length, "0");

function dicomDateTime(now) {
  return {
    date: `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`,
    time: `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`,
  };
}

function remapUids(dict, map) {
  for (const element of Object.values(dict)) {
    if (element?.vr === "UI" && element.Value) {
      element.Value = element.Value.map((uid) => map.get(uid) ?? uid);
    } else if (element?.vr === "SQ" && element.Value) {
      element.Value.forEach((item) => item && remapUids(item, map));
    }
  }
}

/**
 * Reads the header of each file and gives each identifying UID a new one.
 *
 * @returns {Promise<{ map: Map<string, string>, series: Map<string, string>,
 *   rewrite: (meta: object, dict: object) => void }>} `rewrite` changes a
 *   file's `{ meta, dict }` in place.
 */
export async function planNewSeries({ dcmjs, files, now = new Date() }) {
  const newUid = () => dcmjs.data.DicomMetaDictionary.uid();
  const map = new Map();
  const series = new Map();
  for (const file of files) {
    const { dict } = await readPart10Header({ dcmjs, inputPath: file });
    for (const tag of IDENTITY_TAGS) {
      const uid = dict[tag]?.Value?.[0];
      if (uid && !map.has(uid)) {
        map.set(uid, newUid());
        if (tag === "0020000E") {
          series.set(uid, map.get(uid));
        }
      }
    }
  }

  const { date, time } = dicomDateTime(now);
  function rewrite(meta, dict) {
    remapUids(dict, map);
    remapUids(meta, map);
    const number = Number(dict[SERIES_NUMBER]?.Value?.[0] ?? 0);
    dict[SERIES_NUMBER] = { vr: "IS", Value: [number + SERIES_NUMBER_OFFSET] };
    dict[SERIES_DESCRIPTION] = {
      vr: "LO",
      Value: [nextSeriesDescription(dict[SERIES_DESCRIPTION]?.Value?.[0])],
    };
    for (const [dateTag, timeTag] of DATE_TIMES) {
      dict[dateTag] = { vr: "DA", Value: [date] };
      dict[timeTag] = { vr: "TM", Value: [time] };
    }
  }
  return { map, series, rewrite };
}
