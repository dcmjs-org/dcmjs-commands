// test/patientAccess.test.js
//
// The patient-access orchestrator: flag validation (every miss names its
// flag), the --token --dry-run end-to-end against a mocked FHIR server
// (global fetch — no network), and the retrieval leg against injected
// DicomAccess fakes carrying the Bearer header.

import { runPatientAccess } from "../src/commands/patientAccess.js";
import { runCli } from "../src/cli.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function capture() {
  const lines = [];
  return { lines, write: (text) => lines.push(text) };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

const SMART_CONFIG = {
  authorization_endpoint: "https://ehr.example/authorize",
  token_endpoint: "https://ehr.example/token",
  capabilities: ["launch-standalone"],
  associated_endpoints: [
    {
      url: "https://img.example/fhir",
      capabilities: ["smart-imaging-access"],
    },
  ],
};

const BUNDLE = {
  resourceType: "Bundle",
  entry: [
    {
      resource: {
        resourceType: "ImagingStudy",
        id: "s1",
        description: "Upper Extremity",
        identifier: [{ system: "urn:dicom:uid", value: "urn:oid:1.2.3.4" }],
        endpoint: [{ reference: "#e" }],
        contained: [
          {
            resourceType: "Endpoint",
            id: "e",
            connectionType: { code: "dicom-wado-rs" },
            address: "https://img.example/wado/abc",
          },
        ],
      },
    },
    {
      fullUrl: "https://img.example/fhir/Endpoint/ep9",
      resource: {
        resourceType: "Endpoint",
        id: "ep9",
        connectionType: { code: "dicom-wado-rs" },
        address: "https://img.example/wado/xyz",
      },
    },
    {
      resource: {
        resourceType: "ImagingStudy",
        id: "s2",
        identifier: [{ system: "urn:dicom:uid", value: "urn:oid:5.6.7.8" }],
        endpoint: [{ reference: "Endpoint/ep9" }],
      },
    },
  ],
};

/** Route global fetch by substring; record every call. */
function mockGlobalFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    for (const [match, response] of routes) {
      if (url.includes(match)) {
        return response;
      }
    }
    throw new Error(`unrouted fetch: ${url}`);
  };
  return calls;
}

async function run(values, overrides = {}) {
  const out = capture();
  const err = capture();
  const code = await runPatientAccess({
    values,
    stdout: out.write,
    stderr: err.write,
    ...overrides,
  });
  return { code, out: out.lines.join("\n"), err: err.lines.join("\n") };
}

describe("flag validation (exit 2, corrective, no network)", () => {
  const cases = [
    [{ "dry-run": true }, /--fhir-url.*--imaging-url/s],
    [{ "fhir-url": "https://x", token: "t", patient: "p" }, /--output/],
    [
      { "fhir-url": "https://x", token: "t", "dry-run": true },
      /--token.*--patient/s,
    ],
    [{ "fhir-url": "https://x", "dry-run": true }, /--client-id/],
    [{ "imaging-url": "https://img", "dry-run": true }, /--fhir-url.*--token/s],
    [
      {
        "fhir-url": "https://x",
        token: "t",
        patient: "p",
        "dry-run": true,
        format: "zip",
      },
      /--format/,
    ],
    [
      {
        "fhir-url": "https://x",
        "client-id": "c",
        "dry-run": true,
        "redirect-port": "not-a-port",
      },
      /--redirect-port|between 1 and 65535/,
    ],
  ];

  test.each(cases)("%j", async (values, pattern) => {
    const calls = mockGlobalFetch([]);
    const { code, err } = await run(values);
    expect(code).toBe(2);
    expect(err).toMatch(pattern);
    expect(calls).toHaveLength(0);
  });
});

