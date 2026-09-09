import assert from "node:assert/strict";
import test from "node:test";
import {
  archiveName,
  assertVersionsAgree,
  collectVersions,
  extractEngineVersion,
  parseArgs,
  versionFromRef,
} from "./package-release.mjs";

test("parseArgs requires --ref value", () => {
  assert.throws(() => parseArgs(["--ref"]), /--ref requires/);
  assert.deepEqual(parseArgs(["--ref", "v2.11.0", "--check-only"]), {
    ref: "v2.11.0",
    checkOnly: true,
    outDir: null,
  });
});

test("extractEngineVersion reads the engine constant", () => {
  assert.equal(extractEngineVersion('const VERSION = "2.11.0";\n'), "2.11.0");
  assert.throws(() => extractEngineVersion("export const X = 1"), /missing const VERSION/);
});

test("assertVersionsAgree rejects mixed versions", () => {
  assert.throws(
    () =>
      assertVersionsAgree({
        "server/package.json": "2.11.0",
        "extension/package.json": "2.8.0",
      }),
    /disagree/
  );
  assert.equal(
    assertVersionsAgree({
      a: "2.11.0",
      b: "2.11.0",
    }),
    "2.11.0"
  );
  assert.throws(
    () => assertVersionsAgree({ a: "2.11.0" }, "2.8.0"),
    /Expected version 2.8.0/
  );
});

test("versionFromRef only accepts vMAJOR.MINOR.PATCH", () => {
  assert.equal(versionFromRef("v2.11.0"), "2.11.0");
  assert.equal(versionFromRef("main"), null);
  assert.equal(versionFromRef("v2.11"), null);
});

test("collectVersions reads json and engine sources", () => {
  const files = {
    "server/package.json": JSON.stringify({ version: "2.11.0" }),
    "extension/package.json": JSON.stringify({ version: "2.11.0" }),
    "mobile/package.json": JSON.stringify({ version: "2.11.0" }),
    "server/engine.js": 'const VERSION = "2.11.0";\n',
  };
  const versions = collectVersions((path) => files[path]);
  assert.equal(assertVersionsAgree(versions), "2.11.0");
});

test("archiveName is deterministic", () => {
  assert.equal(archiveName("2.11.0"), "open-cursor-2.11.0.tar.gz");
});
