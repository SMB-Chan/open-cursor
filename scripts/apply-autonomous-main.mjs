import fs from "node:fs";

function replaceOrFail(text, from, to, label) {
  if (!text.includes(from)) throw new Error(`anchor not found: ${label}`);
  return text.replace(from, to);
}

function update(path, transform) {
  const before = fs.readFileSync(path, "utf8");
  const after = transform(before);
  if (after === before) throw new Error(`no change: ${path}`);
  fs.writeFileSync(path, after);
}

update("server/engine.js", (input) => {
  let text = input;
  text = replaceOrFail(
    text,
    'function runAntigravity(prompt, { cwd, model, signal, onChunk, home } = {}) {\n  const args = [`-p=${prompt}`, "--output-format", "text", "--dangerously-skip-permissions"];\n  const targetModel = mapAntigravityModel(model);\n  if (targetModel) args.push("--model", targetModel);\n\n  const actualCwd = cwd || process.cwd();',
    'function runAntigravity(prompt, { cwd, model, signal, onChunk, home } = {}) {\n  const actualCwd = cwd || process.cwd();\n  const args = [\n    `-p=${prompt}`,\n    "--output-format",\n    "text",\n    "--dangerously-skip-permissions",\n    "--mode",\n    "accept-edits",\n    "--add-dir",\n    actualCwd,\n  ];\n  const targetModel = mapAntigravityModel(model);\n  if (targetModel) args.push("--model", targetModel);',
    "autonomous antigravity flags"
  );

  const autonomousCase = `    case "autonomous": {\n      emitHeader(\n        onEvent,\n        \"> 🚀 **自律エージェントモード (Autonomous / Auto-Approve)**: 手動承認なしでファイルの読み書き・コマンド実行を開始します\\n\\n\",\n        "autonomous",\n        "start"\n      );\n      const actualCwd = cwd || process.cwd();\n      const result = await runAntigravity(\n        \\`You are an autonomous senior software engineer working in this repository at \\${actualCwd}.\\n\\` +\n        \\`Directly inspect files, edit code on disk, run test/build commands to verify your changes, and fix any errors autonomously without requesting manual user approvals.\\n\\n\\` +\n        \\`# Task:\\n\\${prompt}\\`,\n        {\n          cwd: actualCwd,\n          model: model || "pro",\n          signal,\n          onChunk: (text) => onEvent?.({ text, agent: "antigravity", phase: "execution" }),\n        }\n      );\n      return requireSuccessfulAgent(result);\n    }\n\n`;
  text = replaceOrFail(text, '    case "pipeline": {', autonomousCase + '    case "pipeline": {', "autonomous mode");
  return text;
});

update("server/index.js", (input) => {
  let text = input;
  text = replaceOrFail(text, '  "auto",\n]);', '  "auto",\n  "autonomous",\n]);', "routing mode");
  text = replaceOrFail(
    text,
    '  if (mode === "antigravity") return ["antigravity"];',
    '  if (mode === "antigravity") return ["antigravity"];\n  if (mode === "autonomous") return ["antigravity"];',
    "autonomous enabled gate"
  );
  const modelAnchor = `    {\n      id: "auto",\n      object: "model",\n      owned_by: "bridge",\n      description: "Auto (自動判別: プロンプト内容から Gemini / MiMo / 協調モードを最適自動選択)",\n    },`;
  text = replaceOrFail(
    text,
    modelAnchor,
    modelAnchor + `\n    {\n      id: "autonomous",\n      object: "model",\n      owned_by: "bridge",\n      description: "Autonomous Agent (explicit write mode: auto-approved file edits and commands)",\n    },`,
    "autonomous model"
  );
  return text;
});

update("extension/src/extension.js", (input) =>
  replaceOrFail(
    input,
    '      <option value="auto">Auto (自動判別)</option>',
    '      <option value="auto">Auto (自動判別)</option>\n      <option value="autonomous">Autonomous (承認なし全自動)</option>',
    "autonomous extension option"
  )
);
