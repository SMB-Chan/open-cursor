#!/usr/bin/env node
import { readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

function fail(message) {
  console.error(`[open-cursor] ${message}`);
  process.exitCode = 1;
}

async function main() {
  const [extensionsJson, extensionPath] = process.argv.slice(2);
  if (!extensionsJson || !extensionPath) {
    throw new Error("usage: register-extension.mjs <extensions.json> <extension-path>");
  }

  const manifestPath = join(extensionPath, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!manifest.publisher || !manifest.name || !manifest.version) {
    throw new Error("extension package.json must include publisher, name, and version");
  }

  const extensionId = `${manifest.publisher}.${manifest.name}`;
  const relativeLocation = `${extensionId}-${manifest.version}`;

  let entries;
  try {
    entries = JSON.parse(await readFile(extensionsJson, "utf8"));
  } catch (error) {
    throw new Error(`failed to read ${extensionsJson}: ${error.message}`);
  }
  if (!Array.isArray(entries)) {
    throw new Error(`${extensionsJson} must contain a JSON array`);
  }

  const preserved = entries.filter((entry) => entry?.identifier?.id !== extensionId);
  preserved.push({
    identifier: { id: extensionId },
    version: manifest.version,
    location: { $mid: 1, path: extensionPath, scheme: "file" },
    relativeLocation,
    metadata: {
      installedTimestamp: Date.now(),
      pinned: true,
    },
  });

  const directory = dirname(extensionsJson);
  const tempPath = join(directory, `.${basename(extensionsJson)}.open-cursor-${process.pid}.tmp`);
  await writeFile(tempPath, `${JSON.stringify(preserved, null, 2)}\n`, { mode: 0o600 });
  await rename(tempPath, extensionsJson);

  process.stdout.write(
    JSON.stringify({ id: extensionId, version: manifest.version, relativeLocation })
  );
}

main().catch((error) => fail(error.message));
