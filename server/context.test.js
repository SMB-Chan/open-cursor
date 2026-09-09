import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  buildGitReviewContext,
  buildWorkspaceContext,
  getGitHead,
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

async function initRepo(directory) {
  await run("git", ["init"], directory);
  await run("git", ["config", "user.email", "test@example.invalid"], directory);
  await run("git", ["config", "user.name", "Open Cursor Test"], directory);
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

test("git review context follows a baseline across later commits", async () => {
  await withTempDir(async (directory) => {
    await initRepo(directory);
    await writeFile(join(directory, "sample.txt"), "before\n");
    await run("git", ["add", "sample.txt"], directory);
    await run("git", ["commit", "-m", "base"], directory);
    const baseline = await getGitHead(directory);

    await writeFile(join(directory, "sample.txt"), "after\n");
    await run("git", ["add", "sample.txt"], directory);
    await run("git", ["commit", "-m", "agent commit"], directory);

    const review = await buildGitReviewContext(directory, {
      baseRef: baseline,
      maxBytes: 16 * 1024,
    });
    assert.match(review, /sample\.txt/);
    assert.match(review, /-before/);
    assert.match(review, /\+after/);
  });
});

test("git review context omits secret-like file contents", async () => {
  await withTempDir(async (directory) => {
    await initRepo(directory);
    await writeFile(join(directory, "sample.txt"), "before\n");
    await writeFile(join(directory, ".env"), "SECRET=before\n");
    await run("git", ["add", "sample.txt", ".env"], directory);
    await run("git", ["commit", "-m", "base"], directory);
    const baseline = await getGitHead(directory);

    await writeFile(join(directory, "sample.txt"), "after\n");
    await writeFile(join(directory, ".env"), "SECRET=after-super-sensitive\n");

    const review = await buildGitReviewContext(directory, {
      baseRef: baseline,
      maxBytes: 16 * 1024,
    });
    assert.match(review, /sample\.txt/);
    assert.match(review, /secret-like changed paths omitted/i);
    assert.doesNotMatch(review, /after-super-sensitive/);
    assert.doesNotMatch(review, /\.env/);
  });
});

test("git review context preserves whitespace in changed filenames", async () => {
  await withTempDir(async (directory) => {
    await initRepo(directory);
    const name = " spaced file.txt ";
    await writeFile(join(directory, name), "before-spaces\n");
    await run("git", ["add", "--", name], directory);
    await run("git", ["commit", "-m", "base"], directory);
    const baseline = await getGitHead(directory);
    await writeFile(join(directory, name), "after-spaces\n");

    for (const baseRef of [baseline, undefined]) {
      const review = await buildGitReviewContext(directory, { baseRef });
      assert.match(review, /-before-spaces/);
      assert.match(review, /\+after-spaces/);
    }
  });
});

test("git review treats wildcard filenames literally without including omitted paths", async () => {
  await withTempDir(async (directory) => {
    await initRepo(directory);
    await writeFile(join(directory, "*.txt"), "before-literal\n");
    await writeFile(join(directory, "secrets.txt"), "before-private\n");
    await run("git", ["add", "."], directory);
    await run("git", ["commit", "-m", "base"], directory);
    const baseline = await getGitHead(directory);
    await writeFile(join(directory, "*.txt"), "after-literal\n");
    await writeFile(join(directory, "secrets.txt"), "after-private\n");

    for (const staged of [false, true]) {
      if (staged) await run("git", ["add", "."], directory);
      for (const baseRef of [baseline, undefined]) {
        const review = await buildGitReviewContext(directory, { baseRef });
        assert.match(review, /-before-literal/);
        assert.match(review, /\+after-literal/);
        assert.doesNotMatch(review, /before-private|after-private|secrets\.txt/);
      }
    }
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
