import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  buildGitReviewContext,
  buildWorkspaceContext,
  isSecretPath,
  withIsolatedDirectory,
} from "./context.js";

async function withTempDir(callback) {
  const directory = await mkdtemp(join(tmpdir(), "open-cursor-context-test-"));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function run(command, args, cwd) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", rejectPromise);
    child.once("close", (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`${command} exited ${code}: ${stderr}`));
    });
  });
}

test("secret-like paths are excluded from workspace context", async () => {
  assert.equal(isSecretPath(".env"), true);
  assert.equal(isSecretPath("config/credentials.json"), true);
  assert.equal(isSecretPath("certs/private.key"), true);
  assert.equal(isSecretPath("src/tokenizer.js"), false);

  await withTempDir(async (directory) => {
    await mkdir(join(directory, "src"));
    await writeFile(join(directory, "README.md"), "# Demo\n");
    await writeFile(join(directory, ".env"), "SECRET=do-not-copy\n");
    await writeFile(join(directory, "src", "tokenizer.js"), "export const ok = true;\n");

    const context = await buildWorkspaceContext(directory, {
      maxFiles: 50,
      maxBytes: 16 * 1024,
      hint: "tokenizer",
    });

    assert.match(context.text, /README\.md/);
    assert.match(context.text, /src\/tokenizer\.js/);
    assert.doesNotMatch(context.text, /do-not-copy/);
    assert.equal(context.listedFiles.includes(".env"), false);
  });
});

test("workspace context obeys its byte budget", async () => {
  await withTempDir(async (directory) => {
    await writeFile(join(directory, "README.md"), "A".repeat(3000));
    for (let index = 0; index < 20; index += 1) {
      await writeFile(join(directory, `file-${index}.js`), `// ${"x".repeat(500)}\n`);
    }

    const context = await buildWorkspaceContext(directory, {
      maxFiles: 50,
      maxBytes: 4096,
      maxFileBytes: 4096,
    });

    assert.ok(Buffer.byteLength(context.text, "utf8") <= 4096);
    assert.ok(context.listedFiles.length <= 50);
  });
});

test("git review context captures workspace changes", async () => {
  await withTempDir(async (directory) => {
    await run("git", ["init"], directory);
    await run("git", ["config", "user.email", "test@example.invalid"], directory);
    await run("git", ["config", "user.name", "Open Cursor Test"], directory);
    await writeFile(join(directory, "sample.txt"), "before\n");
    await run("git", ["add", "sample.txt"], directory);
    await run("git", ["commit", "-m", "base"], directory);
    await writeFile(join(directory, "sample.txt"), "after\n");

    const review = await buildGitReviewContext(directory, { maxBytes: 16 * 1024 });
    assert.match(review, /sample\.txt/);
    assert.match(review, /-before/);
    assert.match(review, /\+after/);
  });
});

test("isolated reviewer directory is removed after use", async () => {
  let isolatedPath;
  const value = await withIsolatedDirectory(async (directory) => {
    isolatedPath = directory;
    await writeFile(join(directory, "marker.txt"), "temporary");
    return 42;
  });

  assert.equal(value, 42);
  await assert.rejects(access(isolatedPath));
});