describe("--token --dry-run end-to-end (mocked server)", () => {
  test("discovers the imaging endpoint, searches, lists, stops", async () => {
    const calls = mockGlobalFetch([
      ["/.well-known/smart-configuration", jsonResponse(SMART_CONFIG)],
      ["/ImagingStudy?", jsonResponse(BUNDLE)],
    ]);

    const { code, out } = await run({
      "fhir-url": "https://ehr.example/fhir/",
      token: "tok-123",
      patient: "p1",
      "dry-run": true,
    });

    expect(code).toBe(0);
    // discovery hit the clinical server, search hit the imaging server
    expect(calls[0].url).toBe(
      "https://ehr.example/fhir/.well-known/smart-configuration"
    );
    expect(calls[1].url).toMatch(
      /^https:\/\/img\.example\/fhir\/ImagingStudy\?patient=p1&/
    );
    expect(calls[1].url).toContain(
      `_include=${encodeURIComponent("ImagingStudy:endpoint")}`
    );
    expect(calls[1].options.headers.Authorization).toBe("Bearer tok-123");

    // both studies listed with both endpoint shapes resolved
    expect(out).toContain("2 studies for patient p1");
    expect(out).toMatch(/1\.2\.3\.4.*\[Upper Extremity\].*wado\/abc/);
    expect(out).toMatch(/5\.6\.7\.8.*wado\/xyz/);
    expect(out).toMatch(/dry run/);
  });

  test("--last-updated and --study-uid reach the query", async () => {
    const calls = mockGlobalFetch([
      ["/.well-known/smart-configuration", jsonResponse(SMART_CONFIG)],
      ["/ImagingStudy?", jsonResponse({ resourceType: "Bundle", entry: [] })],
    ]);
    const { code, out } = await run({
      "fhir-url": "https://ehr.example/fhir",
      token: "t",
      patient: "p1",
      "dry-run": true,
      "last-updated": "2026-01-01",
      "study-uid": "1.2.3.4",
    });
    expect(code).toBe(0);
    const query = new URL(calls[1].url).searchParams;
    expect(query.get("_lastUpdated")).toBe("gt2026-01-01");
    expect(query.get("identifier")).toBe("urn:oid:1.2.3.4");
    expect(out).toMatch(/0 studies/);
  });

  test("a server without smart-imaging-access says to pass --imaging-url", async () => {
    mockGlobalFetch([
      [
        "/.well-known/smart-configuration",
        jsonResponse({ capabilities: ["launch-standalone"] }),
      ],
    ]);
    const { code, err } = await run({
      "fhir-url": "https://ehr.example/fhir",
      token: "t",
      patient: "p1",
      "dry-run": true,
    });
    expect(code).toBe(1);
    expect(err).toMatch(/smart-imaging-access.*--imaging-url/s);
  });

  test("--imaging-url with --token skips discovery entirely", async () => {
    const calls = mockGlobalFetch([["/ImagingStudy?", jsonResponse(BUNDLE)]]);
    const { code } = await run({
      "imaging-url": "https://img.example/fhir",
      token: "t",
      patient: "p1",
      "dry-run": true,
    });
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("https://img.example/fhir/ImagingStudy?");
  });

  test("--study-uid narrows client-side when the server ignores identifier", async () => {
    // BUNDLE carries two studies — a server that ignores the identifier
    // parameter returns both; only the requested one may be listed.
    mockGlobalFetch([["/ImagingStudy?", jsonResponse(BUNDLE)]]);
    const { code, out } = await run({
      "imaging-url": "https://img.example/fhir",
      token: "t",
      patient: "p1",
      "study-uid": "5.6.7.8",
      "dry-run": true,
    });
    expect(code).toBe(0);
    expect(out).toContain("1 study for patient p1");
    expect(out).toContain("5.6.7.8");
    expect(out).not.toContain("1.2.3.4");
  });
});

