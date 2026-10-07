// src/utils/dumpFormat.js
//
// The one tag-line formatter: "(GGGG,EEEE) VR Keyword: value", shared by
// `dcmjs dump`, `dicomwebjs dump` (via dumpDicom), and anonymize's
// dry-run change previews. Three near-copies of this logic drifted
// apart; behavior differences were resolved toward the most informative
// variant (objects stringify instead of printing "<item>").

/**
 * One-line preview of a dict element's value, safe for any VR: binary
 * becomes "[VR N bytes]", Person Names print their Alphabetic form,
 * other objects JSON.stringify, multi-values join with backslash.
 * @param {Object} element - a dict entry ({ vr, Value, ... })
 * @param {{maxLength?: number}} [opts] - truncate with "..." beyond this
 */
export function formatElementValue(element, { maxLength = Infinity } = {}) {
  if (element?.BulkDataURI) {
    return `URL ${element.BulkDataURI}`;
  }
  if (element?.InlineBinary) {
    const bytes = Math.floor((element.InlineBinary.length * 3) / 4);
    return `[inline ${bytes} bytes base64]`;
  }
  const value = element?.Value;
  if (value === undefined || value === null) {
    return "";
  }
  const describe = (item) => {
    if (item instanceof ArrayBuffer || ArrayBuffer.isView(item)) {
      return `[${element.vr || "binary"} ${item.byteLength} bytes]`;
    }
    if (item && typeof item === "object") {
      return "Alphabetic" in item ? item.Alphabetic : JSON.stringify(item);
    }
    return String(item);
  };
  const joined = Array.isArray(value)
    ? value.map(describe).join("\\")
    : describe(value);
  return joined.length > maxLength
    ? `${joined.slice(0, maxLength - 3)}...`
    : joined;
}

/**
 * Print a dict level (meta or dataset) as sorted tag lines, recursing
 * into sequences with indentation.
 * @param {Object} group - tag-keyed dict level
 * @param {Object} args
 * @param {Object} args.dictionary - DicomMetaDictionary.dictionary
 * @param {(line: string) => void} args.stdout
 * @param {string} [args.indent]
 */
export function dumpDict(group, { dictionary, stdout, indent = "" }) {
  for (const tag of Object.keys(group).sort()) {
    if (tag.startsWith("_")) {
      continue;
    }
    const element = group[tag];
    const punctuated = `(${tag.substring(0, 4)},${tag.substring(4, 8)})`;
    const entry = dictionary[punctuated];
    const keyword = entry ? entry.name : "Unknown";
    if (element.vr === "SQ" && Array.isArray(element.Value)) {
      stdout(
        `${indent}${punctuated} SQ ${keyword}: ${element.Value.length} item(s)`
      );
      element.Value.forEach((item) => {
        dumpDict(item, { dictionary, stdout, indent: indent + "    " });
      });
    } else {
      stdout(
        `${indent}${punctuated} ${element.vr} ${keyword}: ` +
          formatElementValue(element)
      );
    }
  }
}
