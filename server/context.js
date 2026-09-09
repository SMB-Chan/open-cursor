import { spawn } from "node:child_process";
import { readFile, readdir, rm, stat, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join, relative, sep } from "node:path";

const DEFAULT_CONTEXT_MAX_FILES = 300;
const DEFAULT_CONTEXT_MAX_BYTES = 128 * 1024;
const DEFAULT_CONTEXT_FILE_BYTES = 12 * 1024;
const DEFAULT_DIFF_MAX_BYTES = 96 * 1024;
const MAX_REVIEW_PATHS = 250;

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".cache",
  ".idea",
  ".vscode",
  "node_modules",
  "vendor",
  ".venv",
  "venv",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  ".next",
  ".turbo",
]);

const SOURCE_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".css",
  ".go",
  ".h",
  ".hpp",
  ".html",
  ".java",
  ".js",
  ".jsx",
  ".json",
  ".kt",
  ".kts",
  ".md",
  ".mjs",
  ".mts",
  ".py",
  ".rb",
  ".rs",
  ".sh",
  ".sql",
  ".toml",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);

const ANCHOR_PATTERNS = [
  /^readme(?:\..+)?$/i,
  /^package\.json$/i,
  /^pyproject\.toml$/i,
  /^cargo\.toml$/i,
  /^go\.mod$/i,
  /^requirements(?:[-_.].*)?\.txt$/i,
  /^tsconfig(?:\..+)?\.json$/i,
  /^vite\.config\./i,
  /^next\.config\./i,
  /^dockerfile(?:\..+)?$/i,
  /^makefile$/i,
];

const SECRET_PATTERNS = [
  /^\.env(?:\..+)?$/i,
  /(?:^|[-_.])(secret|secrets|credential|credentials|token|tokens)(?:[-_.]|$)/i,
  /^(id_rsa|id_ed25519|id_ecdsa)$/i,
  /\.(pem|key|p12|pfx|jks|keystore)$/i,
];

