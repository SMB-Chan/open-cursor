import { readFile, writeFile, stat, readdir, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { homedir } from "node:os";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export const STATE_DIR = join(homedir(), ".cursor-codex-bridge", "run");
export const STATE_FILE = join(STATE_DIR, "execution-state.json");

let inMemoryState = {
  active: false,
  agent: null,
  mode: "idle",
  step: 0,
  progress: 0,
  currentAction: "待機中 (アイドル)",
  targetFile: null,
  recentSteps: [],
  startedAt: null,
  lastUpdatedAt: Date.now(),
};

export function updateExecutionState(patch = {}) {
  const previous = inMemoryState;
  inMemoryState = {
    ...previous,
    ...patch,
    lastUpdatedAt: Date.now(),
  };

  if (patch.newStep) {
    const steps = [patch.newStep, ...(previous.recentSteps || [])].slice(0, 15);
    inMemoryState.recentSteps = steps;
  }

  saveState().catch(() => {});
  return inMemoryState;
}

export function getExecutionState() {
  return { ...inMemoryState };
}

export async function saveState() {
  try {
    if (!existsSync(STATE_DIR)) {
      await mkdir(STATE_DIR, { recursive: true });
    }
    await writeFile(STATE_FILE, JSON.stringify(inMemoryState, null, 2), "utf8");
  } catch {}
}

export async function loadState() {
  try {
    if (existsSync(STATE_FILE)) {
      const raw = await readFile(STATE_FILE, "utf8");
      const data = JSON.parse(raw);
      inMemoryState = { ...inMemoryState, ...data };
    }
  } catch {}
  return inMemoryState;
}

export async function getLLMStatus() {
  return {
    codex: {
      name: "OpenAI Codex",
      provider: "OpenAI",
      planType: "ChatGPT Plus / Team / Pro サブスクリプション",
      billing: "定額サブスク（追加課金なし）",
      authMode: "ChatGPT Auth (OAuth Token)",
      status: "READY",
      quota: {
        type: "定額枠 (Plus/Pro)",
        limit: "ChatGPT 利用枠に準拠 (従量課金ゼロ)",
        resetInfo: "3時間サイクルで枠自動回復",
        rateLimitStatus: "正常稼働中 (OK)",
      },
      models: ["gpt-6-astra", "o3-mini", "codex"],
    },
    antigravity: {
      name: "Google Gemini",
      provider: "Google DeepMind / Gemini",
      planType: "Google One AI Pro サブスクリプション",
      billing: "定額サブスク（追加課金なし）",
      authMode: "Google Account (Antigravity CLI)",
      status: "READY",
      quota: {
        type: "定額枠 (AI Pro / Advanced)",
        limit: "Antigravity 高速クォータ内 (従量課金ゼロ)",
        resetInfo: "日次/時間枠自動リセット",
        rateLimitStatus: "正常稼働中 (OK)",
      },
      models: ["Gemini 3.1 Pro (High)", "Gemini 3.8 Flash (High)"],
    },
    mimo: {
      name: "Xiaomi MiMo",
      provider: "Xiaomi Token Plan",
      planType: "MiMo Token Plan API",
      billing: "トークンプラン (API Key)",
      authMode: "API Key (continue/.env)",
      status: "READY",
      quota: {
        type: "トークンプラン残高",
        limit: "APIトークン残量準拠",
        rateLimitStatus: "接続正常 (OK)",
      },
      models: ["mimo-v2.5-pro"],
    },
  };
}

export async function getWorkspaceStatus(workspacePath) {
  const targetDir = workspacePath || process.env.OPEN_CURSOR_WORKSPACE || process.cwd();
  const info = {
    workspacePath: targetDir,
    workspaceName: basename(targetDir),
    isGitRepo: false,
    gitBranch: null,
    modifiedFiles: [],
    recentFiles: [],
  };

  // 1. Git status if available
  try {
    const { stdout: branch } = await execAsync("git rev-parse --abbrev-ref HEAD", { cwd: targetDir });
    info.isGitRepo = true;
    info.gitBranch = branch.trim();

    const { stdout: status } = await execAsync("git status --porcelain", { cwd: targetDir });
    const lines = status.split("\n").filter((l) => l.trim().length > 0);
    info.modifiedFiles = lines.map((line) => {
      const statusCode = line.slice(0, 2).trim();
      const filePath = line.slice(3).trim();
      return {
        file: filePath,
        status: statusCode,
        fullPath: resolve(targetDir, filePath),
      };
    });
  } catch {
    info.isGitRepo = false;
  }

  // 2. Scan recent files in workspace (essential for non-git folders like ~/ドキュメント/DEMO)
  try {
    const entries = await readdir(targetDir, { withFileTypes: true });
    const fileStats = [];
    for (const entry of entries) {
      if (entry.isFile() && !entry.name.startsWith(".")) {
        const full = join(targetDir, entry.name);
        try {
          const s = await stat(full);
          fileStats.push({
            name: entry.name,
            fullPath: full,
            sizeBytes: s.size,
            mtimeMs: s.mtimeMs,
            mtime: s.mtime.toISOString(),
          });
        } catch {}
      }
    }
    fileStats.sort((a, b) => b.mtimeMs - a.mtimeMs);
    info.recentFiles = fileStats.slice(0, 10);
  } catch {}

  return info;
}

export async function getMonitorData(workspacePath) {
  const [llm, workspace, execution] = await Promise.all([
    getLLMStatus(),
    getWorkspaceStatus(workspacePath),
    Promise.resolve(getExecutionState()),
  ]);

  return {
    timestamp: new Date().toISOString(),
    llm,
    workspace,
    execution,
  };
}
