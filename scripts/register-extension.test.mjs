import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./register-extension.mjs", import.meta.url));

function runNode(args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", rejectPromise);
    child.once("close", (code) => {
      if (code === 0) resolvePromise(stdout);
      else rejectPromise(new Error(`registrar exited ${code}: ${stderr}`));
    });
  });
}

async function withTempDir(callback) {
  const directory = await mkdtemp(join(tmpdir(), "open-cursor-register-test-"));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("registrar replaces stale Open-Cursor entry while preserving unrelated extensions", async () => {
  await withTempDir(async (directory) => {
    const extensionPath = join(directory, "extension");
    const extensionsJson = join(directory, "extensions.json");
    await mkdir(extensionPath);
    await writeFile(
      join(extensionPath, "package.json"),
      JSON.stringify({ publisher: "open-cursor", name: "open-cursor-bridge", version: "9.8.7" })
    );
    await writeFile(
      extensionsJson,
      JSON.stringify([
        { identifier: { id: "vendor.keep-me" }, version: "1.0.0" },
        { identifier: { id: "open-cursor.open-cursor-bridge" }, version: "2.2.0" },
      ])
    );

    const result = JSON.parse(await runNode([extensionsJson, extensionPath]));
    const entries = JSON.parse(await readFile(extensionsJson, "utf8"));

    assert.equal(result.id, "open-cursor.open-cursor-bridge");
    assert.equal(result.version, "9.8.7");
    assert.equal(entries.filter((entry) => entry.identifier.id === result.id).length, 1);
    assert.equal(entries.find((entry) => entry.identifier.id === result.id).version, "9.8.7");
    assert.equal(entries.find((entry) => entry.identifier.id === result.id).metadata.pinned, true);
    assert.ok(entries.some((entry) => entry.identifier.id === "vendor.keep-me"));
  });
});

test("registrar is idempotent across repeated upgrades", async () => {
  await withTempDir(async (directory) => {
    const extensionPath = join(directory, "extension");
    const extensionsJson = join(directory, "extensions.json");
    await mkdir(extensionPath);
    await writeFile(
      join(extensionPath, "package.json"),
      JSON.stringify({ publisher: "open-cursor", name: "open-cursor-bridge", version: "3.0.0" })
    );
    await writeFile(extensionsJson, "[]\n");

    await runNode([extensionsJson, extensionPath]);
    await runNode([extensionsJson, extensionPath]);

    const entries = JSON.parse(await readFile(extensionsJson, "utf8"));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].relativeLocation, "open-cursor.open-cursor-bridge-3.0.0");
  });
});
