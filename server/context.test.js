import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  buildGitReviewContext,
  buildUntrackedFileContext,
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

test("git review context includes bounded excerpts for untracked new files on request", async () => {
  await withTempDir(async (directory) => {
    await initRepo(directory);
    await writeFile(join(directory, "tracked.js"), "export const tracked = 1;\n");
    await writeFile(join(directory, "README.md"), "# Demo\nExisting tracked readme.\n");
    await run("git", ["add", "."], directory);
    await run("git", ["commit", "-m", "init"], directory);

    await writeFile(join(directory, "new-helper.js"), "export const helper = () => 42;\n");

    const withExcerpts = await buildGitReviewContext(directory, {
      baseRef: await getGitHead(directory),
      maxBytes: 16 * 1024,
      hint: "helper",
      includeUntracked: true,
    });

    assert.match(withExcerpts, /# Untracked files \(bounded excerpts\)/);
    assert.match(withExcerpts, /## new-helper\.js/);
    assert.match(withExcerpts, /export const helper/);
    // Tracked-but-unmodified files must not leak into the untracked section.
    assert.doesNotMatch(withExcerpts, /## README\.md/);

    const withoutExcerpts = await buildGitReviewContext(directory, {
      baseRef: await getGitHead(directory),
      maxBytes: 16 * 1024,
      hint: "helper",
    });
    assert.doesNotMatch(withoutExcerpts, /# Untracked files/);
    assert.doesNotMatch(withoutExcerpts, /export const helper/);
  });
});

test("untracked excerpts omit secret-like and gitignored files", async () => {
  await withTempDir(async (directory) => {
    await initRepo(directory);
    await writeFile(join(directory, ".gitignore"), "ignored.log\n.env.local\n");
    await writeFile(join(directory, "app.js"), "export const app = 1;\n");
    await run("git", ["add", "."], directory);
    await run("git", ["commit", "-m", "init"], directory);

    await writeFile(join(directory, "app.js"), "export const app = 2;\n");
    await writeFile(join(directory, "new-code.js"), "// brand new\n");
    await writeFile(join(directory, ".env.local"), "TOKEN=leaked\n");
    await writeFile(join(directory, "api-credentials.txt"), "user:password\n");
    await writeFile(join(directory, "ignored.log"), "noise\n");

    const context = await buildUntrackedFileContext(directory, {
      maxBytes: 8 * 1024,
      hint: "new-code",
    });

    assert.match(context.text, /## new-code\.js/);
    assert.equal(context.listedFiles.includes(".env.local"), false);
    assert.equal(context.listedFiles.includes("api-credentials.txt"), false);
    assert.equal(context.listedFiles.includes("ignored.log"), false);
    assert.doesNotMatch(context.text, /leaked/);
    assert.doesNotMatch(context.text, /user:password/);
  });
});

test("untracked excerpts clip oversized files and honor the byte budget", async () => {
  await withTempDir(async (directory) => {
    await initRepo(directory);
    await writeFile(join(directory, "big-new.js"), `// ${"x".repeat(4000)}\n`);
    await writeFile(join(directory, "small-new.js"), "// tiny\n");

    const clipped = await buildUntrackedFileContext(directory, {
      maxBytes: 16 * 1024,
      maxFileBytes: 1024,
      hint: "",
    });
    assert.match(clipped.text, /\[truncated\]/);

    const budgeted = await buildUntrackedFileContext(directory, {
      maxBytes: 1024,
      maxFileBytes: 4096,
      hint: "small",
    });
    assert.match(budgeted.text, /## small-new\.js/);
    assert.equal(budgeted.truncated, true);

    const disabled = await buildUntrackedFileContext(directory, { maxBytes: 0 });
    assert.equal(disabled.text, "");
    assert.deepEqual(disabled.includedFiles, []);
  });
});

test("untracked excerpt budget is bounded by the review maxBytes", async () => {
  await withTempDir(async (directory) => {
    await initRepo(directory);
    await writeFile(join(directory, "tracked.js"), "const a = 1;\n");
    await run("git", ["add", "."], directory);
    await run("git", ["commit", "-m", "init"], directory);
    await writeFile(join(directory, "big-new.js"), `// ${"x".repeat(9000)}\n`);

    const context = await buildGitReviewContext(directory, {
      baseRef: await getGitHead(directory),
      maxBytes: 4096,
      includeUntracked: true,
    });

    // The whole review context must stay within the caller's budget even with
    // excerpts enabled: at most a small slack for section framing.
    assert.ok(
      Buffer.byteLength(context, "utf8") <= 4096 + 512,
      `context exceeded budget: ${Buffer.byteLength(context, "utf8")} bytes`
    );
  });
});