describe("retrieval leg (injected DicomAccess fakes)", () => {
  function makeFakes() {
    const calls = { created: [], stored: [], queried: [] };
    const createAccess = async (url, options) => {
      calls.created.push({ url, options });
      if (options?.isDestination) {
        return {
          store: async (study, storeOptions) => {
            calls.stored.push({ study, storeOptions });
          },
        };
      }
      return {
        queryStudy: async (uid) => {
          calls.queried.push(uid);
          return { uid, childrenMap: new Map() };
        },
      };
    };
    return { calls, createAccess };
  }

  test("each study is fetched from its own WADO base with the Bearer header", async () => {
    mockGlobalFetch([["/ImagingStudy?", jsonResponse(BUNDLE)]]);
    const { calls, createAccess } = makeFakes();
    const { code, out } = await run(
      {
        "imaging-url": "https://img.example/fhir",
        token: "tok-9",
        patient: "p1",
        output: "/tmp/pa-out",
      },
      { createAccess }
    );
    expect(code).toBe(0);
    // destination first, then one source per distinct endpoint
    expect(calls.created[0]).toEqual({
      url: "/tmp/pa-out",
      options: { scheme: "file", isDestination: true },
    });
    const sources = calls.created.slice(1);
    expect(sources.map((c) => c.url)).toEqual([
      "https://img.example/wado/abc",
      "https://img.example/wado/xyz",
    ]);
    for (const source of sources) {
      expect(source.options.headers).toEqual({
        Authorization: "Bearer tok-9",
      });
    }
    expect(calls.queried).toEqual(["1.2.3.4", "5.6.7.8"]);
    // default format is the Static-DICOMweb tree
    expect(calls.stored[0].storeOptions.part10).toBe(false);
    expect(calls.stored[0].storeOptions.frames).toBe(true);
    expect(out).toMatch(/2 studies retrieved to \/tmp\/pa-out \(dicomweb\)/);
  });

  test("--format part10 flips the store preset", async () => {
    mockGlobalFetch([["/ImagingStudy?", jsonResponse(BUNDLE)]]);
    const { calls, createAccess } = makeFakes();
    const { code } = await run(
      {
        "imaging-url": "https://img.example/fhir",
        token: "t",
        patient: "p1",
        output: "/tmp/pa-out",
        format: "part10",
      },
      { createAccess }
    );
    expect(code).toBe(0);
    expect(calls.stored[0].storeOptions.part10).toBe(true);
    expect(calls.stored[0].storeOptions.frames).toBe(false);
  });

  test("a search failure surfaces as a corrective error, exit 1", async () => {
    mockGlobalFetch([["/ImagingStudy?", jsonResponse({}, 500)]]);
    const { createAccess } = makeFakes();
    const { code, err } = await run(
      {
        "imaging-url": "https://img.example/fhir",
        token: "t",
        patient: "p1",
        output: "/tmp/pa-out",
      },
      { createAccess }
    );
    expect(code).toBe(1);
    expect(err).toMatch(/500.*--imaging-url/s);
  });
});

describe("cli wiring", () => {
  test("patient-access is routed with its flags parsed", async () => {
    mockGlobalFetch([["/ImagingStudy?", jsonResponse(BUNDLE)]]);
    const out = capture();
    const err = capture();
    const code = await runCli({
      dcmjs: {},
      argv: [
        "patient-access",
        "--imaging-url",
        "https://img.example/fhir",
        "--token",
        "t",
        "--patient",
        "p1",
        "--dry-run",
      ],
      stdout: out.write,
      stderr: err.write,
    });
    expect(code).toBe(0);
    expect(out.lines.join("\n")).toMatch(/dry run/);
  });

  test("patient-access --help prints usage", async () => {
    const out = capture();
    const code = await runCli({
      dcmjs: {},
      argv: ["patient-access", "--help"],
      stdout: out.write,
      stderr: () => {},
    });
    expect(code).toBe(0);
    expect(out.lines.join("\n")).toMatch(/SMART/);
    expect(out.lines.join("\n")).toMatch(/--paste-code/);
  });
});
