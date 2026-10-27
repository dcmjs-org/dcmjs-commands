// test/utils/message.test.js

import {
  multipartEncode,
  multipartDecode,
  identifyBoundary,
  containsToken,
  findToken,
  stringToUint8Array,
  uint8ArrayToString,
  addHeaders,
} from "../../src/utils/message.js";

function bytes(str) {
  return stringToUint8Array(str);
}

test("string/Uint8Array conversion round-trips", () => {
  const str = "DICM multipart";
  expect(uint8ArrayToString(bytes(str))).toBe(str);
  expect(uint8ArrayToString(bytes(str), 5, 4)).toBe("mult");
});

test("containsToken and findToken locate tokens", () => {
  const message = bytes("aaa--boundary--zzz");
  const token = bytes("--boundary--");
  expect(containsToken(message, token, 3)).toBe(true);
  expect(containsToken(message, token, 0)).toBe(false);
  expect(findToken(message, token)).toBe(3);
  expect(findToken(message, bytes("missing"))).toBe(-1);
  // maxSearchLength bounds the scan
  expect(findToken(message, token, 0, 2)).toBe(-1);
});

test("identifyBoundary picks the -- line out of a header", () => {
  const header = "Content-Type: multipart/related\r\n--BOUND123\r\nX: y";
  expect(identifyBoundary(header)).toBe("--BOUND123");
  expect(identifyBoundary("no boundary here")).toBeNull();
});

test("multipartEncode → multipartDecode round-trips payloads", () => {
  const partA = bytes("part-one-payload").buffer;
  const partB = bytes("part-two!").buffer;

  const { data, boundary } = multipartEncode([partA, partB], "FIXED-BOUNDARY");
  expect(boundary).toBe("FIXED-BOUNDARY");

  const decoded = multipartDecode(data);
  expect(decoded).toHaveLength(2);
  expect(uint8ArrayToString(new Uint8Array(decoded[0]))).toBe(
    "part-one-payload"
  );
  expect(uint8ArrayToString(new Uint8Array(decoded[1]))).toBe("part-two!");
  // Header metadata is attached to each component
  expect(decoded[0].contentType).toBe("application/dicom");
});

test("multipartDecode returns null for non-multipart content", () => {
  expect(multipartDecode(bytes("just some text").buffer)).toBeNull();
});

test("addHeaders extracts contentType and transfer syntax", () => {
  const destination = {};
  addHeaders(
    destination,
    "Content-Type: application/octet-stream; transfer-syntax=1.2.840.10008.1.2.1\r\nX-Other: 1"
  );
  expect(destination.contentType).toBe("application/octet-stream");
  expect(destination.transferSyntaxUID).toBe("1.2.840.10008.1.2.1");
  expect(destination.headers.get("x-other")).toEqual(["1"]);
});
