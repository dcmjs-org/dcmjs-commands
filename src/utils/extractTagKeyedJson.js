// src/utils/extractTagKeyedJson.js
//
// Pluck DICOM JSON (tag-keyed { vr, Value } entries) out of an arbitrary
// JSON document. Metadata sidecars in the wild — often LLM-generated — wrap
// the real DICOM JSON in ad-hoc envelopes ("provenance" blocks,
// "FileMetaInformation" sub-objects, export notes). Rather than hard-coding
// any one schema, walk the document: whatever looks like a DICOM JSON entry
// is collected, wherever it sits; everything else is reported, not silently
// dropped.

const TAG_KEY = /^[0-9A-Fa-f]{8}$/;

function isTagEntry(key, value) {
  return (
    TAG_KEY.test(key) &&
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof value.vr === "string"
  );
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {Object} json - parsed sidecar document
 * @returns {{ tags: Object, meta: Object, ignoredKeys: string[] }}
 *   tags: dataset entries (tag-keyed, group 0002 excluded)
 *   meta: group-0002 entries (informational — writers mint fresh file meta)
 *   ignoredKeys: top-level-relative paths whose subtrees held no tag entries
 */
export function extractTagKeyedJson(json) {
  const tags = {};
  const meta = {};
  const ignoredKeys = [];

  // Breadth-first so the shallowest occurrence of a tag wins.
  const queue = [{ node: json, path: "" }];
  while (queue.length) {
    const { node, path } = queue.shift();
    let contributed = false;
    const wrappers = [];

    for (const key of Object.keys(node)) {
      const value = node[key];
      if (isTagEntry(key, value)) {
        const tag = key.toUpperCase();
        const target = tag.startsWith("0002") ? meta : tags;
        if (!(tag in target)) {
          target[tag] = value;
        }
        contributed = true;
      } else if (isPlainObject(value)) {
        wrappers.push({
          node: value,
          path: path ? `${path}.${key}` : key,
        });
      } else if (!path) {
        // Non-object scalar/array at the top level: never DICOM JSON.
        ignoredKeys.push(key);
      }
    }

    for (const wrapper of wrappers) {
      queue.push(wrapper);
    }
    if (!contributed && path && !wrappers.length) {
      ignoredKeys.push(path);
    }
  }

  return { tags, meta, ignoredKeys };
}
