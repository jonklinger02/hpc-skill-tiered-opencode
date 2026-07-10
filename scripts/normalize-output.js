#!/usr/bin/env node
/**
 * normalize-output.js
 *
 * Post-processes a worker output file so it conforms to the project
 * convention: a per-file YAML manifest at the top of the file, written as
 * language-appropriate line comments so the file remains valid source, then
 * the file body. Runs between the worker (subagent.js execution phase) and
 * the schema validator. Idempotent: a file that already carries the manifest
 * header in the expected style is returned unchanged.
 *
 * Two failure modes addressed:
 *   1. Worker emitted chat-style prose around the file content (e.g.
 *      "I need to implement..."). We recover by extracting the largest
 *      fenced code block.
 *   2. Worker produced clean code but no manifest header. We prepend one
 *      built from the task spec, commented for the target language.
 *
 * Always exits 0 — normalization is best-effort. The validator is the
 * authoritative gate for whether the output is acceptable.
 *
 * Usage:
 *   node normalize-output.js --output-file <path> --task-file <path> [--worker-model <id>]
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { resolveModel } = require("./lib/models.js");

const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--output-file") args.outputFile = argv[++i];
  else if (argv[i] === "--task-file") args.taskFile = argv[++i];
  else if (argv[i] === "--worker-model") args.workerModel = argv[++i];
}

if (!args.outputFile || !args.taskFile) {
  console.log("err:missing required args (--output-file --task-file)");
  process.exit(0);
}

if (!fs.existsSync(args.outputFile)) {
  console.log(`skip:output_file_missing ${args.outputFile}`);
  process.exit(0);
}

if (!fs.existsSync(args.taskFile)) {
  console.log(`skip:task_file_missing ${args.taskFile}`);
  process.exit(0);
}

// ── Comment-style table ────────────────────────────────────────────────────
//
// Each entry returns one of:
//   { kind: "line", prefix: "#" | "//" | "--" }   — manifest rendered with
//     each row prefixed by the language's line-comment token
//   { kind: "block", open, close }                — wrap the whole manifest
//     in a single block comment (HTML/XML/SVG-style files)
//   { kind: "raw" }                               — markdown-only, where the
//     YAML doc-start `---` IS the canonical header form
//
// For .yaml/.yml output files we use "line" with `#` so the manifest doesn't
// collide with the file's own document content.
//
// KEEP IN SYNC with commentPrefixFor() in subagent.js — this script has no
// main-guard (requiring it runs the CLI), so subagent.js duplicates the table.
function commentStyleFor(filePath) {
  if (!filePath) return { kind: "line", prefix: "#" };
  const ext = path.extname(filePath).toLowerCase();
  const base = path.basename(filePath).toLowerCase();

  if (ext === ".md" || ext === ".mdx" || ext === ".markdown") {
    return { kind: "raw" };
  }
  if (ext === ".html" || ext === ".htm" || ext === ".xml" || ext === ".svg" || ext === ".vue") {
    return { kind: "block", open: "<!--", close: "-->" };
  }

  const hash = new Set([
    ".py", ".sh", ".bash", ".zsh", ".fish", ".yaml", ".yml", ".toml",
    ".rb", ".pl", ".r", ".dockerfile", ".env", ".ini", ".conf", ".cfg",
    ".gitignore", ".gitattributes", ".tf", ".hcl",
  ]);
  const slash = new Set([
    ".rs", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".go", ".java",
    ".c", ".cc", ".cpp", ".h", ".hpp", ".cs", ".kt", ".kts", ".swift",
    ".scala", ".php", ".dart", ".proto", ".gradle", ".groovy", ".css",
    ".scss", ".sass", ".less",
    // .prisma uses // line comments — a `#` frontmatter block is a SYNTAX ERROR
    // that breaks `prisma validate`/`migrate`/`generate`.
    ".prisma",
  ]);
  const dash = new Set([".sql", ".lua", ".hs", ".elm", ".ada"]);

  if (hash.has(ext)) return { kind: "line", prefix: "#" };
  if (slash.has(ext)) return { kind: "line", prefix: "//" };
  if (dash.has(ext)) return { kind: "line", prefix: "--" };
  if (base === "dockerfile" || base === "makefile" || base === "rakefile" || base.startsWith(".env")) {
    return { kind: "line", prefix: "#" };
  }
  // Unknown extension — `#` is the most permissive default (line comment in
  // many config formats; visually inert in others).
  return { kind: "line", prefix: "#" };
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── Parse task spec for manifest fields ───────────────────────────────────
const spec = fs.readFileSync(args.taskFile, "utf-8");
const get = (k) => {
  const m = spec.match(new RegExp(`^${k}:\\s*"?([^"\\n]+)"?\\s*$`, "m"));
  return m ? m[1].trim().replace(/^"|"$/g, "") : null;
};
const list = (key) => {
  const re = new RegExp(`^${key}:\\s*(?:\\[\\]|\\n((?:\\s{2,}-\\s*[A-Z0-9_-]+\\n?)+))`, "m");
  const m = spec.match(re);
  if (!m || !m[1]) return [];
  return m[1].split("\n").map(l => l.replace(/^\s*-\s*/, "").trim()).filter(Boolean);
};

