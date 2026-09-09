import fs from "node:fs";

function replaceOrFail(text, from, to, label) {
  if (!text.includes(from)) throw new Error(`mobile finisher anchor not found: ${label}`);
  return text.replace(from, to);
}

const readmePath = "README.md";
let readme = fs.readFileSync(readmePath, "utf8");
const marker = "Legacy shell-managed bridge stop:";
const section = `### Mobile dashboard security

The mobile dashboard is **localhost-only by default**. Starting Open-Cursor no longer exposes execution APIs to the LAN automatically.

To opt in to phone/tablet access on a trusted LAN:

\`\`\`bash
MOBILE_ALLOW_REMOTE=1 ~/.cursor-codex-bridge/bin/open-cursor
\`\`\`

The launcher creates a 256-bit pairing token in \`~/.cursor-codex-bridge/mobile.token\` with mode \`0600\` and prints a pairing URL using \`#token=...\`. URL fragments are not sent in HTTP requests; the browser moves the token into session storage and sends it only in a Bearer authorization header.

Arbitrary remote shell execution is a separate high-trust opt-in and remains disabled by default:

\`\`\`bash
MOBILE_ALLOW_REMOTE=1 MOBILE_ALLOW_EXEC=1 ~/.cursor-codex-bridge/bin/open-cursor
\`\`\`

The dashboard uses plain HTTP. LAN mode should only be used on a trusted network or through an encrypted tunnel/VPN, and port 9880 must not be forwarded directly to the public Internet.

`;
if (!readme.includes("### Mobile dashboard security")) {
  readme = replaceOrFail(readme, marker, section + marker, "README mobile security marker");
}
fs.writeFileSync(readmePath, readme);

const ciPath = ".github/workflows/ci.yml";
let ci = fs.readFileSync(ciPath, "utf8");
if (!ci.includes("Test mobile dashboard security")) {
  ci = replaceOrFail(
    ci,
    `      - name: Check extension source\n        working-directory: extension\n        run: npm run check`,
    `      - name: Check mobile dashboard\n        working-directory: mobile\n        run: npm run check\n\n      - name: Test mobile dashboard security\n        working-directory: mobile\n        run: npm test\n\n      - name: Check extension source\n        working-directory: extension\n        run: npm run check`,
    "mobile CI"
  );
}
fs.writeFileSync(ciPath, ci);
