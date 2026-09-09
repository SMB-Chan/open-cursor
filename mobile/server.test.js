import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  HttpError,
  isAuthorized,
  parseBoolean,
  readBody,
  resolveMobileHost,
  securityHeaders,
  tokenMatches,
  validateRuntimeBoundary,
} from "./server.js";

test("mobile dashboard defaults to localhost-only", () => {
  assert.equal(resolveMobileHost(undefined, false), "127.0.0.1");
  assert.equal(resolveMobileHost(undefined, true), "0.0.0.0");
  assert.equal(parseBoolean(undefined, false), false);
  assert.equal(parseBoolean("yes", false), true);
});

test("remote bind requires explicit opt-in and a strong token", () => {
  assert.throws(
    () => validateRuntimeBoundary({ host: "0.0.0.0", allowRemote: false, token: "x".repeat(64) }),
    /MOBILE_ALLOW_REMOTE=1/
  );
  assert.throws(
    () => validateRuntimeBoundary({ host: "0.0.0.0", allowRemote: true, token: "too-short" }),
    /at least 32 bytes/
  );
  assert.doesNotThrow(() =>
    validateRuntimeBoundary({ host: "0.0.0.0", allowRemote: true, token: "a".repeat(64) })
  );
});

test("bearer authorization uses exact token matching", () => {
  const token = "a".repeat(64);
  assert.equal(tokenMatches(token, token), true);
  assert.equal(tokenMatches(`${token}x`, token), false);
  assert.equal(
    isAuthorized({ headers: { authorization: `Bearer ${token}` } }, token),
    true
  );
  assert.equal(isAuthorized({ headers: {} }, token), false);
  assert.equal(isAuthorized({ headers: {} }, ""), true);
});

test("request body parser rejects malformed and oversized bodies", async () => {
  const request = (parts) => ({
    async *[Symbol.asyncIterator]() {
      for (const part of parts) yield Buffer.from(part);
    },
  });

  assert.deepEqual(await readBody(request(['{"ok":true}']), 1024), { ok: true });
  await assert.rejects(
    () => readBody(request(["not-json"]), 1024),
    (error) => error instanceof HttpError && error.statusCode === 400
  );
  await assert.rejects(
    () => readBody(request(["x".repeat(20)]), 10),
    (error) => error instanceof HttpError && error.statusCode === 413
  );
});

test("security headers do not enable permissive CORS", () => {
  const headers = securityHeaders("application/json");
  assert.equal(headers["Access-Control-Allow-Origin"], undefined);
  assert.equal(headers["X-Frame-Options"], "DENY");
  assert.equal(headers["X-Content-Type-Options"], "nosniff");
});

test("mobile client contains pairing auth and escapes Git-derived HTML", async () => {
  const html = await readFile(new URL("./public/index.html", import.meta.url), "utf8");
  assert.match(html, /Authorization/);
  assert.match(html, /Bearer/);
  assert.match(html, /escapeHtml/);
  assert.match(html, /sessionStorage/);
});


test("workspace header is forwarded verbatim to preserve spaces and non-ASCII paths", async () => {
  const source = await readFile(new URL("./server.js", import.meta.url), "utf8");
  assert.match(source, /"X-Workspace-Path": WORKSPACE_DIR/);
  assert.doesNotMatch(source, /encodeURI\(WORKSPACE_DIR\)/);
});