function boundedInteger(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

function contextLimits(overrides = {}) {
  return {
    maxFiles: boundedInteger(
      overrides.maxFiles ?? process.env.BRIDGE_CONTEXT_MAX_FILES,
      DEFAULT_CONTEXT_MAX_FILES,
      10,
      5000
    ),
    maxBytes: boundedInteger(
      overrides.maxBytes ?? process.env.BRIDGE_CONTEXT_MAX_BYTES,
      DEFAULT_CONTEXT_MAX_BYTES,
      4096,
      2 * 1024 * 1024
    ),
    maxFileBytes: boundedInteger(
      overrides.maxFileBytes ?? process.env.BRIDGE_CONTEXT_FILE_BYTES,
      DEFAULT_CONTEXT_FILE_BYTES,
      1024,
      256 * 1024
    ),
  };
}

function isSecretPath(relativePath) {
  return String(relativePath || "")
    .split(/[\\/]/)
    .some((part) => SECRET_PATTERNS.some((pattern) => pattern.test(part)));
}

function isAnchor(relativePath) {
  const name = basename(relativePath);
  return ANCHOR_PATTERNS.some((pattern) => pattern.test(name));
}

function isContextSource(relativePath) {
  return isAnchor(relativePath) || SOURCE_EXTENSIONS.has(extname(relativePath).toLowerCase());
}

function hintTokens(hint) {
  return String(hint || "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}_.-]+/u)
    .filter((token) => token.length >= 3)
    .slice(0, 80);
}

function scoreContextFile(relativePath, hint) {
  let score = 0;
  if (isAnchor(relativePath)) score += 1000;

  const normalized = relativePath.toLowerCase();
  const fileName = basename(normalized);
  for (const token of hintTokens(hint)) {
    if (fileName.includes(token)) score += 300;
    else if (normalized.includes(token)) score += 100;
  }

  if (SOURCE_EXTENSIONS.has(extname(relativePath).toLowerCase())) score += 40;
  const depth = relativePath.split(/[\\/]/).length;
  score += Math.max(0, 20 - depth * 3);
  if (/(?:^|[\\/])(test|tests|spec|specs)(?:[\\/]|$)/i.test(relativePath)) score += 8;
  return score;
}

async function walkWorkspace(root, maxFiles) {
  const files = [];
  const queue = [root];
  let truncated = false;

  while (queue.length > 0) {
    const directory = queue.shift();
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;

      const absolutePath = join(directory, entry.name);
      const relativePath = relative(root, absolutePath).split(sep).join("/");
      if (!relativePath || isSecretPath(relativePath)) continue;

      if (entry.isDirectory()) {
        queue.push(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;

      files.push({ absolutePath, relativePath });
      if (files.length >= maxFiles) {
        truncated = queue.length > 0 || index < entries.length - 1;
        return { files, truncated };
      }
    }
  }

  return { files, truncated };
}

async function readTextFile(file, maxFileBytes) {
  let info;
  try {
    info = await stat(file.absolutePath);
  } catch {
    return null;
  }
  if (!info.isFile() || info.size > maxFileBytes) return null;

  let buffer;
  try {
    buffer = await readFile(file.absolutePath);
  } catch {
    return null;
  }
  if (buffer.includes(0)) return null;
  return buffer.toString("utf8");
}

function appendWithinBudget(parts, text, budget) {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > budget.remaining) return false;
  parts.push(text);
  budget.remaining -= bytes;
  return true;
}

async function buildWorkspaceContext(root, options = {}) {
  const limits = contextLimits(options);
  const { files, truncated } = await walkWorkspace(root, limits.maxFiles);
  const parts = [];
  const budget = { remaining: limits.maxBytes };

  appendWithinBudget(parts, "# Workspace map\n", budget);
  for (const file of files) {
    if (!appendWithinBudget(parts, `- ${file.relativePath}\n`, budget)) break;
  }
  if (truncated) appendWithinBudget(parts, "- … workspace map truncated …\n", budget);

  const candidates = files
    .filter((file) => isContextSource(file.relativePath))
    .map((file) => ({ ...file, score: scoreContextFile(file.relativePath, options.hint) }))
    .sort((a, b) => b.score - a.score || a.relativePath.localeCompare(b.relativePath));

  const includedFiles = [];
  if (budget.remaining > 1024) appendWithinBudget(parts, "\n# Selected file excerpts\n", budget);

  for (const file of candidates) {
    if (budget.remaining <= 512) break;
    const content = await readTextFile(file, limits.maxFileBytes);
    if (content === null) continue;

    const block = `\n## ${file.relativePath}\n\`\`\`\n${content}\n\`\`\`\n`;
    if (!appendWithinBudget(parts, block, budget)) continue;
    includedFiles.push(file.relativePath);
  }

  return {
    text: parts.join(""),
    listedFiles: files.map((file) => file.relativePath),
    includedFiles,
    truncated: truncated || budget.remaining <= 512,
    bytes: limits.maxBytes - budget.remaining,
  };
}

function captureCommand(command, args, { cwd, maxBytes, timeoutMs = 5000 } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let truncated = false;
    let settled = false;
    let timer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolvePromise(result);
    };

    const consume = (chunk, target) => {
      if (truncated) return;
      const buffer = Buffer.from(chunk);
      const available = Math.max(0, maxBytes - bytes);
      if (buffer.length > available) {
        const clipped = buffer.subarray(0, available).toString("utf8");
        if (target === "stdout") stdout += clipped;
        else stderr += clipped;
        bytes = maxBytes;
        truncated = true;
        child.kill("SIGTERM");
        return;
      }
      bytes += buffer.length;
      if (target === "stdout") stdout += buffer.toString("utf8");
      else stderr += buffer.toString("utf8");
    };

    child.stdout.on("data", (chunk) => consume(chunk, "stdout"));
    child.stderr.on("data", (chunk) => consume(chunk, "stderr"));
    child.once("error", () => finish({ stdout: "", stderr: "", code: null, truncated: false }));
    child.once("close", (code) => finish({ stdout, stderr, code, truncated }));

    timer = setTimeout(() => {
      truncated = true;
      child.kill("SIGTERM");
      finish({ stdout, stderr, code: null, truncated: true });
    }, timeoutMs);
    timer.unref?.();
  });
}

async function getGitHead(root) {
  const result = await captureCommand("git", ["rev-parse", "--verify", "HEAD"], {
    cwd: root,
    maxBytes: 256,
  });
  if (result.code !== 0) return null;
  const head = result.stdout.trim();
  return /^[0-9a-f]{40,64}$/i.test(head) ? head : null;
}

function parseNameOnly(output) {
  return output
    .split("\0")
    .map((path) => path.trim())
    .filter(Boolean);
}

