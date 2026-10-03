// test/smart.test.js
//
// The SMART Imaging Access building blocks: discovery
// (.well-known/smart-configuration, imaging-endpoint selection), App
// Launch (PKCE shape, authorization URL, loopback redirect, token
// exchange), and the ImagingStudy search/Endpoint resolution. All HTTP is
// a recorded fake fetch — no network.

import { createHash } from "node:crypto";
import http from "node:http";
import {
  fetchSmartConfiguration,
  findImagingEndpoint,
} from "../src/smart/discovery.js";
import {
  buildAuthorizationUrl,
  exchangeCodeForToken,
  generatePkce,
  runLoopbackListener,
} from "../src/smart/appLaunch.js";
import {
  buildImagingStudyQuery,
  extractStudyInstanceUID,
  resolveEndpoint,
  searchImagingStudies,
} from "../src/smart/imagingStudy.js";

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/** A fake fetch that records calls and answers from a route table. */
function fakeFetch(routes) {
  const calls = [];
  const fetchFn = async (url, options = {}) => {
    calls.push({ url, options });
    for (const [match, response] of routes) {
      if (url.includes(match)) {
        return typeof response === "function"
          ? response(url, options)
          : response;
      }
    }
    throw new Error(`unrouted fetch: ${url}`);
  };
  return { fetchFn, calls };
}

// --- discovery ---

describe("fetchSmartConfiguration", () => {
  test("GETs <base>/.well-known/smart-configuration (trailing slash safe)", async () => {
    const config = { capabilities: ["smart-imaging-access"] };
    const { fetchFn, calls } = fakeFetch([
      ["/.well-known/smart-configuration", jsonResponse(config)],
    ]);
    const result = await fetchSmartConfiguration("https://fhir.example/r4/", {
      fetchFn,
    });
    expect(result).toEqual(config);
    expect(calls[0].url).toBe(
      "https://fhir.example/r4/.well-known/smart-configuration"
    );
    expect(calls[0].options.headers.Accept).toBe("application/json");
  });

  test("404 is a corrective error naming the fallback flags", async () => {
    const { fetchFn } = fakeFetch([
      ["/.well-known/smart-configuration", jsonResponse({}, 404)],
    ]);
    await expect(
      fetchSmartConfiguration("https://fhir.example", { fetchFn })
    ).rejects.toThrow(/404.*--imaging-url/s);
  });

  test("unreachable server is a corrective error", async () => {
    const fetchFn = async () => {
      throw new Error("ECONNREFUSED");
    };
    await expect(
      fetchSmartConfiguration("https://fhir.example", { fetchFn })
    ).rejects.toThrow(/could not reach.*--fhir-url/s);
  });
});

describe("findImagingEndpoint", () => {
  test("prefers an associated_endpoints entry with the capability", () => {
    const config = {
      capabilities: ["launch-standalone"],
      associated_endpoints: [
        { url: "https://other.example/fhir", capabilities: ["other"] },
        {
          url: "https://imaging.example/fhir/",
          capabilities: ["smart-imaging-access"],
        },
      ],
    };
    expect(findImagingEndpoint(config, "https://fhir.example")).toBe(
      "https://imaging.example/fhir"
    );
  });

  test("top-level capability means the base itself serves imaging", () => {
    const config = { capabilities: ["smart-imaging-access"] };
    expect(findImagingEndpoint(config, "https://fhir.example/r4/")).toBe(
      "https://fhir.example/r4"
    );
  });

  test("no capability anywhere yields null (caller falls back)", () => {
    const config = {
      capabilities: ["launch-standalone"],
      associated_endpoints: [{ url: "https://x.example", capabilities: [] }],
    };
    expect(findImagingEndpoint(config, "https://fhir.example")).toBeNull();
  });
});

// --- App Launch ---

