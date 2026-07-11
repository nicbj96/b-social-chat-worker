import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const expectedRemote = "https://github.com/nicbj96/b-social-chat-worker.git";
const self = "script/assert-repo-safety.mjs";

const forbiddenOwnership = [
  { label: "forbidden organization", pattern: /bbssocialnico-bit/i },
  { label: "forbidden account", pattern: /NikaQuant/i },
  { label: "obsolete loose Desktop worker path", pattern: /Desktop[\\/]b-social-chat-worker(?:[\\/]|\b)/i },
  { label: "obsolete frontend clone", pattern: /Desktop[\\/]b-social-repo(?:[\\/]|\b)/i },
];

const secretPatterns = [
  { label: "GitHub token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/g },
  { label: "Telegram bot token", pattern: /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/g },
  { label: "Stripe secret", pattern: /\b(?:sk_(?:live|test)|whsec_)[A-Za-z0-9]{16,}\b/g },
  { label: "OpenAI API key", pattern: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}\b/g },
  { label: "Supabase management token", pattern: /\bsbp_[A-Za-z0-9]{20,}\b/g },
  { label: "JWT-like secret", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}\b/g },
];

const binaryExtensions = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".ico", ".woff", ".woff2", ".ttf", ".pdf"]);
const findings = [];

const { stdout: remoteOut } = await execFileAsync("git", ["remote", "get-url", "origin"], { cwd: repoRoot });
const remote = remoteOut.trim();
if (remote !== expectedRemote) findings.push(`origin must be ${expectedRemote}; got ${remote || "<empty>"}`);

const { stdout: fileOut } = await execFileAsync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
  cwd: repoRoot,
  maxBuffer: 10 * 1024 * 1024,
});
const files = fileOut.split(/\r?\n/).filter(Boolean);

for (const file of files) {
  if (file === self || file.startsWith("node_modules/") || file.startsWith(".wrangler/") || file.startsWith("dist/")) continue;
  if (binaryExtensions.has(extname(file).toLowerCase())) continue;

  let content;
  try {
    content = await readFile(resolve(repoRoot, file), "utf8");
  } catch {
    continue;
  }

  for (const [index, line] of content.split(/\r?\n/).entries()) {
    for (const item of forbiddenOwnership) {
      if (item.pattern.test(line)) findings.push(`${file}:${index + 1} contains ${item.label}`);
    }
    for (const secret of secretPatterns) {
      secret.pattern.lastIndex = 0;
      if (secret.pattern.test(line)) findings.push(`${file}:${index + 1} contains ${secret.label}`);
    }
  }
}

const wrangler = await readFile(resolve(repoRoot, "wrangler.toml"), "utf8");
if (!/^name\s*=\s*"b-social-chat"\s*$/m.test(wrangler)) findings.push("wrangler.toml must deploy worker b-social-chat");
if (!/SUPABASE_URL\s*=\s*"https:\/\/rbengtfrthqdfbcdcugp\.supabase\.co"/.test(wrangler)) {
  findings.push("wrangler.toml must target Supabase project rbengtfrthqdfbcdcugp");
}
for (const required of [
  'name = "RATE_LIMITER"',
  'class_name = "RateLimitDurableObject"',
  'new_sqlite_classes = ["RateLimitDurableObject"]',
]) {
  if (!wrangler.includes(required)) findings.push(`wrangler.toml missing Durable Object rate-limit marker: ${required}`);
}

const workerSource = await readFile(resolve(repoRoot, "src/index.ts"), "utf8");
for (const required of [
  'import { enforceRateLimit',
  'export { RateLimitDurableObject }',
  'extends RateLimitEnv',
  'await enforceRateLimit(request, env, url.pathname, CORS_HEADERS)',
]) {
  if (!workerSource.includes(required)) findings.push(`src/index.ts missing rate-limit wiring: ${required}`);
}

const reference = await readFile(resolve(repoRoot, "CLAUDE.md"), "utf8");
for (const required of [
  "nicbj96/b-social-chat-worker",
  "b-social-chat-worker-nic-live",
  "b-social-chat.nicbj96.workers.dev",
  "rbengtfrthqdfbcdcugp",
  "npm run verify:local",
]) {
  if (!reference.includes(required)) findings.push(`CLAUDE.md missing canonical ownership marker: ${required}`);
}

if (findings.length) throw new Error(`Repository safety guard failed:\n- ${findings.join("\n- ")}`);
console.log("OK chat-worker repository safety guard");