async function changedPaths(root, baseRef) {
  const commands = baseRef
    ? [["diff", "--name-only", "-z", baseRef, "--"]]
    : [
        ["diff", "--name-only", "-z", "--"],
        ["diff", "--cached", "--name-only", "-z", "--"],
      ];

  const paths = new Set();
  let truncated = false;
  const IGNORED_DIFF_PATTERNS = [
    /package-lock\.json$/,
    /pnpm-lock\.yaml$/,
    /yarn\.lock$/,
    /Cargo\.lock$/,
    /\.min\.(js|css)$/,
    /\.map$/,
  ];

  for (const args of commands) {
    const result = await captureCommand("git", args, {
      cwd: root,
      maxBytes: 64 * 1024,
    });
    truncated ||= result.truncated;
    for (const path of parseNameOnly(result.stdout)) {
      if (!isSecretPath(path) && !IGNORED_DIFF_PATTERNS.some((re) => re.test(path))) {
        paths.add(path);
      }
    }
  }

  const files = [...paths].sort();
  if (files.length > MAX_REVIEW_PATHS) truncated = true;
  return { files: files.slice(0, MAX_REVIEW_PATHS), truncated };
}

function sanitizedStatus(statusText) {
  let omitted = false;
  const lines = statusText.split(/\r?\n/).filter(Boolean);
  const kept = lines.filter((line) => {
    const rawPath = line.length > 3 ? line.slice(3) : line;
    const paths = rawPath.split(" -> ").map((path) => path.replace(/^"|"$/g, ""));
    if (paths.some(isSecretPath)) {
      omitted = true;
      return false;
    }
    return true;
  });
  if (omitted) kept.push("!! [secret-like changed paths omitted from agent context]");
  return kept.join("\n");
}

async function buildGitReviewContext(root, options = {}) {
  const maxBytes = boundedInteger(
    options.maxBytes ?? process.env.BRIDGE_DIFF_MAX_BYTES,
    DEFAULT_DIFF_MAX_BYTES,
    4096,
    2 * 1024 * 1024
  );
  const statusBudget = Math.min(16 * 1024, Math.floor(maxBytes / 4));
  const diffBudget = maxBytes - statusBudget;

  const status = await captureCommand("git", ["status", "--short"], {
    cwd: root,
    maxBytes: statusBudget,
  });
  const paths = await changedPaths(root, options.baseRef);

  let diff = { stdout: "", truncated: paths.truncated };
  if (paths.files.length > 0) {
    if (options.baseRef) {
      diff = await captureCommand(
        "git",
        ["diff", options.baseRef, "--no-ext-diff", "--unified=3", "--", ...paths.files],
        { cwd: root, maxBytes: diffBudget }
      );
      diff.truncated ||= paths.truncated;
    } else {
      const unstagedBudget = Math.floor(diffBudget / 2);
      const unstaged = await captureCommand(
        "git",
        ["diff", "--no-ext-diff", "--unified=3", "--", ...paths.files],
        { cwd: root, maxBytes: unstagedBudget }
      );
      const staged = await captureCommand(
        "git",
        ["diff", "--cached", "--no-ext-diff", "--unified=3", "--", ...paths.files],
        { cwd: root, maxBytes: diffBudget - unstagedBudget }
      );
      diff = {
        stdout: [unstaged.stdout, staged.stdout].filter(Boolean).join("\n"),
        truncated: paths.truncated || unstaged.truncated || staged.truncated,
      };
    }
  }

  const sections = [];
  const safeStatus = sanitizedStatus(status.stdout);
  if (safeStatus.trim()) sections.push(`# Git status\n${safeStatus.trim()}`);
  if (diff.stdout.trim()) {
    sections.push(
      `# Changes${options.baseRef ? ` since ${options.baseRef.slice(0, 12)}` : ""}\n${diff.stdout.trim()}`
    );
  }
  if (diff.truncated) {
    sections.push("# Note\nGit change context was truncated to the configured review budget.");
  }

  return sections.join("\n\n") || "# Git review context\nNo non-secret Git changes were detected.";
}

async function withIsolatedDirectory(callback) {
  const directory = await mkdtemp(join(tmpdir(), "open-cursor-review-"));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export {
  buildGitReviewContext,
  buildWorkspaceContext,
  contextLimits,
  getGitHead,
  isSecretPath,
  scoreContextFile,
  withIsolatedDirectory,
};