describe("generatePkce", () => {
  test("challenge is BASE64URL(SHA256(verifier))", () => {
    const { codeVerifier, codeChallenge } = generatePkce();
    const expected = createHash("sha256")
      .update(codeVerifier)
      .digest("base64url");
    expect(codeChallenge).toBe(expected);
    // 32 random bytes → 43 base64url chars, URL-safe alphabet only
    expect(codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test("each pair is fresh", () => {
    expect(generatePkce().codeVerifier).not.toBe(generatePkce().codeVerifier);
  });
});

describe("buildAuthorizationUrl", () => {
  test("carries the full SMART App Launch parameter set", () => {
    const url = new URL(
      buildAuthorizationUrl({
        authorizationEndpoint: "https://auth.example/authorize",
        clientId: "my-client",
        redirectUri: "http://127.0.0.1:8765/callback",
        scope: "patient/ImagingStudy.rs",
        state: "st123",
        codeChallenge: "chal456",
        aud: "https://fhir.example/r4",
      })
    );
    expect(url.origin + url.pathname).toBe("https://auth.example/authorize");
    const p = url.searchParams;
    expect(p.get("response_type")).toBe("code");
    expect(p.get("client_id")).toBe("my-client");
    expect(p.get("redirect_uri")).toBe("http://127.0.0.1:8765/callback");
    expect(p.get("scope")).toBe("patient/ImagingStudy.rs");
    expect(p.get("state")).toBe("st123");
    expect(p.get("code_challenge")).toBe("chal456");
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.get("aud")).toBe("https://fhir.example/r4");
    expect(p.get("launch")).toBeNull();
  });
});

describe("runLoopbackListener", () => {
  test("resolves code and state from the redirect", async () => {
    let boundPort;
    const listening = runLoopbackListener({
      port: 0,
      timeoutMs: 5000,
      onListening: (port) => {
        boundPort = port;
        http.get(
          `http://127.0.0.1:${port}/callback?code=abc123&state=st9`,
          { agent: false },
          (res) => res.resume()
        );
      },
    });
    await expect(listening).resolves.toEqual({ code: "abc123", state: "st9" });
    expect(boundPort).toBeGreaterThan(0);
  });

  test("an error redirect rejects with the server's error", async () => {
    const listening = runLoopbackListener({
      port: 0,
      timeoutMs: 5000,
      onListening: (port) => {
        http.get(
          `http://127.0.0.1:${port}/callback?error=access_denied`,
          { agent: false },
          (res) => res.resume()
        );
      },
    });
    await expect(listening).rejects.toThrow(/access_denied.*--client-id/s);
  });
});

describe("exchangeCodeForToken", () => {
  const params = {
    tokenEndpoint: "https://auth.example/token",
    code: "code789",
    clientId: "my-client",
    redirectUri: "http://127.0.0.1:8765/callback",
    codeVerifier: "verif000",
  };

  test("POSTs the form-encoded PKCE exchange", async () => {
    const token = { access_token: "tok", patient: "p1", expires_in: 3600 };
    const { fetchFn, calls } = fakeFetch([["/token", jsonResponse(token)]]);
    const result = await exchangeCodeForToken({ ...params, fetchFn });
    expect(result).toEqual(token);

    const call = calls[0];
    expect(call.url).toBe("https://auth.example/token");
    expect(call.options.method).toBe("POST");
    expect(call.options.headers["Content-Type"]).toBe(
      "application/x-www-form-urlencoded"
    );
    const body = new URLSearchParams(call.options.body);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("code789");
    expect(body.get("client_id")).toBe("my-client");
    expect(body.get("redirect_uri")).toBe("http://127.0.0.1:8765/callback");
    expect(body.get("code_verifier")).toBe("verif000");
  });

  test("a refused exchange is a corrective error", async () => {
    const { fetchFn } = fakeFetch([
      ["/token", jsonResponse({ error: "invalid_grant" }, 400)],
    ]);
    await expect(exchangeCodeForToken({ ...params, fetchFn })).rejects.toThrow(
      /400.*re-run/s
    );
  });

  test("an answer without access_token is a corrective error", async () => {
    const { fetchFn } = fakeFetch([["/token", jsonResponse({ ok: true })]]);
    await expect(exchangeCodeForToken({ ...params, fetchFn })).rejects.toThrow(
      /access_token.*--token/s
    );
  });
});

// --- ImagingStudy search ---

describe("buildImagingStudyQuery", () => {
  function queryParams(args) {
    const path = buildImagingStudyQuery(args);
    expect(path.startsWith("/ImagingStudy?")).toBe(true);
    return new URLSearchParams(path.split("?")[1]);
  }

  test("always includes patient and _include=ImagingStudy:endpoint", () => {
    const p = queryParams({ patient: "p1" });
    expect(p.get("patient")).toBe("p1");
    expect(p.get("_include")).toBe("ImagingStudy:endpoint");
    expect(p.has("_lastUpdated")).toBe(false);
    expect(p.has("identifier")).toBe(false);
  });

  test("bare --last-updated dates become gt<date>; prefixes pass through", () => {
    expect(
      queryParams({ patient: "p1", lastUpdated: "2026-01-01" }).get(
        "_lastUpdated"
      )
    ).toBe("gt2026-01-01");
    expect(
      queryParams({ patient: "p1", lastUpdated: "ge2026-01-01" }).get(
        "_lastUpdated"
      )
    ).toBe("ge2026-01-01");
  });

  test("--study-uid becomes identifier=urn:oid:<uid> (idempotently)", () => {
    expect(
      queryParams({ patient: "p1", studyUid: "1.2.3" }).get("identifier")
    ).toBe("urn:oid:1.2.3");
    expect(
      queryParams({ patient: "p1", studyUid: "urn:oid:1.2.3" }).get(
        "identifier"
      )
    ).toBe("urn:oid:1.2.3");
  });

  test("all narrowers combine", () => {
    const p = queryParams({
      patient: "p1",
      lastUpdated: "2026-01-01",
      studyUid: "1.2.3",
    });
    expect(p.get("patient")).toBe("p1");
    expect(p.get("_lastUpdated")).toBe("gt2026-01-01");
    expect(p.get("identifier")).toBe("urn:oid:1.2.3");
    expect(p.get("_include")).toBe("ImagingStudy:endpoint");
  });
});

describe("extractStudyInstanceUID", () => {
  test("urn:dicom:uid identifier wins and urn:oid: is stripped", () => {
    expect(
      extractStudyInstanceUID({
        identifier: [
          { system: "https://pacs.example/accession", value: "A123" },
          { system: "urn:dicom:uid", value: "urn:oid:1.2.3.4" },
        ],
      })
    ).toBe("1.2.3.4");
  });

  test("falls back to any identifier value", () => {
    expect(
      extractStudyInstanceUID({
        identifier: [{ value: "urn:oid:5.6.7" }],
      })
    ).toBe("5.6.7");
  });

  test("no identifiers yields undefined", () => {
    expect(extractStudyInstanceUID({})).toBeUndefined();
  });
});

describe("resolveEndpoint", () => {
  const WADO = {
    system: "http://terminology.hl7.org/CodeSystem/endpoint-connection-type",
    code: "dicom-wado-rs",
  };

  test("contained #id reference", () => {
    const study = {
      id: "s1",
      endpoint: [{ reference: "#e" }],
      contained: [
        {
          resourceType: "Endpoint",
          id: "e",
          connectionType: WADO,
          address: "https://img.example/wado",
        },
      ],
    };
    expect(resolveEndpoint({ entry: [] }, study).address).toBe(
      "https://img.example/wado"
    );
  });

  test("relative reference resolved against Bundle entries", () => {
    const bundle = {
      entry: [
        {
          fullUrl: "https://img.example/fhir/Endpoint/ep1",
          resource: {
            resourceType: "Endpoint",
            id: "ep1",
            connectionType: WADO,
            address: "https://img.example/wado",
          },
        },
      ],
    };
    const study = { id: "s1", endpoint: [{ reference: "Endpoint/ep1" }] };
    expect(resolveEndpoint(bundle, study).address).toBe(
      "https://img.example/wado"
    );
  });

  test("absolute reference matched by entry fullUrl", () => {
    const bundle = {
      entry: [
        {
          fullUrl: "https://img.example/fhir/Endpoint/ep2",
          resource: {
            resourceType: "Endpoint",
            id: "ep2",
            connectionType: WADO,
            address: "https://img.example/wado2",
          },
        },
      ],
    };
    const study = {
      id: "s1",
      endpoint: [{ reference: "https://img.example/fhir/Endpoint/ep2" }],
    };
    expect(resolveEndpoint(bundle, study).address).toBe(
      "https://img.example/wado2"
    );
  });

  test("prefers a dicom-wado-rs Endpoint over other connection types", () => {
    const study = {
      id: "s1",
      endpoint: [{ reference: "#a" }, { reference: "#b" }],
      contained: [
        {
          resourceType: "Endpoint",
          id: "a",
          connectionType: { code: "hl7-fhir-rest" },
          address: "https://img.example/fhir",
        },
        {
          resourceType: "Endpoint",
          id: "b",
          connectionType: { coding: [WADO] },
          address: "https://img.example/wado",
        },
      ],
    };
    expect(resolveEndpoint({ entry: [] }, study).address).toBe(
      "https://img.example/wado"
    );
  });

  test("no resolvable Endpoint is a corrective error", () => {
    const study = { id: "s1", endpoint: [{ reference: "Endpoint/ghost" }] };
    expect(() => resolveEndpoint({ entry: [] }, study)).toThrow(
      /ImagingStudy\/s1.*Endpoint\.address.*_include=ImagingStudy:endpoint/s
    );
  });
});

describe("searchImagingStudies", () => {
  const bundle = {
    resourceType: "Bundle",
    entry: [
      {
        resource: {
          resourceType: "ImagingStudy",
          id: "s1",
          identifier: [{ system: "urn:dicom:uid", value: "urn:oid:1.2.3" }],
          endpoint: [{ reference: "#e" }],
          contained: [
            {
              resourceType: "Endpoint",
              id: "e",
              connectionType: { code: "dicom-wado-rs" },
              address: "https://img.example/wado/abc/",
            },
          ],
        },
      },
      {
        // included resources are skipped, not mistaken for studies
        resource: { resourceType: "Endpoint", id: "stray" },
      },
    ],
  };

  test("queries with Bearer auth and resolves studies to WADO bases", async () => {
    const { fetchFn, calls } = fakeFetch([
      ["/ImagingStudy?", jsonResponse(bundle)],
    ]);
    const result = await searchImagingStudies({
      imagingBase: "https://img.example/fhir/",
      token: "tok1",
      patient: "p1",
      fetchFn,
    });
    expect(calls[0].url).toMatch(
      /^https:\/\/img\.example\/fhir\/ImagingStudy\?patient=p1/
    );
    expect(calls[0].options.headers.Authorization).toBe("Bearer tok1");
    expect(calls[0].options.headers.Accept).toBe("application/fhir+json");
    expect(result.studies).toHaveLength(1);
    expect(result.studies[0].studyInstanceUID).toBe("1.2.3");
    expect(result.studies[0].wadoBase).toBe("https://img.example/wado/abc");
  });

  test("401 is a corrective error about the token", async () => {
    const { fetchFn } = fakeFetch([["/ImagingStudy?", jsonResponse({}, 401)]]);
    await expect(
      searchImagingStudies({
        imagingBase: "https://img.example/fhir",
        token: "expired",
        patient: "p1",
        fetchFn,
      })
    ).rejects.toThrow(/401.*--scope/s);
  });

  test("a non-Bundle answer is a corrective error", async () => {
    const { fetchFn } = fakeFetch([
      ["/ImagingStudy?", jsonResponse({ resourceType: "OperationOutcome" })],
    ]);
    await expect(
      searchImagingStudies({
        imagingBase: "https://img.example/fhir",
        patient: "p1",
        fetchFn,
      })
    ).rejects.toThrow(/OperationOutcome.*--imaging-url/s);
  });
});
