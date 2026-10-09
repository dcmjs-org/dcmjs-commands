// test/staticdicomweb.test.js

import fs from "fs";
import os from "os";
import path from "path";
import nodeCrypto from "node:crypto";
import { DicomAccess } from "../src/access/DicomAccess.js";
import { StaticDicomWebAccess } from "../src/staticdicomweb/StaticDicomWebAccess.js";
import { saveJson } from "../src/utils/saveJson.js";

let tmpDir;
beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dcmjs-commands-sdw-"));
});
afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("DicomAccess.createInstance scheme routing", () => {
  test("file paths route to StaticDicomWebAccess", async () => {
    const access = await DicomAccess.createInstance(tmpDir, {});
    expect(access).toBeInstanceOf(StaticDicomWebAccess);
  });

  test("http URLs route to DicomWebAccess", async () => {
    // Stub the XHR global so the lazy jsdom bootstrap is skipped — jest's
    // CJS loader cannot load jsdom 26's ESM-only transitive deps. Under
    // plain node the bootstrap runs for real (covered by manual spike).
    const hadXhr = "XMLHttpRequest" in globalThis;
    if (!hadXhr) {
      globalThis.XMLHttpRequest = class XMLHttpRequestStub {};
    }
    try {
      const access = await DicomAccess.createInstance(
        "http://example.com/dicomweb",
        {}
      );
      expect(access.constructor.name).toBe("DicomWebAccess");
    } finally {
      if (!hadXhr) {
        delete globalThis.XMLHttpRequest;
      }
    }
  });

  test("unknown schemes throw", async () => {
    await expect(
      DicomAccess.createInstance("gopher://x", { scheme: "gopher" })
    ).rejects.toThrow(/Unsupported DICOM source/);
  });

  test("add() caches per study UID", async () => {
    const access = await DicomAccess.createInstance(tmpDir, {});
    const a = access.add("1.2.3");
    const b = access.add("1.2.3");
    expect(a).toBe(b);
  });
});

describe("StaticDicomWebStudy tree navigation", () => {
  test("read() and queryChildren() navigate a saved tree", async () => {
    const studyUID = "1.2.3.4";
    const seriesUID = "5.6.7.8";
    const root = path.join(tmpDir, "nav-root");
    const studyDir = path.join(root, "studies", studyUID);

    const studyQueryJson = [
      {
        "0020000D": { vr: "UI", Value: [studyUID] },
        "00100010": { vr: "PN", Value: [{ Alphabetic: "Doe^Jane" }] },
      },
    ];
    const seriesIndexJson = [
      {
        "0020000D": { vr: "UI", Value: [studyUID] },
        "0020000E": { vr: "UI", Value: [seriesUID] },
        "00080060": { vr: "CS", Value: ["MR"] },
      },
    ];
    await saveJson(studyDir, "index.json.gz", studyQueryJson);
    await saveJson(
      path.join(studyDir, "series"),
      "index.json.gz",
      seriesIndexJson
    );

    const access = await DicomAccess.createInstance(root, {});
    const study = await access.queryStudy(studyUID);
    expect(study.natural[0].PatientName[0].Alphabetic).toBe("Doe^Jane");

    const children = await study.queryChildren();
    expect(children).toHaveLength(1);
    expect(children[0].uid).toBe(seriesUID);
    // Cached on the second query
    expect(await study.queryChildren()).toHaveLength(1);
  });
});

describe("StaticDicomWebInstance.storeBulkdataItem", () => {
  test("stores multipart-wrapped bulkdata at the hashed path", async () => {
    const root = path.join(tmpDir, "bulk-root");
    const access = new StaticDicomWebAccess(root, {});
    const study = access.createAccess("1.2.3");
    const series = study.createAccess("4.5.6");
    const instance = series.createAccess("7.8.9");

    const payload = new TextEncoder().encode("bulk-payload-bytes");
    const source = {
      openBulkdata: async () => ({
        buffer: payload,
        encapsulated: false,
        contentType: "application/octet-stream",
        transferSyntaxUID: "1.2.840.10008.1.2.1",
      }),
    };

    const relative = await instance.storeBulkdataItem("00420011", source, {
      BulkDataURI: "bulkdata/original",
    });

    const hash = nodeCrypto.createHash("sha1").update(payload).digest("hex");
    expect(relative).toBe(
      `../../bulkdata/${hash.substring(0, 3)}/${hash.substring(3, 6)}/${hash}.mht`
    );

    const storedPath = path.join(
      root,
      "studies",
      "1.2.3",
      "bulkdata",
      hash.substring(0, 3),
      hash.substring(3, 6),
      `${hash}.mht`
    );
    expect(fs.existsSync(storedPath)).toBe(true);

    const stored = fs.readFileSync(storedPath, "latin1");
    expect(stored).toContain(
      "Content-Type: application/octet-stream;transfer-syntax=1.2.840.10008.1.2.1"
    );
    expect(stored).toContain("bulk-payload-bytes");
  });

  test("second store of identical bulkdata is a no-op (dedup by hash)", async () => {
    const root = path.join(tmpDir, "bulk-root2");
    const access = new StaticDicomWebAccess(root, {});
    const instance = access
      .createAccess("1.2.3")
      .createAccess("4.5.6")
      .createAccess("7.8.9");

    const payload = new TextEncoder().encode("dedup-payload");
    const source = {
      openBulkdata: async () => ({
        buffer: payload,
        encapsulated: false,
        contentType: "application/octet-stream",
        transferSyntaxUID: "1.2.840.10008.1.2.1",
      }),
    };

    const first = await instance.storeBulkdataItem("00420011", source, {
      BulkDataURI: "bulkdata/x",
    });
    const second = await instance.storeBulkdataItem("00420011", source, {
      BulkDataURI: "bulkdata/x",
    });
    expect(second).toBe(first);
  });
});
