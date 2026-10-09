// test/utils/fixBulkDataURI.test.js

import { fixBulkDataURI } from "../../src/utils/fixBulkDataURI.js";

const instance = {
  StudyInstanceUID: "1.2.3",
  SeriesInstanceUID: "4.5.6",
};

function fix(uri, config) {
  const value = { BulkDataURI: uri };
  fixBulkDataURI(value, instance, config);
  return value.BulkDataURI;
}

test("series-relative URIs resolve under the series by default", () => {
  expect(fix("instances/7/bulk", { wadoRoot: "http://x/dicomweb" })).toBe(
    "http://x/dicomweb/studies/1.2.3/series/4.5.6/instances/7/bulk"
  );
});

test("series/ and bulkdata/ URIs resolve under the study", () => {
  expect(fix("series/4.5.6/bulk", { wadoRoot: "http://x/dicomweb" })).toBe(
    "http://x/dicomweb/studies/1.2.3/series/4.5.6/bulk"
  );
  expect(fix("bulkdata/abc", { wadoRoot: "http://x/dicomweb" })).toBe(
    "http://x/dicomweb/studies/1.2.3/bulkdata/abc"
  );
});

test("relativeResolution studies routes plain URIs under the study", () => {
  expect(
    fix("frames/1", {
      wadoRoot: "http://x/dicomweb",
      bulkDataURI: { relativeResolution: "studies" },
    })
  ).toBe("http://x/dicomweb/studies/1.2.3/frames/1");
});

test("server-relative URIs use the wadoRoot origin when absolute", () => {
  expect(fix("/bulk/1e", { wadoRoot: "http://myserver.com/dicomweb" })).toBe(
    "http://myserver.com/bulk/1e"
  );
});

test("server-relative URIs stay put for relative wadoRoot", () => {
  expect(fix("/bulk/1e", { wadoRoot: "/dicomweb" })).toBe("/bulk/1e");
});

test("startsWith/prefixWith rewrites incorrect origins", () => {
  expect(
    fix("http://wrong-host/path/bulk", {
      wadoRoot: "http://x/dicomweb",
      bulkDataURI: {
        startsWith: "http://wrong-host",
        prefixWith: "http://right-host",
      },
    })
  ).toBe("http://right-host/path/bulk");
});

test("absolute http URIs pass through untouched", () => {
  expect(fix("http://elsewhere/data", { wadoRoot: "http://x" })).toBe(
    "http://elsewhere/data"
  );
});
