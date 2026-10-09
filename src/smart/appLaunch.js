// src/smart/appLaunch.js
//
// SMART App Launch (standalone, public client + PKCE) for a command-line
// tool: build the authorization URL, catch the redirect on a loopback
// http listener (or let the user paste the code), and exchange the code
// at the token endpoint. Ported from the browser implementation in
// ohif-fhir-viewer's smartAuth.js onto node:crypto and node:http.

import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import readline from "node:readline";

export const DEFAULT_REDIRECT_PORT = 8765;
export const REDIRECT_PATH = "/callback";
export const DEFAULT_AUTH_TIMEOUT_MS = 300_000;

/** RFC 7636 pair: challenge = BASE64URL(SHA256(ASCII(verifier))). */
export function generatePkce() {
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");
  return { codeVerifier, codeChallenge };
}

/** Opaque CSRF state parameter. */
export function generateState() {
  return randomBytes(16).toString("base64url");
}

/**
 * Authorization-code request URL per SMART App Launch: the FHIR base goes
 * in `aud` so the authorization server knows which resource server the
 * token is for (the imaging server accepts the same token).
 */
export function buildAuthorizationUrl({
  authorizationEndpoint,
  clientId,
  redirectUri,
  scope,
  state,
  codeChallenge,
  aud,
  launch,
}) {
  const url = new URL(authorizationEndpoint);
  const params = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope,
    state,
    aud,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  };
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  if (launch) {
    url.searchParams.set("launch", launch);
  }
  return url.toString();
}

/**
 * One-shot loopback listener for the authorization redirect. Resolves
 * {code, state} from the first request on `path`, answers the browser
 * with a close-this-tab page, and shuts down.
 */
export function runLoopbackListener({
  port = DEFAULT_REDIRECT_PORT,
  host = "127.0.0.1",
  path = REDIRECT_PATH,
  timeoutMs = DEFAULT_AUTH_TIMEOUT_MS,
  onListening,
} = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      server.close();
      fn();
    };

    const server = http.createServer((req, res) => {
      const reqUrl = new URL(req.url, `http://${host}`);
      if (reqUrl.pathname !== path) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("not found");
        return;
      }
      const code = reqUrl.searchParams.get("code");
      const error = reqUrl.searchParams.get("error");
      const state = reqUrl.searchParams.get("state");
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        "<html><body><p>Authorization response received — you can close " +
          "this tab and return to the terminal.</p></body></html>"
      );
      finish(() => {
        if (error) {
          const description = reqUrl.searchParams.get("error_description");
          reject(
            new Error(
              `the authorization server redirected back with error ` +
                `"${error}"${description ? ` (${description})` : ""} — no ` +
                `code was issued, so no token can be requested; check ` +
                `--client-id and the requested --scope`
            )
          );
        } else if (!code) {
          reject(
            new Error(
              `the redirect to ${path} carried no "code" parameter — ` +
                `authorization did not complete; re-run and finish the ` +
                `browser flow, or use --paste-code`
            )
          );
        } else {
          resolve({ code, state });
        }
      });
    });

    const timer = setTimeout(() => {
      finish(() =>
        reject(
          new Error(
            `no authorization redirect arrived on http://${host}:${port}` +
              `${path} within ${Math.round(timeoutMs / 1000)}s — the ` +
              `browser flow was not completed; re-run and authorize, or ` +
              `use --paste-code if the browser cannot reach this machine`
          )
        )
      );
    }, timeoutMs);
    timer.unref?.();

    server.on("error", (err) => {
      finish(() =>
        reject(
          new Error(
            `could not listen on ${host}:${port} (${err.message}) — the ` +
              `registered redirect URI needs this exact port; free it or ` +
              `pick another with --redirect-port (and update the client ` +
              `registration), or use --paste-code`
          )
        )
      );
    });
    server.listen(port, host, () => {
      onListening?.(server.address().port);
    });
  });
}

/**
 * --paste-code fallback: read the code (or the whole redirect URL —
 * the code/state are extracted) from the terminal.
 */
export function promptForCode({
  input = process.stdin,
  output = process.stderr,
} = {}) {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input, output });
    rl.question(
      "Paste the authorization code (or the full redirect URL): ",
      (answer) => {
        rl.close();
        const trimmed = answer.trim();
        if (!trimmed) {
          reject(
            new Error(
              `nothing was pasted — without an authorization code there ` +
                `is no token to request; re-run and paste the code (or ` +
                `the full redirect URL) from the browser`
            )
          );
          return;
        }
        try {
          const url = new URL(trimmed);
          const code = url.searchParams.get("code");
          if (code) {
            resolve({ code, state: url.searchParams.get("state") });
            return;
          }
        } catch {
          // not a URL — treat the paste as the bare code
        }
        resolve({ code: trimmed, state: undefined });
      }
    );
  });
}

/**
 * POST the token endpoint (form-encoded, public client + PKCE verifier).
 * @returns {Promise<Object>} the token response — access_token, and for
 *   patient-scoped launches the `patient` launch-context id.
 */
export async function exchangeCodeForToken({
  tokenEndpoint,
  code,
  clientId,
  redirectUri,
  codeVerifier,
  fetchFn,
}) {
  const doFetch = fetchFn ?? globalThis.fetch;
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });

  const response = await doFetch(tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `token exchange at ${tokenEndpoint} failed with HTTP ` +
        `${response.status}${text ? ` (${text.slice(0, 300)})` : ""} — ` +
        `no access token was issued; authorization codes are single-use ` +
        `and short-lived, so re-run the flow, and check --client-id ` +
        `matches the registration for redirect port ${new URL(redirectUri).port}`
    );
  }
  const token = await response.json();
  if (!token.access_token) {
    throw new Error(
      `the token endpoint answered without an access_token — the imaging ` +
        `server cannot be called; check the authorization server's SMART ` +
        `App Launch support, or supply a token directly with --token`
    );
  }
  return token;
}