const meta = {
  task_id: get("task_id"),
  group_id: get("group_id"),
  epic_id: get("epic_id"),
  file_path: get("file_path"),
  artifact_type: get("artifact_type"),
  contracts_implemented: list("contracts_produced"),
  contracts_consumed: list("contracts_consumed"),
  depends_on: list("depends_on"),
};

if (!meta.task_id || !meta.file_path) {
  console.log(`skip:incomplete_task_spec task=${meta.task_id || "?"} fp=${meta.file_path || "?"}`);
  process.exit(0);
}

// ── Salvage heuristics ─────────────────────────────────────────────────────
//
// The cleanWorkerOutput() in subagent.js already strips fences/prose/leaked
// frontmatter on the worker side before write. This script's salvage path is
// a defense-in-depth backup: if a worker output still arrived chat-corrupted
// (e.g. cleanWorkerOutput's heuristics missed an unusual opener), we extract
// the largest fenced code block.
const CHAT_RX = /^(I need|I will|I'll|Here is|Here's|Let me|To implement|This file|Looking at|Based on|I'm|Now let me|First|Step|I have|Now I|Now,|Looking|## |Given|I [a-z]+ to)/;

function extractLargestFencedBlock(content) {
  const blocks = [];
  const fence = /```([a-zA-Z0-9_+-]*)\n([\s\S]*?)\n```/g;
  let m;
  while ((m = fence.exec(content)) !== null) {
    blocks.push({ lang: m[1].toLowerCase(), body: m[2] });
  }
  if (blocks.length === 0) return null;
  return blocks.reduce((a, b) => b.body.length > a.body.length ? b : a);
}

// ── Manifest rendering & detection ────────────────────────────────────────

function buildManifestRows(meta, body, model) {
  const checksum = crypto.createHash("sha256").update(body).digest("hex");
  const rows = [];
  rows.push(`task_id: ${meta.task_id}`);
  if (meta.group_id) rows.push(`group_id: ${meta.group_id}`);
  if (meta.epic_id) rows.push(`epic_id: ${meta.epic_id}`);
  rows.push(`file_path: ${meta.file_path}`);
  if (meta.artifact_type) rows.push(`artifact_type: "${meta.artifact_type}"`);
  if (meta.contracts_implemented.length === 0) rows.push("contracts_produced: []");
  else { rows.push("contracts_produced:"); for (const c of meta.contracts_implemented) rows.push(`  - ${c}`); }
  if (meta.contracts_consumed.length === 0) rows.push("contracts_consumed: []");
  else { rows.push("contracts_consumed:"); for (const c of meta.contracts_consumed) rows.push(`  - ${c}`); }
  if (!meta.depends_on || meta.depends_on.length === 0) rows.push("depends_on: []");
  else { rows.push("depends_on:"); for (const d of meta.depends_on) rows.push(`  - ${d}`); }
  rows.push(`generated_by: "${model ? resolveModel(model) : "unknown"}"`);
  rows.push(`generated_at: "${new Date().toISOString()}"`);
  rows.push(`auto_normalized: true`);
  rows.push(`checksum: ${checksum}`);
  return rows;
}

// Render the manifest in the target language's comment style. Always opens
// with `---` and closes with `---` (after the comment prefix) so the manifest
// is greppable across all comment styles.
function renderManifest(meta, body, model, style) {
  const rows = buildManifestRows(meta, body, model);
  if (style.kind === "raw") {
    return ["---", ...rows, "---"].join("\n");
  }
  if (style.kind === "block") {
    return [style.open, "---", ...rows, "---", style.close].join("\n");
  }
  const p = style.prefix;
  return [`${p} ---`, ...rows.map(r => `${p} ${r}`), `${p} ---`].join("\n");
}

// Detect whether the file already carries a manifest header in the expected
// style. Allow an optional shebang first line, then look for the opener at
// the first non-blank line, then a `task_id:` row within the next 30 lines.
// The task_id check disambiguates a legitimate YAML doc-start (a `.yaml`
// output that begins `---`) from our manifest block.
function hasManifest(content, style) {
  const lines = content.split("\n");
  let i = 0;
  if (lines[0]?.startsWith("#!")) i = 1;
  while (i < lines.length && !lines[i].trim()) i++;
  if (i >= lines.length) return false;

  const window = lines.slice(i, i + 30);

  if (style.kind === "raw") {
    if (window[0].trim() !== "---") return false;
    return window.some(l => /^task_id:\s*\S/.test(l));
  }

  if (style.kind === "block") {
    if (window[0].trim() !== style.open) return false;
    return window.some(l => /^\s*task_id:\s*\S/.test(l));
  }

  // line
  const opener = `${style.prefix} ---`;
  if (window[0].trim() !== opener) return false;
  const taskRx = new RegExp(`^\\s*${escapeRegex(style.prefix)}\\s*task_id:\\s*\\S`);
  return window.some(l => taskRx.test(l));
}

// ── Main ───────────────────────────────────────────────────────────────────

let content = fs.readFileSync(args.outputFile, "utf-8");

// JSON has no comment syntax — it must NEVER carry a manifest/frontmatter
// header (that's what makes package.json fail npm with EJSONPARSE). Strip any
// leading comment lines (#/// blocks) before the first `{`/`[` and leave pure
// JSON; never attach a header.
if (/\.json$/i.test(meta.file_path || args.outputFile)) {
  // Drop leading blank / comment lines (#… or //…) — frontmatter — until the
  // first real line. JSON's root is `{`/`[`; everything above it is invalid.
  // (Line-based, so a `[]` inside a comment like `# contracts_produced: []`
  // does NOT get mistaken for the JSON root.)
  const lines = content.split("\n");
  let start = 0;
  while (start < lines.length) {
    const t = lines[start].trim();
    if (t === "" || t.startsWith("#") || t.startsWith("//")) { start++; continue; }
    break;
  }
  if (start > 0 && /^\s*[[{]/.test(lines[start] || "")) {
    content = lines.slice(start).join("\n");
    fs.writeFileSync(args.outputFile, content);
    console.log(`ok:json_stripped_frontmatter ${args.outputFile}`);
  } else {
    console.log(`skip:json_no_manifest ${args.outputFile}`);
  }
  process.exit(0);
}

const style = commentStyleFor(meta.file_path);
const firstLine = content.split("\n", 1)[0];
const isChat = CHAT_RX.test(firstLine);
const alreadyHasManifest = hasManifest(content, style);

let action = "noop";

if (isChat) {
  // Chat prose — try to extract real file content.
  let body = null;
  let strategy = null;
  const block = extractLargestFencedBlock(content);
  if (block && block.body.trim().length >= 20) {
    body = block.body;
    strategy = `chat_fenced_lang=${block.lang || "none"}`;
  }

  if (body && body.trim().length >= 20) {
    if (!hasManifest(body, style)) {
      const manifest = renderManifest(meta, body, args.workerModel, style);
      body = manifest + "\n" + body;
      strategy += "+prepended_manifest";
    }
    fs.writeFileSync(args.outputFile, body);
    action = `salvaged:${strategy}`;
  } else {
    action = "fail:no_extractable_content";
  }
} else if (!alreadyHasManifest) {
  // Clean content but no manifest header — prepend.
  const manifest = renderManifest(meta, content, args.workerModel, style);
  fs.writeFileSync(args.outputFile, manifest + "\n" + content);
  const tag = style.kind === "line" ? `${style.kind}:${style.prefix}` : style.kind;
  action = `prepended_manifest:${tag}`;
}

console.log(`normalize:${action} task=${meta.task_id} file=${meta.file_path}`);
