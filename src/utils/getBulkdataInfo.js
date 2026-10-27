import { createHash } from "node:crypto";

/**
 * Hash and content-type info for a non-pixel bulkdata value. The hash is
 * SHA-256 to match Static-DICOMweb's bulkdata naming, so both tools
 * write the same ../../bulkdata/<h[0:3]>/<h[3:6]>/<h>.mht path for the
 * same bytes. The signature stays async for the existing call sites.
 */
export async function getBulkdataInfo(key, child, bulkdata) {
  const { contentType } = bulkdata;
  const view =
    bulkdata instanceof ArrayBuffer ? new Uint8Array(bulkdata) : bulkdata;
  const hashCode = createHash("sha256").update(view).digest("hex");
  return { contentType, hashCode, extension: "mht" };
}

/** The series-relative bulkdata URI for a hash: ../../bulkdata/aaa/bbb/<hash>.<ext> */
export function bulkdataUriFor(hashCode, extension = "mht") {
  return (
    `../../bulkdata/${hashCode.substring(0, 3)}/` +
    `${hashCode.substring(3, 6)}/${hashCode}.${extension}`
  );
}

export default getBulkdataInfo;
