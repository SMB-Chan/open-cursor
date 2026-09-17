import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { EventEmitter } from "node:events";

import {
  HttpError,
  handleChat,
  isAuthorized,
  parseBoolean,
  readBody,
  requestHandler,
  resolveMobileHost,
  resolveRemoteTransport,
  securityHeaders,
  tokenMatches,
  validateRuntimeBoundary,
  validateTransportConfig,
} from "./server.js";

function proxyRequest() {
  const req = new EventEmitter();
  req[Symbol.asyncIterator] = async function* () {
    yield Buffer.from(JSON.stringify({ model: "goal", prompt: "テスト" }));
  };
  const res = new EventEmitter();
  res.chunks = [];
  res.writeHead = (code, headers) => { res.statusCode = code; res.headers = headers; res.headersSent = true; };
  res.write = (chunk) => { res.chunks.push(Buffer.from(chunk)); return true; };
  res.end = (chunk) => { if (chunk) res.chunks.push(Buffer.from(chunk)); res.writableEnded = true; };
  res.body = () => Buffer.concat(res.chunks).toString("utf8");
  return { req, res };
}

test("chat proxy retains upstream HTTP errors instead of returning success SSE", async () => {
  for (const status of [401, 409, 503]) {
    const { req, res } = proxyRequest();
    await handleChat(req, res, {
      fetchImpl: async () => new Response(JSON.stringify({ error: { message: "Workspace busy" } }), { status }),
    });
    assert.equal(res.statusCode, status);
    assert.deepEqual(JSON.parse(res.body()), { ok: false, error: "Workspace busy" });
    assert.equal(req.listenerCount("aborted"), 0);
    assert.equal(res.listenerCount("close"), 0);
  }
});

test("chat proxy forwards exact stream bytes, including split Unicode and final metadata", async () => {
  const { req, res } = proxyRequest();
  const bytes = new TextEncoder().encode('data: {"text":"日本語 🎉","open_cursor":{"goal":{"status":"complete"}}}\n\ndata: [DONE]\n\n');
  const stream = new ReadableStream({ start(controller) {
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    controller.close();
  } });
  await handleChat(req, res, { fetchImpl: async (_, options) => {
    assert.equal(JSON.parse(options.body).model, "goal");
    assert.equal(JSON.parse(options.body).stream, true);
    return new Response(stream);
  } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(Buffer.concat(res.chunks), Buffer.from(bytes));
  assert.equal(stream.locked, false);
});

test("disconnect aborts an upstream request before response headers arrive", async () => {
  const { req, res } = proxyRequest();
  let upstreamSignal;
  await handleChat(req, res, { fetchImpl: async (_, { signal }) => {
    upstreamSignal = signal;
    res.destroyed = true;
    res.emit("close");
    throw signal.reason;
  } });
  assert.equal(upstreamSignal.aborted, true);
  assert.equal(res.headersSent, undefined);
  assert.equal(req.listenerCount("aborted"), 0);
  assert.equal(res.listenerCount("close"), 0);
});

test("proxy respects backpressure and cancels its reader when the downstream disconnects", async () => {
  const { req, res } = proxyRequest();
  let cancelled = false;
  let written;
  const writing = new Promise((resolve) => { written = resolve; });
  res.write = () => { written(); return false; };
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode("data: first\n\n")); },
    cancel() { cancelled = true; },
  });
  const pending = handleChat(req, res, { fetchImpl: async () => new Response(stream) });
  await writing;
  res.destroyed = true;
  res.emit("close");
  await pending;
  assert.equal(cancelled, true);
  assert.equal(stream.locked, false);
  assert.equal(res.listenerCount("drain"), 0);
  assert.equal(res.listenerCount("close"), 0);
});

test("proxy reports connection errors as HTTP 502 and stream read failures as SSE errors", async () => {
  for (const afterHeaders of [false, true]) {
    const { req, res } = proxyRequest();
    await handleChat(req, res, { fetchImpl: async () => {
      if (!afterHeaders) throw new Error("Bridge unavailable");
      return new Response(new ReadableStream({ start(controller) { controller.error(new Error("Connection lost")); } }));
    } });
    assert.equal(res.statusCode, afterHeaders ? 200 : 502);
    assert.match(res.body(), afterHeaders ? /Connection lost/ : /Bridge unavailable/);
    assert.equal(res.writableEnded, true);
  }
});

test("mobile serves the shared parser and chat controller as JavaScript", async () => {
  for (const url of ["/sse.js", "/chat.js"]) {
    const { res } = proxyRequest();
    await requestHandler({ method: "GET", url, headers: {} }, res);
    assert.equal(res.statusCode, 200);
    assert.match(res.headers["Content-Type"], /javascript/);
    assert.match(res.body(), /OpenCursor/);
  }
});

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
  assert.throws(
    () => validateRuntimeBoundary({ host: "0.0.0.0", allowRemote: true, token: "a".repeat(64) }),
    /MOBILE_REMOTE_TRANSPORT/
  );
  assert.doesNotThrow(() =>
    validateRuntimeBoundary({ host: "100.64.0.10", allowRemote: true, token: "a".repeat(64), transport: "tunnel" })
  );
});

test("remote transport requires TLS or an explicitly trusted encrypted tunnel", () => {
  assert.equal(resolveRemoteTransport("", false), "local");
  assert.equal(resolveRemoteTransport("tls", true), "tls");
  assert.equal(resolveRemoteTransport("https", true), "tls");
  assert.equal(resolveRemoteTransport("tunnel", true), "tunnel");
  assert.equal(resolveRemoteTransport("vpn", true), "tunnel");
  assert.throws(() => resolveRemoteTransport("http", true), /MOBILE_REMOTE_TRANSPORT/);
  assert.throws(() => resolveRemoteTransport("", true), /MOBILE_REMOTE_TRANSPORT/);
});

test("TLS transport requires both certificate and private key paths", () => {
  assert.throws(() => validateTransportConfig({ mode: "tls", certFile: "", keyFile: "" }), /MOBILE_TLS_CERT_FILE/);
  const config = validateTransportConfig({ mode: "tls", certFile: "./cert.pem", keyFile: "./key.pem" });
  assert.equal(config.mode, "tls");
  assert.ok(config.certFile.endsWith("cert.pem"));
  assert.ok(config.keyFile.endsWith("key.pem"));
  assert.deepEqual(validateTransportConfig({ mode: "tunnel" }), { mode: "tunnel", certFile: "", keyFile: "" });
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

test("tunnel transport rejects wildcard binds that would leak plaintext to the LAN", () => {
  const token = "a".repeat(64);
  assert.throws(
    () => validateRuntimeBoundary({ host: "0.0.0.0", allowRemote: true, token, transport: "tunnel" }),
    /specific MOBILE_HOST/
  );
  assert.doesNotThrow(() =>
    validateRuntimeBoundary({ host: "100.64.0.10", allowRemote: true, token, transport: "tunnel" })
  );
  assert.doesNotThrow(() =>
    validateRuntimeBoundary({ host: "127.0.0.1", allowRemote: true, token, transport: "tunnel" })
  );
});

test("TLS transport may bind all interfaces because the application transport is encrypted", () => {
  assert.doesNotThrow(() =>
    validateRuntimeBoundary({
      host: "0.0.0.0",
      allowRemote: true,
      token: "a".repeat(64),
      transport: "tls",
      certFile: "./cert.pem",
      keyFile: "./key.pem",
    })
  );
});
