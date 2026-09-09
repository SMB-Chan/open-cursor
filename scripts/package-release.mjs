#!/usr/bin/env node
/**
 * Release gate + packager for Open-Cursor.
 *
 * Usage:
 *   node scripts/package-release.mjs --ref v2.11.0
 *   node scripts/package-release.mjs --check-only
 *
 * --check-only verifies version files agree in the working tree (CI gate).
 * --ref <git-ref> additionally archives that ref into dist/ after the same
 * version gate against the tree at that ref.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const VERSION_FILES = [
  { path: "server/package.json", kind: "json" },
  { path: "extension/package.json", kind: "json" },
  { path: "mobile/package.json", kind: "json" },
  { path: "server/engine.js", kind: "engine" },
];

export function parseArgs(argv) {
  const out = { ref: null, checkOnly: false, outDir: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--check-only") out.checkOnly = true;
    else if (arg === "--ref") {
      out.ref = argv[++i];
      if (!out.ref) throw new Error("--ref requires a git ref");
    } else if (arg === "--out-dir") {
      out.outDir = argv[++i];
      if (!out.outDir) throw new Error("--out-dir requires a path");
    } else if (arg === "--help" || arg === "-h") {
      out.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return out;
}

export function extractEngineVersion(source) {
  const match = source.match(/const VERSION = "([^"]+)"/);
  if (!match) throw new Error("server/engine.js is missing const VERSION");
  return match[1];
}

export function collectVersions(readFile) {
  const versions = {};
  for (const file of VERSION_FILES) {
    const raw = readFile(file.path);
    if (file.kind === "json") {
      const parsed = JSON.parse(raw);
      versions[file.path] = parsed.version;
    } else {
      versions[file.path] = extractEngineVersion(raw);
    }
  }
  return versions;
}

export function assertVersionsAgree(versions, expected) {
  const unique = [...new Set(Object.values(versions))];
  if (unique.length !== 1) {
    const detail = Object.entries(versions)
      .map(([path, version]) => `  ${path}: ${version}`)
      .join("\n");
    throw new Error(`Version files disagree:\n${detail}`);
  }
  const version = unique[0];
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Invalid semver: ${version}`);
  }
  if (expected && version !== expected) {
    throw new Error(`Expected version ${expected} but found ${version}`);
  }
  return version;
}

export function versionFromRef(ref) {
  if (!ref) return null;
  const match = String(ref).match(/^v(\d+\.\d+\.\d+)$/);
  return match ? match[1] : null;
}

function git(args, options = {}) {
  const result = spawnSync("git", args, {
    cwd: options.cwd || ROOT,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function readWorkingTree(path) {
  return readFileSync(join(ROOT, path), "utf8");
}

function readAtRef(ref, path) {
  return git(["show", `${ref}:${path}`]);
}

export function archiveName(version) {
  return `open-cursor-${version}.tar.gz`;
}

function packageRef(ref, outDir) {
  const destDir = resolve(outDir || join(ROOT, "dist"));
  mkdirSync(destDir, { recursive: true });

  const versions = collectVersions((path) => readAtRef(ref, path));
  const expected = versionFromRef(ref);
  const version = assertVersionsAgree(versions, expected);

  const archive = join(destDir, archiveName(version));
  if (existsSync(archive)) rmSync(archive);

  const prefix = `open-cursor-${version}/`;
  const result = spawnSync(
    "git",
    ["archive", "--format=tar.gz", `--prefix=${prefix}`, "-o", archive, ref],
    { cwd: ROOT, encoding: "utf8" }
  );
  if (result.status !== 0) {
    throw new Error(`git archive failed: ${result.stderr || result.stdout}`);
  }

  const digest = createHash("sha256").update(readFileSync(archive)).digest("hex");
  const checksumPath = `${archive}.sha256`;
  writeFileSync(checksumPath, `${digest}  ${archiveName(version)}\n`);

  const manifest = {
    version,
    ref,
    commit: git(["rev-parse", ref]).trim(),
    archive: archiveName(version),
    sha256: digest,
    versions,
  };
  writeFileSync(join(destDir, `open-cursor-${version}.manifest.json`), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(
      "Usage: node scripts/package-release.mjs [--check-only] [--ref <git-ref>] [--out-dir <dir>]\n"
    );
    return 0;
  }

  if (args.checkOnly || !args.ref) {
    const versions = collectVersions(readWorkingTree);
    const version = assertVersionsAgree(versions, null);
    process.stdout.write(`version-gate ok: ${version}\n`);
    if (!args.ref) return 0;
  }

  const manifest = packageRef(args.ref, args.outDir);
  process.stdout.write(
    `packaged ${manifest.archive} (${manifest.sha256.slice(0, 12)}…) from ${manifest.ref}\n`
  );
  return 0;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

export { main, packageRef, ROOT };
