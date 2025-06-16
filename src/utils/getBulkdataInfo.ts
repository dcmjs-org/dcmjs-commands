import crypto from "crypto";

export async function getBulkdataInfo(key, child, bulkdata) {
    const { contentType } = bulkdata;
    const uri = child.BulkDataURI;
    const hashBuffer = await crypto.subtle.digest("SHA-1", bulkdata);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashCode = hashArray.map(b => b.toString(16).padStart(2, "0")).join("");

    return { contentType, hashCode, extension: 'mht'};
}

export default getBulkdataInfo;