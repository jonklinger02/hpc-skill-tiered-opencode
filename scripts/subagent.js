#!/usr/bin/env node
/**
 * subagent.js — Generic sub-agent caller for HPC
 *
 * Spawns `claude -p --dangerously-skip-permissions` per invocation with a
 * persona-specific system prompt. Writes output to disk, returns ONLY
 * "ok" or "err:[description]" to stdout.
 *
 * Usage:
 *   node subagent.js --persona <name> --model <model> --phase <planning|execution|validation|escalation> [options]
 *
 * Planning options:
 *   --input <file>          Input file(s) to include in user message
 *   --input-docs <dir>      Directory of input documents
 *   --area <name>           Functional area (for director/engineer councils)
 *   --output-dir <dir>      Directory for output artifacts
 *
 * Execution options:
 *   --task-file <file>      Task YAML for worker
 *   --contracts-dir <dir>   Directory of contract YAMLs
 *   --output-file <file>    Target file path for worker output
 *
 * Validation options:
 *   --validate-file <file>  File to validate
 *   --dependent-tasks <files...>  Dependent task specs (for integration validation)
 *
 * Escalation options:
 *   --escalation-envelope <file>  Escalation envelope YAML
 *   --manifest-dir <dir>    Manifest directory for context
 */

const fs = require("fs");
const path = require("path");
const { resolveModel } = require("./lib/models.js");
const { callAgent } = require("./lib/opencode-client");
let yaml = null;
try { yaml = require("js-yaml"); } catch { /* optional — checklist injection degrades gracefully */ }

// Build a task-specific deliverables checklist (M3.5 §3.5.4) from the task's
// declared produced/consumed symbols, so the generic persona checklist is
// grounded in THIS task's exact contract surface. Returns "" if nothing to add.
function buildDeliverablesChecklist(taskFile) {
  if (!yaml || !taskFile || !fs.existsSync(taskFile)) return "";
  let doc;
  try { doc = yaml.load(fs.readFileSync(taskFile, "utf-8")); } catch { return ""; }
  if (!doc || typeof doc !== "object") return "";
  const collect = (refs, key) => {
    const out = [];
    if (!Array.isArray(refs)) return out;
    for (const r of refs) {
      if (r && typeof r === "object" && Array.isArray(r[key])) {
        for (const s of r[key]) out.push({ sym: s, contract: r.contract_id || r.id || "?" });
      }
    }
    return out;
  };
  const implement = collect(doc.contracts_produced, "implements");
  const invoke = collect(doc.contracts_consumed, "invokes");
  if (implement.length === 0 && invoke.length === 0) return "";
  const lines = ["DELIVERABLES FOR THIS TASK — verify each before emitting `ok`:"];
  for (const i of implement) lines.push(`  - DEFINE (exact name, matching contract surface): ${i.sym}  [${i.contract}]`);
  for (const i of invoke) lines.push(`  - CALL (exact name; do not alias or invent): ${i.sym}  [${i.contract}]`);
  lines.push("  - No TODO/FIXME/XXX/`not yet`/NotImplementedError/empty `pass` bodies.");
  lines.push("  - If a listed symbol cannot be implemented from the spec, emit `err:contract_insufficient` — do NOT improvise a different name.");
  return lines.join("\n");
}

// Build the per-task import-binding block (worker layer). The frozen
// module-paths.yaml maps each produced contract symbol → its producer
// file_path; for this task's CONSUMED symbols we tell the worker exactly which
// file to import each from, so it never guesses a relative path (the Vektor
// import-shim / orphan-import failure mode). Returns "" if nothing to bind.
function buildImportBindingBlock(taskFile, modulePathsFile) {
  if (!yaml || !taskFile || !modulePathsFile) return "";
  if (!fs.existsSync(taskFile) || !fs.existsSync(modulePathsFile)) return "";
  let mp, task;
  try {
    mp = yaml.load(fs.readFileSync(modulePathsFile, "utf-8"));
    task = yaml.load(fs.readFileSync(taskFile, "utf-8"));
  } catch { return ""; }
  const m = (mp && mp.module_paths) || {};
  const sym2path = m.symbol_to_path || {};
  const logical = m.logical_name_to_path || {};
  const myPath = task && task.file_path;
  // Pre-compute the exact relative specifier from this file to the target,
  // extension stripped — so the worker never miscounts `../` levels (the
  // off-by-one that produced the lone residual orphan).
  const relSpecifier = (target) => {
    if (!myPath) return null;
    let rel = path.relative(path.dirname(myPath), target).replace(/\\/g, "/");
    rel = rel.replace(/\.(tsx?|jsx?|mjs|cjs)$/, "");
    if (!rel.startsWith(".")) rel = "./" + rel;
    return rel;
  };
  const consumed = (task && Array.isArray(task.contracts_consumed)) ? task.contracts_consumed : [];
  const lines = [];
  const seen = new Set();
  for (const ref of consumed) {
    const invs = ref && Array.isArray(ref.invokes) ? ref.invokes : [];
    for (const sym of invs) {
      const bare = String(sym).replace(/^[A-Z]+\s+/, "").split(".")[0];
      const target = sym2path[sym] || sym2path[bare];
      if (target && target !== myPath && !seen.has(sym)) {
        seen.add(sym);
        const rel = relSpecifier(target);
        lines.push(rel
          ? `  - ${sym}  →  import { ... } from "${rel}"   (target file: ${target})`
          : `  - ${sym}  →  import from "${target}"`);
      }
    }
  }
  if (lines.length === 0 && Object.keys(logical).length === 0) return "";
  const out = [
    "\nMODULE PATHS — resolve EVERY cross-file import from this canonical map. Do NOT guess a path:",
    "a path that doesn't match a real file is an orphan import that fails the build.",
  ];
  if (myPath) out.push(`Your file is "${myPath}" — compute the correct relative import to each target.`);
  if (lines.length) {
    out.push("Symbols this task consumes, and the exact file to import each from:");
    out.push(...lines);
  }
  out.push("For any other local module, use module-paths.yaml (logical_name_to_path / alias_anchors). Never invent a path.");
  return out.join("\n");
}

// Build the surface-binding block for a TEST artifact. Test-writers are the one
// council that historically diverged from the contract surface: the planning
// prose could name an undocumented member (e.g. Express Router's internal
// `.handle`) and the test-writer would faithfully assert it, even though the
// contract surface only declares the public signatures — producing tsc drift
// (TS2339/TS2554/TS2345). This binds the test to the EXACT consumed-contract
// surface and makes the surface win over the prose. Emits ONLY for TEST
// artifacts, so non-test worker prompts are unchanged. Returns "" otherwise.
function isTestArtifact(taskDoc, taskFilePath) {
  const at = taskDoc && typeof taskDoc.artifact_type === "string" ? taskDoc.artifact_type.toUpperCase() : "";
  if (at === "TEST") return true;
  const fp = (taskDoc && taskDoc.file_path) || taskFilePath || "";
  return /(\.(test|spec)\.[tj]sx?$)|__tests__\//.test(fp);
}

function buildSurfaceBindingBlock(taskFile, contractsDir) {
  if (!yaml || !taskFile || !contractsDir) return "";
  if (!fs.existsSync(taskFile) || !fs.existsSync(contractsDir)) return "";
  let task;
  try { task = yaml.load(fs.readFileSync(taskFile, "utf-8")); } catch { return ""; }
  if (!task || typeof task !== "object") return "";
  if (!isTestArtifact(task, taskFile)) return "";

  const consumed = Array.isArray(task.contracts_consumed) ? task.contracts_consumed : [];
  if (consumed.length === 0) return "";

  const sigLines = [];
  for (const ref of consumed) {
    const cid = ref && (ref.contract_id || ref.id);
    if (!cid) continue;
    const cPath = path.join(contractsDir, `${cid}.yaml`);
    if (!fs.existsSync(cPath)) continue;
    let contract;
    try { contract = yaml.load(fs.readFileSync(cPath, "utf-8")); } catch { continue; }
    const surface = contract && Array.isArray(contract.surface) ? contract.surface : [];
    for (const entry of surface) {
      if (!entry || typeof entry !== "object") continue;
      const sig = entry.signature || entry.name;
      if (!sig) continue;
      const kind = entry.kind ? String(entry.kind) : "";
      const sync = entry.async === true ? "async" : (entry.async === false ? "sync" : "");
      const tags = [cid, kind, sync].filter(Boolean).join(" · ");
      sigLines.push(`  - ${String(sig).trim()}   [${tags}]`);
    }
  }
  if (sigLines.length === 0) return "";

  return [
    "\nSURFACE BINDING — you are writing a TEST. Exercise ONLY the public contract surface below.",
    "Call/assert ONLY these exact signatures. Do NOT invent members (e.g. an internal `.handle`),",
    "change arity, pass extra arguments, or assert on members not listed here. If the task prose or",
    "`signature:` names a member that is NOT in this surface, the SURFACE WINS — bind to it and omit",
    "the prose-only assertion (that mismatch is the test↔contract drift this binding prevents).",
    "Authoritative callable surface for the contracts this test consumes:",
    ...sigLines,
  ].join("\n");
}

// ── Parse CLI args ──
function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = { inputs: [], inputDocs: null, dependentTasks: [] };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--persona": parsed.persona = args[++i]; break;
      case "--model": parsed.model = args[++i]; break;
      case "--phase": parsed.phase = args[++i]; break;
      case "--input": parsed.inputs.push(args[++i]); break;
      case "--input-docs": parsed.inputDocs = args[++i]; break;
      case "--area": parsed.area = args[++i]; break;
      case "--output-dir": parsed.outputDir = args[++i]; break;
      case "--output-file": parsed.outputFile = args[++i]; break;
      case "--task-file": parsed.taskFile = args[++i]; break;
      case "--contracts-dir": parsed.contractsDir = args[++i]; break;
      case "--validate-file": parsed.validateFile = args[++i]; break;
      case "--dependent-tasks": 
        while (i + 1 < args.length && !args[i + 1].startsWith("--")) {
          parsed.dependentTasks.push(args[++i]);
        }
        break;
      case "--escalation-envelope": parsed.escalationEnvelope = args[++i]; break;
      case "--manifest-dir": parsed.manifestDir = args[++i]; break;
      case "--tools": parsed.tools = args[++i]; break;
      case "--timeout-ms": parsed.timeoutMs = parseInt(args[++i]); break;
      case "--module-paths": parsed.modulePaths = args[++i]; break;
      case "--issues": parsed.issues = args[++i]; break;
      case "--prompt-file": parsed.promptFile = args[++i]; break;
    }
  }
  return parsed;
}

// Planning-tier councils (especially a high-effort Director on a multi-epic
// area, or the C-Suite) can exceed the 25-min callClaude default and time out
// with no output. Give planning a wider ceiling; override with --timeout-ms.
const PLANNING_TIMEOUT_MS = 2700000; // 45 min

// ── Load persona system prompt ──
function loadPersona(name) {
  const skillDir = path.resolve(__dirname, "..");
  const personasFile = path.join(skillDir, "references", "personas.md");
  const content = fs.readFileSync(personasFile, "utf-8");
  
  // Extract the system prompt block for the named persona
  const personaMap = {
    "csuite": "Visionary (C-Suite Council)",
    "product-strategist": "Product Strategist (C-Suite Council)",
    "quality-strategist": "Quality Strategist (C-Suite Council)",
    "critic": "Critic (All Tiers)",
    "synthesizer": "Synthesizer (All Tiers)",
    "director": "Director (Director Council)",
    "integration-architect": "Integration Architect (Director Council)",
    "senior-engineer": "Senior Engineer (Engineer Council)",
    // Alias: dispatch-engineers.js passes --persona engineer for the engineer
    // council. The planning-phase tier branch already maps "engineer" → tier
    // "engineer", but loadPersona() needs an entry too in case any code path
    // looks the persona up directly.
    "engineer": "Senior Engineer (Engineer Council)",
    "coder": "Coder (Worker Agent)",
    "schema-validator": "Schema Validator",
    "integration-validator": "Integration Validator",
    "ui-validator": "UI Validator",
    "escalation-handler": "Escalation Handler",
  };

  const heading = personaMap[name];
  if (!heading) {
    return null;
  }

  // Find the persona section and extract the code block
  const sectionRegex = new RegExp(`## Persona: ${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?\`\`\`\\n([\\s\\S]*?)\`\`\``, "m");
  const match = content.match(sectionRegex);
  if (!match) return null;
  return match[1].trim();
}

// ── Build multi-persona council prompt ──
// Build the ID-minting instruction injected into Director/Engineer council
// prompts. Councils must NOT invent IDs — they call mint-id.js (via Bash) to
// get the canonical, collision-free, parallel-safe id and paste it verbatim.
function mintBlock(tier, skillDir, manifestDir) {
  const mint = path.join(skillDir, "scripts", "mint-id.js");
  const md = manifestDir || "manifest/";
  const lines = [
    `\n\nID MINTING — DO NOT INVENT IDs. Obtain every artifact id from the minter (via your Bash tool) and`,
    `paste the returned id VERBATIM into the YAML. Call it once per id:`,
    `  node ${mint} --manifest-dir ${md} --type task_group --area <AREA>     # → GRP-<AREA>-NNN`,
    `  node ${mint} --manifest-dir ${md} --type contract  --domain <DOMAIN>  # → CONTRACT-<DOMAIN>-NNN`,
  ];
  if (tier === "engineer") {
    lines.push(`  node ${mint} --manifest-dir ${md} --type task      --area <AREA>     # → TASK-<AREA>-NNNN`);
  }
  lines.push(`AREA is your functional area (e.g. API, DB, LIB, UI, INFRA); DOMAIN is the contract's domain.`);
  lines.push(`Inventing ids like "TG-API-001" instead of the minted "GRP-API-001" is a naming violation the`);
  lines.push(`enforce-naming gate rejects. Mint ids as you finalize each artifact, then assemble the YAML.`);
  return lines.join("\n");
}

// The manifest is the single source of truth. Councils READ it (canonical
// contract IDs + surfaces, existing task file_paths) before referencing
// anything, and bind to what already exists rather than re-inventing it — the
// root fix for cross-council drift (e.g. binding to the Director's
// CONTRACT-DB-CONFIGSTORE-001 instead of inventing CONTRACT-DB-001).
function manifestAwarenessBlock(tier, skillDir, manifestDir) {
  const cli = path.join(skillDir, "scripts", "manifest-cli.js");
  const md = manifestDir || "manifest/";
  const L = [
    `\n\nMANIFEST AWARENESS — the manifest is the SINGLE SOURCE OF TRUTH. Before referencing anything, READ`,
    `it via your Bash tool and bind to what ALREADY EXISTS (do not re-invent IDs or symbol names):`,
    `  node ${cli} --manifest-dir ${md} surfaces            # → {contract_id: [surface symbol names]} for ALL contracts`,
    `  node ${cli} --manifest-dir ${md} list --type contract # → existing contracts (id, name, domain, surface)`,
  ];
  if (tier === "engineer") {
    L.push(`  node ${cli} --manifest-dir ${md} list --type task     # → existing task ids + file_paths (DO NOT reuse a file_path)`);
    L.push(`RULES (hard):`);
    L.push(`1. Every \`invokes\`/\`implements\` symbol MUST be an EXACT entry in some existing contract's surface`);
    L.push(`   (from \`surfaces\`). Bind to that contract's EXACT id. Never invent a contract id or a method name`);
    L.push(`   that isn't already in the surfaces map — that is the drift the manifest prevents.`);
    L.push(`2. If a producer's symbol you need to consume is NOT yet in any surface, that is a CONTRACT GAP:`);
    L.push(`   prefer the closest existing surface symbol; only if none fits, mint a new contract`);
    L.push(`   (mint-id --type contract --domain <D>), define its surface, and \`manifest-cli add --type contract\`.`);
    L.push(`3. Never claim a \`file_path\` already present in \`list --type task\` — pick a distinct path.`);
  } else {
    L.push(`  node ${cli} --manifest-dir ${md} get --type contract --id <ID>   # → a full existing contract (to extend it)`);
    L.push(`When you need a contract, first check \`surfaces\`/\`list --type contract\` and choose ONE of:`);
    L.push(`1. REUSE — an existing contract already covers it: bind to its EXACT id; do not create a near-duplicate.`);
    L.push(`2. EXTEND — an existing contract is the RIGHT one but MISSING a symbol you need (your most common case`);
    L.push(`   for a shared/cross-area boundary): ADD to it in place. \`get\` it, append the new entry to its`);
    L.push(`   \`surface:\` (keep ALL existing entries), then \`manifest-cli update --type contract --id <ID>`);
    L.push(`   --content-file <f>\`. Prefer extending a shared contract over forking a parallel one. Do NOT also`);
    L.push(`   re-emit that contract in your output YAML — it already lives in the manifest; re-emitting it would`);
    L.push(`   overwrite your in-place extension when the output is split.`);
    L.push(`3. CREATE — only when nothing fits: mint a new id (mint-id --type contract --domain <D>) and define it`);
    L.push(`   (either emit it in your output \`contracts:\` array, or \`manifest-cli add --type contract\`).`);
    L.push(`Cross-area boundaries you consume bind to the producing area's existing contract id (reuse/extend),`);
    L.push(`never a new parallel one. Because Directors run LINEARLY, earlier areas' contracts are already in the`);
    L.push(`manifest for you to reuse/extend.`);
  }
  return L.join("\n");
}

function buildCouncilPrompt(tier, area = null, manifestDir = null) {
  const skillDir = path.resolve(__dirname, "..");
  const personasFile = path.join(skillDir, "references", "personas.md");
  const protocolsFile = path.join(skillDir, "references", "council-protocols.md");
  const schemasFile = path.join(skillDir, "references", "manifest-schema.md");

  let systemPrompt = "";

  if (tier === "csuite") {
    const personas = ["csuite", "product-strategist", "quality-strategist", "critic", "synthesizer"];
    systemPrompt = `You are running a C-Suite planning council with the following participants:

`;
    for (const p of personas) {
      const prompt = loadPersona(p);
      if (prompt) systemPrompt += `--- ${p.toUpperCase()} ---\n${prompt}\n\n`;
    }
    systemPrompt += `
DELIBERATION PROTOCOL:
1. As Visionary: propose the epic structure and architecture
2. As Product Strategist: validate requirement coverage and priority
3. As Quality Strategist: annotate testability and flag NFR gaps
4. As Critic: challenge all proposals — find gaps, contradictions, assumptions
5. As Synthesizer: reconcile into a single output, document decisions

PLAN-COMPLETENESS REQUIREMENTS (mandatory — Gate 1 enforces these under autonomous mode):

1. tech_stack — emit a top-level \`tech_stack:\` list describing every language/role in the build.
   Each entry: \`language\`, \`role\` (one of control_plane | api_server | web_ui | ssr_app | cli | lib | worker),
   plus the relevant \`package_manager\` / \`framework\` / \`bundler\` / \`test_runner\`. This is machine-read by
   glue-epic detection, boot_smoke selection, and the module-path manifest. Omitting it fails Gate 1.

2. Glue epic — if tech_stack declares any of \`api_server\`, \`web_ui\`, or \`ssr_app\`, you MUST emit an epic with
   \`epic_id: "E-GLUE-000"\` whose functional_areas and acceptance_criteria OWN the cross-cutting boot layer
   (Vite+React: vite.config.ts, tsconfig.json, index.html, src/ui/main.tsx, src/ui/App.tsx · Next.js:
   next.config.js, tsconfig.json, app/layout.tsx, app/page.tsx · Express: src/server/app.js, middleware,
   entrypoint · Fastify: src/server/server.js, plugins, entrypoint · Python control_plane: __init__.py files,
   package layout, entrypoint module). Feature epics must NOT own these files. A missing or empty E-GLUE-000
   fails Gate 1.

3. Deferral disposition — any \`decisions_log\` entry with \`status: deferred\` MUST carry a \`deferral_disposition\`:
   either \`generated_task: <TASK-ID>\` (names a manifest task that must exist and block the deferring epic's
   start) OR \`waiver: <reason>\` (countersigned by the Synthesizer plus at least one dissenter). "Documented and
   deferred" with no disposition is illegal and fails Gate 1.

OUTPUT: Produce a single YAML document containing all artifacts (tech_stack, epics, architecture, dag, functional_areas).
Include a decisions_log array documenting key decisions and rationale (with deferral_disposition on any deferred motion).
Return ONLY valid YAML. No markdown fencing, no preamble.`;
  } else if (tier === "director") {
    const personas = ["director", "integration-architect", "critic", "synthesizer"];
    systemPrompt = `You are running a Director council for the ${area} functional area.

`;
    for (const p of personas) {
      const prompt = loadPersona(p);
      if (prompt) systemPrompt += `--- ${p.toUpperCase()} ---\n${prompt}\n\n`;
    }
    systemPrompt += `
DELIBERATION PROTOCOL:
1. As Domain Lead: propose task groups for your functional area
2. As Integration Architect: draft interface contracts for cross-domain boundaries
3. As Critic: challenge task group boundaries, flag cross-cutting concerns
4. As Synthesizer: produce the final task groups, contracts, and namespace claims

CONTRACTS ARE BINDING — every contract MUST include a structured \`surface:\` block.
The \`surface:\` enumerates every symbol the contract exposes (method, endpoint, type,
event, const) with exact name and signature. Downstream Engineer councils and per-task
validators enforce that consumers reference ONLY symbols in surface, with exact names —
no aliasing. Under-specifying the surface is a council failure, not a consumer failure.

Required structure for every contract you produce:

  contract_id: "CONTRACT-..."
  name: "..."
  contract_type: TYPESCRIPT | OPENAPI | SQL_DDL | GRAPHQL | PROTOBUF | JSON_SCHEMA
  surface:
    - kind: METHOD          # METHOD | ENDPOINT | TYPE | EVENT | CONST
      name: "Module.method" # exact, case-sensitive
      signature: "method(arg: Type) -> Return"
      async: false
    - kind: TYPE
      name: "TypeName"
      fields: ["field: Type", ...]
    - kind: ENDPOINT
      name: "POST /path"
      request: "RequestType"
      response: "ResponseType"
  definition: |
    (freeform IDL prose — must faithfully expand surface; surface is authoritative)
  produced_by_area: ${area}
  consumed_by_areas: [<list>]

The Gate 2 validator REJECTS contracts missing \`surface:\` or with an empty surface
(see references/manifest-schema.md "Binding rule"). Do not ship contracts without it.

CONTRACT SURFACE COMPLETENESS — the Critic MUST perform this before synthesis (hard reject on failure):
1. Read each contract's \`definition:\` prose. Enumerate every operation/method/endpoint it describes.
2. Verify each appears in the structured \`surface:\` block. If \`definition:\` mentions \`JobStore.list_jobs()\`
   but \`surface:\` only lists \`list\`, the contract is malformed — fix it before freezing.
3. Verify each \`surface:\` entry has a complete signature, not a placeholder. \`signature: TBD\` or
   \`signature: "..."\` is invalid.
4. For every cross-area boundary, the surface must cover ALL expected interactions. Missing surface entries
   cause Engineer-tier improvisation — under-specification at Director tier is the root of the
   214-promotion failure mode.

DEFERRAL DISPOSITION — any decisions_log entry you mark \`status: deferred\` MUST carry a
\`deferral_disposition\`: \`generated_task: <TASK-ID>\` (a task that must exist and block the deferring
group's start) OR \`waiver: <reason>\`. A deferral with no disposition fails Gate 1.

OUTPUT: Produce a single YAML document with task_groups, contracts, and namespace_claims arrays.
Include a decisions_log array (with deferral_disposition on any deferred motion). Return ONLY valid YAML.

ABSOLUTELY DO NOT split your output into "pieces" with markdown dividers (e.g.
\`**Piece 3 of 4**\`, \`---\` horizontal rules between sections, "(continued)"
markers). The output goes through a structural splitter that requires every
top-level key (task_groups, contracts, namespace_claims, decisions_log) to
appear EXACTLY ONCE at column 0, with all items indented underneath using a
SINGLE consistent indent (2 spaces). Piece-splitting orphans items at column 0
and corrupts the manifest. If the council output would exceed budget, prefer
fewer-but-richer contracts and groups over splitting — quality over volume.`;
  } else if (tier === "engineer") {
    const personas = ["senior-engineer", "critic", "synthesizer"];
    systemPrompt = `You are running an Engineer council for the ${area} functional area.

`;
    for (const p of personas) {
      const prompt = loadPersona(p);
      if (prompt) systemPrompt += `--- ${p.toUpperCase()} ---\n${prompt}\n\n`;
    }
    systemPrompt += `
DELIBERATION PROTOCOL:
1. As Senior Engineer A: propose atomic task breakdown with signatures and file paths
2. As Senior Engineer B: propose an alternative breakdown (genuinely different decomposition)
3. As Contracts Engineer: annotate each task with contract cross-references
4. As Critic: review for missing error handling, inconsistent naming, tasks too coarse/fine
5. As Synthesizer: merge proposals, produce final atomic task list

ATOMIC TASK CRITERIA:
- Exactly one file per task
- Implementable by Haiku in a single API call
- Clear, unambiguous specification
- Token budget under 8000 output tokens
- If a task violates any criteria, split it

TASK ATOMICITY RULES — the Critic MUST reject violations (hard reject, not advisory):
1. Every task produces exactly one file. A task description saying "produces X and Y" is rejected — split it.
2. Every task has a single artifact_type. Tasks that conflate (e.g. "ENDPOINT and TYPE") are split.
3. A task whose description names external modules MUST list those modules in contracts_consumed. The
   Contracts Engineer flags any task that references a name not in its declared consumed contracts.
4. Boot-layer files (vite.config.ts, tsconfig.json, package.json, main.tsx, app.js, __init__.py at package
   roots) are NEVER produced by feature tasks — they belong to the Glue Epic (E-GLUE-000). Any feature task
   that creates, modifies, or references these files is a structural violation — reject.
5. Every task whose artifact_type is COMPONENT or HOOK MUST declare an INTERFACE_CONTRACT in its
   contracts_produced (the shape it returns) OR contracts_consumed (the shape its peer hook returns). Naked
   components without interface contracts are how hook/return-shape drift forms.

CONTRACTS ARE BINDING — every task that touches a contract MUST enumerate the exact
symbols it invokes (consumer) or implements (producer) by name from the contract's
\`surface:\` block. NO ALIASING — \`list_jobs\` is not \`list\`. NO IMPROVISATION — if
the contract surface lacks a method you need, escalate (escalation_type: CONTRACT_CONFLICT),
do not invent it.

Required structure for every task's contracts references:

  contracts_consumed:
    - contract_id: "CONTRACT-X"
      invokes: ["Module.methodA", "Module.methodB"]   # exact symbol names from CONTRACT-X.surface
  contracts_produced:
    - contract_id: "CONTRACT-Y"
      implements: ["Module.methodA", "Module.methodB"]

The Critic and Contracts Engineer personas MUST reject any proposed task that:
- Lists \`invokes\` symbols not present in the consumed contract's \`surface:\`
- Lists \`implements\` symbols not present in the produced contract's \`surface:\`
- Uses a method name that disagrees with the contract surface (aliasing)

If the Critic finds the contract surface insufficient to express what the task needs to do,
the Synthesizer routes via escalation back to Director-tier, not by inventing names.

Gate 3 validates symmetry: every \`invokes\` symbol must be implemented by some task,
every surface entry must be implemented by some task. Failures here mean Engineer-tier
left coverage gaps.

MODULE PATHS — a \`module-paths.yaml\` manifest (logical_name_to_path, alias_anchors, conventions) is
produced before this council by a glue epic. When it is present in your inputs, every task you emit MUST
choose import paths and file locations consistent with it: a task that needs a shared module lists
\`MODULE-PATHS-MANIFEST\` in its \`contracts_consumed\` and uses the canonical path from the manifest rather
than inventing one. Boot-layer files (vite.config.ts, tsconfig.json, package.json, main.tsx, app.js,
__init__.py at package roots) are owned by the glue epic — never by a feature task.

DEFERRAL DISPOSITION — any decisions_log entry you mark \`status: deferred\` MUST carry a
\`deferral_disposition\`: \`generated_task: <TASK-ID>\` OR \`waiver: <reason>\`. A deferral with no disposition
fails Gate 1.

OUTPUT: Produce a single YAML document with tasks and file_tree arrays.
Include a decisions_log array (with deferral_disposition on any deferred motion). Return ONLY valid YAML.

ABSOLUTELY DO NOT split your output into "pieces" with markdown dividers
(e.g. \`**Piece 3 of 4**\`, \`---\` horizontal rules). One top-level
\`tasks:\` key, all tasks indented underneath with consistent 2-space indent.`;
  }

  // Director/Engineer councils are manifest-aware (read the source of truth)
  // and mint canonical IDs at the source — both via Bash.
  if (tier === "director" || tier === "engineer") {
    systemPrompt += manifestAwarenessBlock(tier, skillDir, manifestDir);
    systemPrompt += mintBlock(tier, skillDir, manifestDir);
  }

  return systemPrompt;
}

function personaBlocks(names) {
  let out = "";
  for (const name of names) {
    const prompt = loadPersona(name);
    if (prompt) out += `--- ${name.toUpperCase()} ---\n${prompt}\n\n`;
  }
  return out;
}

function buildCouncilProposersPrompt(tier, area = null, manifestDir = null) {
  const skillDir = path.resolve(__dirname, "..");
  const protocolsFile = path.join(skillDir, "references", "council-protocols.md");
  const schemasFile = path.join(skillDir, "references", "manifest-schema.md");

  let systemPrompt = "";
  if (tier === "csuite") {
    systemPrompt = `You are running the PROPOSER PHASE of a C-Suite planning council.\n\n`;
    systemPrompt += personaBlocks(["csuite", "product-strategist", "quality-strategist"]);
    systemPrompt += `\nDELIBERATION PROTOCOL (Proposer Phase — do NOT synthesize yet):\n1. As Visionary: propose the epic structure and architecture\n2. As Product Strategist: validate requirement coverage and priority\n3. As Quality Strategist: annotate testability and flag NFR gaps\n\nOutput structured deliberation only. Include proposed epic structure, architecture decisions, coverage analysis, and testability annotations. Do NOT emit the final YAML yet. GPT-5.5 will run Critic+Synthesizer in the next pass.`;
  } else if (tier === "director") {
    systemPrompt = `You are running the PROPOSER PHASE of a Director council for the ${area} functional area.\n\n`;
    systemPrompt += personaBlocks(["director", "integration-architect"]);
    systemPrompt += `\nDELIBERATION PROTOCOL (Proposer Phase — do NOT synthesize yet):\n1. As Domain Lead: propose task groups for your functional area\n2. As Integration Architect: draft interface contracts for cross-domain boundaries\n\nOutput structured deliberation only. Include proposed task groups, contracts with surface definitions, namespace claims, and rationale. Do NOT emit the final YAML yet. GPT-5.5 will run Critic+Synthesizer in the next pass.`;
    systemPrompt += manifestAwarenessBlock(tier, skillDir, manifestDir);
    systemPrompt += mintBlock(tier, skillDir, manifestDir);
  }

  const protocols = safeRead(protocolsFile);
  if (protocols) systemPrompt += `\n\nCOUNCIL PROTOCOLS:\n${protocols}`;
  const schemas = safeRead(schemasFile);
  if (schemas) systemPrompt += `\n\nMANIFEST SCHEMA REFERENCE:\n${schemas}`;
  return systemPrompt;
}

function buildCouncilCritiquePrompt(tier, area = null, manifestDir = null) {
  const skillDir = path.resolve(__dirname, "..");
  let systemPrompt = "";
  if (tier === "csuite") {
    systemPrompt = `You are running the GPT-5.5 CRITIC+SYNTHESIZER PHASE of a C-Suite planning council.\n\n`;
    systemPrompt += personaBlocks(["critic", "synthesizer"]);
    systemPrompt += `\nAs Critic: challenge the proposer output — find gaps, contradictions, assumptions, missing requirements, missing glue epic ownership, and missing deferral dispositions.\nAs Synthesizer: reconcile the proposer output and critique into a single final YAML document.\n\nPLAN-COMPLETENESS REQUIREMENTS:\n1. Emit top-level tech_stack.\n2. If tech_stack declares api_server, web_ui, or ssr_app, emit E-GLUE-000.\n3. Any deferred decisions_log entry MUST include deferral_disposition.\n\nOUTPUT: Produce a single YAML document containing tech_stack, epics, architecture, dag, functional_areas, and decisions_log. Return ONLY valid YAML. No markdown fencing, no preamble.`;
  } else if (tier === "director") {
    systemPrompt = `You are running the GPT-5.5 CRITIC+SYNTHESIZER PHASE of a Director council for the ${area} functional area.\n\n`;
    systemPrompt += personaBlocks(["critic", "synthesizer"]);
    systemPrompt += `\nAs Critic: reject malformed task-group boundaries, missing surfaces, bad cross-area bindings, unminted IDs, and deferred decisions without disposition.\nAs Synthesizer: reconcile the proposer output and critique into a single final YAML document.\n\nCONTRACT REQUIREMENTS:\n- Every contract MUST include a non-empty structured surface block.\n- Surface entries must have complete signatures, never TBD placeholders.\n- Cross-area boundaries must reuse or extend existing manifest contracts when appropriate.\n\nOUTPUT: Produce a single YAML document with task_groups, contracts, namespace_claims, and decisions_log. Return ONLY valid YAML. No markdown fencing, no preamble.`;
    systemPrompt += manifestAwarenessBlock(tier, skillDir, manifestDir);
    systemPrompt += mintBlock(tier, skillDir, manifestDir);
  }
  return systemPrompt;
}

async function reviewCouncilOutput(persona, outputDir, yaml, planTimeout) {
  const reviewer = loadPersona("council-reviewer");
  if (!reviewer) return;
  const reviewMessage = [
    "--- COUNCIL OUTPUT YAML ---",
    yaml,
    "\nReview this YAML for CRITICAL downstream-breaking issues only. If none, output exactly: APPROVED",
  ].join("\n\n");
  const result = await callClaude("council_review", reviewer, reviewMessage, 4000, planTimeout, "", null);
  if (result.error) return;
  const text = (result.text || "").trim();
  const reviewPath = path.join(outputDir || ".", `${persona}-review.txt`);
  try { fs.writeFileSync(reviewPath, text); } catch {}
  if (!/^APPROVED\b/i.test(text)) console.error(`[council-review] ${text}`);
}

// Map a target file path to its line-comment prefix so the worker prompt can
// ask for a SYNOPSIS block in the correct comment syntax (was always "#",
// which is invalid in TS/Rust/SQL/etc and produced parse-broken outputs).
// KEEP IN SYNC with commentStyleFor() in normalize-output.js — that script has
// no main-guard (requiring it runs its CLI), so the table is duplicated here.
function commentPrefixFor(filePath) {
  if (!filePath) return "#";
  const ext = path.extname(filePath).toLowerCase();
  const base = path.basename(filePath).toLowerCase();
  const hash = new Set([".py", ".sh", ".bash", ".yaml", ".yml", ".toml", ".rb", ".pl", ".r", ".dockerfile", ".env", ".ini", ".conf"]);
  const slash = new Set([".rs", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".go", ".java", ".c", ".cc", ".cpp", ".h", ".hpp", ".cs", ".kt", ".swift", ".scala", ".php", ".dart", ".proto", ".prisma"]);
  const dash = new Set([".sql", ".lua", ".hs", ".elm", ".ada"]);
  if (hash.has(ext)) return "#";
  if (slash.has(ext)) return "//";
  if (dash.has(ext)) return "--";
  if (base === "dockerfile" || base === "makefile" || base.startsWith(".env")) return "#";
  return "#";
}

// Defensive cleanup of worker output before writing to disk. Belt-and-
// suspenders against three failure modes the prompt forbids:
//   1. Markdown code fences wrapping the body (```python … ```).
//   2. Leading prose ("I will…", "Here is…", "Let me…").
//   3. Raw `---` YAML frontmatter on a non-Markdown target — the worker was
//      asked to comment the frontmatter for the file's language but emitted
//      raw `---` instead. We strip; normalize-output.js re-attaches in the
//      correct comment style.
// For Markdown targets, raw `---` frontmatter is the canonical form and is
// passed through — and fenced code blocks are legitimate document content, so
// fence extraction/stripping is skipped too (it would corrupt the deliverable).
function cleanWorkerOutput(text, targetFilePath) {
  if (!text) return text;
  let s = text.replace(/^﻿/, "");
  const isMarkdownTarget = targetFilePath && /\.(md|mdx|markdown)$/i.test(targetFilePath);

  if (isMarkdownTarget) {
    // Interior fences are legitimate document content, so we don't extract or
    // strip them. But a worker that wraps the ENTIRE deliverable in one outer
    // ```markdown … ``` fence (the wrapping the extractor exists to undo) would
    // otherwise ship those fence lines. Unwrap only when the whole trimmed body
    // is exactly one fenced block.
    const whole = s.trim().match(/^```[a-zA-Z0-9_+-]*\s*\n([\s\S]*?)\n```$/);
    if (whole) s = whole[1];
  } else {
    // Extract the largest ```lang … ``` block if present and substantial.
    const blocks = [];
    const fenceRx = /```[a-zA-Z0-9_+-]*\s*\n([\s\S]*?)\n```/g;
    let m;
    while ((m = fenceRx.exec(s)) !== null) blocks.push(m[1]);
    if (blocks.length > 0) {
      const largest = blocks.reduce((a, b) => b.length > a.length ? b : a);
      if (largest.length >= 20 && largest.length > s.length / 3) s = largest;
    }

    // Strip stray fence-only lines that survived (single fences, mismatched).
    s = s.split("\n").filter(l => !/^\s*```[a-zA-Z0-9_+-]*\s*$/.test(l)).join("\n");
  }

  // Strip leading prose: drop lines until we see a plausible code start.
  // The YAML-key heuristic also has to disambiguate `Configuration:` (English
  // sentence) from `services:` (real root key) — we require the *next* non-
  // empty line to be indented or a list-item, which is what real YAML always
  // looks like and prose rarely does.
  const codeStart = /^\s*(#|\/\/|\/\*|\*|--|<!--|<\?|\{|\[|"|'|import |from |def |class |async |fn |use |pub |mod |struct |enum |interface |export |const |let |var |type |function |if |while |for |return |@|::|!#|\$)/;
  const yamlKey = /^[a-zA-Z_][\w-]*:\s*($|[^/])/;
  const sqlKw = /^\s*(CREATE|ALTER|INSERT|SELECT|DROP|UPDATE|DELETE|WITH|BEGIN)\b/i;
  const arr = s.split("\n");
  const nextNonEmptyAfter = (i) => {
    for (let j = i + 1; j < arr.length; j++) if (arr[j].trim()) return arr[j];
    return "";
  };
  let firstCode = -1;
  for (let i = 0; i < arr.length; i++) {
    const ln = arr[i];
    if (!ln.trim()) continue;
    if (ln.startsWith("---")) { firstCode = i; break; }
    if (codeStart.test(ln) || sqlKw.test(ln)) { firstCode = i; break; }
    if (yamlKey.test(ln)) {
      const nxt = nextNonEmptyAfter(i);
      if (/^\s+\S/.test(nxt) || /^-\s/.test(nxt) || nxt === "") { firstCode = i; break; }
    }
    // Otherwise it's prose — keep scanning.
  }
  if (firstCode > 0) s = arr.slice(firstCode).join("\n");

  // Strip a leaked raw `---` metadata frontmatter — but only on non-Markdown
  // targets, where raw frontmatter is invalid syntax. Markdown legitimately
  // begins with `---`. Detection requires `task_id:` in the block so we don't
  // strip a legitimate YAML doc-start separator on a `.yaml` output.
  if (s.startsWith("---") && !isMarkdownTarget) {
    const idx = s.indexOf("\n---", 3);
    if (idx >= 0) {
      const block = s.slice(0, idx);
      if (/^task_id:\s*\S/m.test(block)) {
        s = s.slice(idx + 4).replace(/^\n+/, "");
      }
    }
  }

  return s.replace(/\s+$/, "") + "\n";
}

// ── Worker-crash capture (M3 §3.2) ──
//
// When a worker subprocess exits non-zero with no structured ok/err line, the
// stderr is the single largest blind spot under autonomy. Capture it to a
// per-task log under wiki/worker-crashes/ and classify the crash_reason so the
// 201-`err:exec`-crashes-in-run-1 pattern becomes diagnosable instead of opaque.
function classifyCrash(stdout, stderr, status, timedOut) {
  const blob = `${stderr || ""}\n${stdout || ""}`;
  if (timedOut || /SIGTERM|SIGKILL|timed out/i.test(blob)) return "timeout";
  if (/out of memory|OOM|allocation failed|JS heap/i.test(blob)) return "oom";
  if (/rate.?limit|\b429\b|quota|overloaded/i.test(blob)) return "rate_limit";
  if (!String(stdout || "").trim() && !String(stderr || "").trim()) return "empty_output";
  return "structured_error";
}

// Writes the crash log relative to the current workspace (process.cwd(), which
// is the workspace root when execute.js dispatches workers). Returns the path
// or null. Best-effort — never throws into the worker error path.
function captureCrash(taskId, crashReason, status, stdout, stderr, timedOut) {
  try {
    const crashDir = path.join(process.cwd(), "wiki", "worker-crashes");
    fs.mkdirSync(crashDir, { recursive: true });
    const safe = String(taskId || "unknown").replace(/[^A-Za-z0-9_.-]/g, "_");
    const crashFile = path.join(crashDir, `${safe}-${Date.now()}.log`);
    fs.writeFileSync(crashFile,
      `TASK_ID: ${taskId || "unknown"}\n` +
      `CRASH_REASON: ${crashReason}\n` +
      `EXIT_CODE: ${status === null || status === undefined ? "null" : status}\n` +
      `TIMED_OUT: ${!!timedOut}\n\n` +
      `--- STDERR ---\n${stderr || ""}\n\n--- STDOUT ---\n${stdout || ""}\n`);
    return crashFile;
  } catch {
    return null;
  }
}

// ── Read files from directory ──
function readDir(dir, ext = null) {
  if (!fs.existsSync(dir)) return {};
  const files = fs.readdirSync(dir);
  const result = {};
  for (const f of files) {
    if (ext && !f.endsWith(ext)) continue;
    const fp = path.join(dir, f);
    if (fs.statSync(fp).isFile()) {
      result[f] = fs.readFileSync(fp, "utf-8");
    }
  }
  return result;
}

// ── Call sub-agent via OpenCode serve API ──

async function callClaude(model, systemPrompt, userMessage, maxTokens = 16000, timeoutMs = 1500000, tools = "", effort = null) {
  let toolsParam = null;
  if (tools === "Bash,Read") {
    toolsParam = { read: true, list: true, glob: true, grep: true, edit: false, bash: false };
  } else if (tools && tools !== "") {
    toolsParam = { read: true, edit: true, bash: true, glob: true, grep: true, list: true };
  }
  return callAgent({
    role: "worker",
    model: resolveModel(model),
    systemPrompt,
    userMessage,
    timeoutMs,
    tools: toolsParam,
    effort,
  });
}

// ── Parse YAML-ish output ──
function extractYAML(text) {
  // Strip markdown fencing if present
  let cleaned = text.replace(/^```ya?ml\s*/gm, "").replace(/^```\s*$/gm, "").trim();
  return cleaned;
}

// ── Write artifacts from council output ──
//
// Writes the monolithic `{tier}-output.yaml`. Splitting into per-epic /
// per-group / per-task / per-contract files is intentionally NOT done here —
// that is the job of `split-council-output.js`, which the orchestrator must
// invoke after each council phase (see SKILL.md "Splitting council output").
function writeCouncilArtifacts(yamlText, outputDir, tier) {
  fs.mkdirSync(outputDir, { recursive: true });
  const outFile = path.join(outputDir, `${tier}-output.yaml`);
  fs.writeFileSync(outFile, yamlText);
  return outFile;
}

// ── Main ──
async function main() {
  const args = parseArgs();
  
  // The `freeform` phase is the one path that does not run a council persona:
  // it takes a fully-built prompt file and emits text to --output-file (used by
  // e2e-generate.js). It needs --model + --prompt-file + --output-file, not a
  // --persona. Every other phase requires persona/model/phase.
  if (args.phase === "freeform") {
    if (!args.model || !args.promptFile || !args.outputFile) {
      console.log("err:missing required args (--model, --prompt-file, --output-file)");
      process.exit(1);
    }
  } else if (!args.persona || !args.model || !args.phase) {
    console.log("err:missing required args (--persona, --model, --phase)");
    process.exit(1);
  }

  let systemPrompt = "";
  let userMessage = "";
  let maxTokens = 16000;

  // ── PLANNING PHASE ──
  if (args.phase === "planning") {
    const tier = args.persona === "csuite" ? "csuite" 
               : args.persona === "director" ? "director" 
               : "engineer";
    
    // Build user message from inputs. `--input` accepts either a file or a
    // directory — directories are expanded to all .yaml files inside (the
    // SKILL.md director step passes manifest/epics/ as a directory).
    const parts = [];
    for (const inputPath of args.inputs) {
      if (!fs.existsSync(inputPath)) continue;
      const st = fs.statSync(inputPath);
      if (st.isDirectory()) {
        const docs = readDir(inputPath, ".yaml");
        for (const [name, content] of Object.entries(docs)) {
          parts.push(`--- ${name} ---\n${content}`);
        }
      } else {
        parts.push(`--- ${path.basename(inputPath)} ---\n${fs.readFileSync(inputPath, "utf-8")}`);
      }
    }
    if (args.inputDocs && fs.existsSync(args.inputDocs)) {
      const docs = readDir(args.inputDocs);
      for (const [name, content] of Object.entries(docs)) {
        parts.push(`--- ${name} ---\n${content}`);
      }
    }
    
    if (tier === "director" || tier === "engineer") {
      // Include relevant manifests from previous tiers
      if (args.manifestDir) {
        const manifests = readDir(args.manifestDir, ".yaml");
        for (const [name, content] of Object.entries(manifests)) {
          parts.push(`--- manifest/${name} ---\n${content}`);
        }
      }
    }

    const planTimeout = (args.timeoutMs && !Number.isNaN(args.timeoutMs)) ? args.timeoutMs : PLANNING_TIMEOUT_MS;
    let yaml = "";
    if (tier === "csuite" || tier === "director") {
      const pass1Prompt = buildCouncilProposersPrompt(tier, args.area, args.manifestDir);
      const pass1Message = [
        ...parts,
        `\nRun the ${tier} proposer deliberation. Do NOT synthesize final YAML yet.`,
        ...(args.area ? [`Functional area: ${args.area}`] : []),
      ].join("\n\n");
      const pass1Tools = args.tools || (tier === "director" ? "Bash" : "");
      const pass1Effort = tier === "director" ? "high" : null;
      const pass1Result = await callClaude(args.model, pass1Prompt, pass1Message, 12000, planTimeout, pass1Tools, pass1Effort);
      if (pass1Result.error) {
        console.log(`err:api:pass1:${pass1Result.error}`);
        process.exit(1);
      }

      const pass2Model = tier === "csuite" ? "csuite_critic_pass" : "director_critic_pass";
      const pass2Prompt = buildCouncilCritiquePrompt(tier, args.area, args.manifestDir);
      const pass2Message = [
        "--- PROPOSER DELIBERATION OUTPUT ---",
        pass1Result.text,
        "--- ORIGINAL INPUTS ---",
        ...parts,
        `\nRun Critic+Synthesizer and produce the final ${tier} YAML artifact.`,
        ...(args.area ? [`Functional area: ${args.area}`] : []),
      ].join("\n\n");
      const pass2Tools = args.tools || (tier === "director" ? "Bash" : "");
      const pass2Effort = (tier === "director" && process.env.HPC_DIRECTOR_EFFORT === "max") ? "max" : (tier === "director" ? "high" : null);
      const pass2Result = await callClaude(pass2Model, pass2Prompt, pass2Message, tier === "csuite" ? 16000 : 12000, planTimeout, pass2Tools, pass2Effort);
      if (pass2Result.error) {
        console.log(`err:api:pass2:${pass2Result.error}`);
        process.exit(1);
      }
      yaml = extractYAML(pass2Result.text);
    } else {
      systemPrompt = buildCouncilPrompt(tier, args.area, args.manifestDir);
      parts.push(`\nRun the ${tier} council deliberation and produce the synthesized output.`);
      if (args.area) parts.push(`Functional area: ${args.area}`);
      userMessage = parts.join("\n\n");
      maxTokens = 12000;
      const effort = "high";
      const planTools = args.tools || "Bash";
      const result = await callClaude(args.model, systemPrompt, userMessage, maxTokens, planTimeout, planTools, effort);
      if (result.error) {
        console.log(`err:api:${result.error}`);
        process.exit(1);
      }
      yaml = extractYAML(result.text);
    }

    await reviewCouncilOutput(args.persona, args.outputDir || ".", yaml, planTimeout);
    const outFile = writeCouncilArtifacts(yaml, args.outputDir || ".", args.persona);
    console.log("ok");

  // ── EXECUTION PHASE ──
  } else if (args.phase === "execution") {
    const persona = loadPersona(args.persona);
    if (!persona) {
      console.log(`err:unknown persona: ${args.persona}`);
      process.exit(1);
    }

    systemPrompt = persona;
    
    // Build worker payload
    const parts = [];
    let taskFilePath = null;
    let taskId = null;
    if (args.taskFile && fs.existsSync(args.taskFile)) {
      const taskContent = fs.readFileSync(args.taskFile, "utf-8");
      parts.push(`--- TASK SPECIFICATION ---\n${taskContent}`);
      const fpMatch = taskContent.match(/^file_path:\s*"?([^"\n]+)"?/m);
      if (fpMatch) taskFilePath = fpMatch[1].trim();
      const idMatch = taskContent.match(/^task_id:\s*"?([^"\n]+)"?/m);
      if (idMatch) taskId = idMatch[1].trim();
    }
    if (args.contractsDir) {
      // Only include contracts referenced by the task
      const taskContent = args.taskFile ? fs.readFileSync(args.taskFile, "utf-8") : "";
      const contracts = readDir(args.contractsDir, ".yaml");
      for (const [name, content] of Object.entries(contracts)) {
        const contractId = name.replace(".yaml", "");
        if (taskContent.includes(contractId)) {
          parts.push(`--- CONTRACT: ${contractId} ---\n${content}`);
        }
      }
    }

    const cmt = commentPrefixFor(taskFilePath);
    const isMd = !!(taskFilePath && /\.(md|mdx|markdown)$/i.test(taskFilePath));
    const isHtmlLike = !!(taskFilePath && /\.(html?|xml|svg|vue)$/i.test(taskFilePath));
    // JSON has NO comment syntax — a frontmatter/synopsis block makes the file
    // invalid JSON (e.g. package.json → npm EJSONPARSE). Emit pure content.
    const isJson = !!(taskFilePath && /\.json$/i.test(taskFilePath));

    let frontmatterInstruction;
    if (isJson) {
      frontmatterInstruction = `This file is JSON, which has NO comment syntax. Do NOT add any frontmatter or manifest header — output ONLY the raw, valid JSON document (starting with \`{\` or \`[\`). Any \`#\`/\`//\` lines would make it invalid JSON.`;
    } else if (isMd) {
      frontmatterInstruction = `Open the file with a YAML frontmatter block using raw \`---\` delimiters (canonical Markdown frontmatter). Format:\n---\ntask_id: <from spec>\nfile_path: ${taskFilePath}\n# ...remaining fields\n---`;
    } else if (isHtmlLike) {
      frontmatterInstruction = `Open the file with a YAML frontmatter block wrapped in an HTML/XML comment. Format:\n<!--\n---\ntask_id: <from spec>\nfile_path: ${taskFilePath}\n# ...remaining fields\n---\n-->`;
    } else {
      frontmatterInstruction = `Open the file with a YAML frontmatter block written as language-appropriate LINE COMMENTS (this file uses \`${cmt}\`). Every manifest line MUST begin with \`${cmt} \`. Format:\n${cmt} ---\n${cmt} task_id: <from spec>\n${cmt} file_path: ${taskFilePath}\n${cmt} # ...remaining fields\n${cmt} ---`;
    }

    const synopsisInstruction = isJson
      ? `Skip the synopsis block — JSON does not support comments. Output only valid JSON.`
      : cmt
      ? `Immediately after the frontmatter, include a SYNOPSIS comment block mapping line ranges to logical sections. Example:\n${cmt} SYNOPSIS\n${cmt} L1-L20: frontmatter\n${cmt} L22-L35: imports\n${cmt} L37-L80: types`
      : `Skip the synopsis block — this file format does not support comments.`;

    const fields = `task_id, group_id, epic_id, file_path, artifact_type, contracts_produced (list), contracts_consumed (list), depends_on (list), generated_by (your model id), generated_at (ISO 8601 UTC timestamp)`;

    parts.push(`Implement the task exactly as specified.

OUTPUT RULES — your entire response is written verbatim to ${taskFilePath || "the target file"}:
1. Output ONLY the raw file contents. The first character of your response must be the first character of the file.
2. DO NOT wrap the output in markdown code fences. No \`\`\`python, no \`\`\`rust, no \`\`\` of any kind.
3. DO NOT prepend prose ("I will…", "Here is…", "Let me…", "Based on…"). Begin directly with the frontmatter.
4. ${frontmatterInstruction}
   The frontmatter is the per-file manifest — kept under git, used by downstream validators to load context without re-reading the task spec. Required fields: ${fields}. Copy values verbatim from the task spec where available.
5. ${synopsisInstruction}
6. After the file contents, on its own final line, output ONLY one of: \`ok\` or \`err:[type]:[description]\`.

The body of your response between line 1 and the final status line is what gets saved. Treat any deviation from these rules as a task failure.`);

    // Task-specific deliverables checklist (M3.5 §3.5.4) — grounds the generic
    // persona checklist in THIS task's exact produced/consumed symbols.
    const checklist = buildDeliverablesChecklist(args.taskFile);
    if (checklist) parts.push(checklist);

    // Bind cross-file imports to the canonical module-paths map (prevents
    // orphan-import drift between worker-generated files).
    const importBlock = buildImportBindingBlock(args.taskFile, args.modulePaths);
    if (importBlock) parts.push(importBlock);

    // Bind TEST artifacts to the EXACT consumed-contract surface (prevents the
    // test↔contract drift class: inventing members / wrong arity). No-op for
    // non-test tasks, so non-test worker prompts are unchanged.
    const surfaceBlock = buildSurfaceBindingBlock(args.taskFile, args.contractsDir);
    if (surfaceBlock) parts.push(surfaceBlock);

    userMessage = parts.join("\n\n");
    maxTokens = 8000;

    const result = await callClaude(args.model, systemPrompt, userMessage, maxTokens);

    if (result.error) {
      // Worker subprocess crashed (non-zero exit / timeout / no structured
      // output). Capture stderr+stdout to wiki/worker-crashes/ and classify
      // crash_reason so the failure is diagnosable (M3 §3.2). Exit 0 with a
      // structured `err:exec:<crash_reason>:...` line so the orchestrator's
      // worker-err event carries the reason (a non-zero exit would mask it
      // behind the spawner's generic "Command failed" message).
      const crashReason = classifyCrash(result.stdout, result.stderr, result.status, result.timedOut);
      const crashFile = captureCrash(taskId, crashReason, result.status, result.stdout, result.stderr, result.timedOut);
      const detail = String(result.stderr || result.stdout || result.error || "").slice(0, 160).replace(/\s+/g, " ").trim();
      const ref = crashFile ? ` crash_log=${path.basename(crashFile)}` : "";
      console.log(`err:exec:${crashReason}:${detail}${ref}`);
      process.exit(0);
    }

    // Extract status line and file content
    const text = result.text.trim();
    const lines = text.split("\n");
    const lastLine = lines[lines.length - 1].trim();

    let body, status;
    if (lastLine === "ok" || lastLine.startsWith("err:")) {
      body = lines.slice(0, -1).join("\n");
      status = lastLine;
    } else {
      // No clear status line — assume ok and treat full text as body.
      body = text;
      status = "ok";
    }

    if (status === "ok" && args.outputFile) {
      const cleaned = cleanWorkerOutput(body, args.outputFile);
      const outDir = path.dirname(args.outputFile);
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(args.outputFile, cleaned);
    }
    console.log(status);

  // ── VALIDATION PHASE ──
  } else if (args.phase === "validation") {
    const persona = loadPersona(args.persona);
    if (!persona) {
      console.log(`err:unknown persona: ${args.persona}`);
      process.exit(1);
    }

    systemPrompt = persona;
    
    const parts = [];
    if (args.validateFile && fs.existsSync(args.validateFile)) {
      parts.push(`--- FILE TO VALIDATE ---\n${fs.readFileSync(args.validateFile, "utf-8")}`);
    }
    if (args.taskFile && fs.existsSync(args.taskFile)) {
      parts.push(`--- TASK SPECIFICATION ---\n${fs.readFileSync(args.taskFile, "utf-8")}`);
    }
    if (args.contractsDir) {
      const taskContent = args.taskFile ? fs.readFileSync(args.taskFile, "utf-8") : "";
      const contracts = readDir(args.contractsDir, ".yaml");
      for (const [name, content] of Object.entries(contracts)) {
        const contractId = name.replace(".yaml", "");
        if (taskContent.includes(contractId)) {
          parts.push(`--- CONTRACT: ${contractId} ---\n${content}`);
        }
      }
    }
    for (const depTask of args.dependentTasks) {
      if (fs.existsSync(depTask)) {
        parts.push(`--- DEPENDENT TASK: ${path.basename(depTask)} ---\n${fs.readFileSync(depTask, "utf-8")}`);
      }
    }
    parts.push([
      "",
      "Validate the file against the task specification and contracts.",
      "",
      "BINDING CONTRACT CHECKS (mandatory — perform every one, then return a single status line):",
      "",
      "  0. NON-CODE ARTIFACT GATE (apply FIRST):",
      "     If this file is NOT executable source that defines named, parseable exports — i.e. its",
      "     artifact_type is SQL_DDL / MIGRATION / SCRIPT / SHELL / CONFIG / SCHEMA, OR its extension",
      "     is .sql/.sh/.bash/.prisma/.toml/.yaml/.env, OR it is a .gitkeep/placeholder — then the",
      "     PRODUCER check (step 1) does NOT apply. Such files satisfy a contract via DDL statements,",
      "     exported env vars, shell functions, table/migration presence, or naming CONVENTIONS — not",
      "     via code symbols a parser can bind. For these, treat PRODUCER as ok (only sanity-check the",
      "     file is non-empty and plausibly does what the task asks) and NEVER emit",
      "     producer_symbol_name_mismatch / producer_symbol_signature_mismatch. This mirrors",
      "     producer-symbol-check.js returning `ok:stack-not-supported` for non-TS/PY files.",
      "",
      "  1. PRODUCER (local — always runnable from this file alone; SKIP if step 0 applies):",
      "     For every {contract_id, implements: [...]} entry in the task's `contracts_produced`,",
      "     verify the file actually defines each implements[] symbol with a signature matching",
      "     that symbol's entry in the contract's `surface:` block (exact name, parameter names,",
      "     parameter types, return type, async/sync). Aliasing forbidden — `list_jobs` is NOT",
      "     `list`. Failure category: err:contracts:producer_symbol_name_mismatch",
      "",
      "  2. CONSUMER (local — always runnable from this file alone):",
      "     For every {contract_id, invokes: [...]} entry in the task's `contracts_consumed`,",
      "     verify every call the file makes to a symbol from that contract appears in invokes[]",
      "     AND in the contract's `surface:`. A call to `db.list_jobs()` when CONTRACT-DB-02's",
      "     surface only lists `list` is err:contracts:consumer_invokes_unlisted_symbol.",
      "",
      "  3. SYMMETRY (DEFERRED — do NOT perform here):",
      "     Whether some OTHER task actually delivers/consumes the symbols this task declares is",
      "     a cross-task invariant the orchestrator checks when both sides reach COMPLETE.",
      "     Never fail this task because its counterpart's file isn't done — that is an",
      "     orchestrator bug. If you find yourself wanting to fail because you can't see a",
      "     peer's output: return ok for the local checks instead.",
      "",
      "Improvisation is the failure mode being caught. If a contract surface seems insufficient,",
      "that is the worker's escalation responsibility, not yours to interpret — flag the local",
      "violation and let the fork pipeline handle it.",
      "",
      "Output ONLY a single line: `ok` or `err:[category]:[description]`. No prose."
    ].join("\n"));
    
    userMessage = parts.join("\n\n");
    maxTokens = 2000;

    const result = await callClaude(args.model, systemPrompt, userMessage, maxTokens);
    
    if (result.error) {
      console.log(`err:api:${result.error}`);
      process.exit(1);
    }

    // Extract just the status
    const status = result.text.trim().split("\n").pop().trim();
    if (status === "ok" || status.startsWith("err:")) {
      console.log(status);
    } else {
      console.log(`err:unexpected_response:${status.slice(0, 100)}`);
    }

  // ── ESCALATION PHASE ──
  } else if (args.phase === "escalation") {
    const persona = loadPersona(args.persona);
    if (!persona) {
      console.log(`err:unknown persona: ${args.persona}`);
      process.exit(1);
    }

    systemPrompt = persona;
    
    const parts = [];
    if (args.escalationEnvelope && fs.existsSync(args.escalationEnvelope)) {
      parts.push(`--- ESCALATION ENVELOPE ---\n${fs.readFileSync(args.escalationEnvelope, "utf-8")}`);
    }
    if (args.taskFile && fs.existsSync(args.taskFile)) {
      parts.push(`--- TASK SPECIFICATION ---\n${fs.readFileSync(args.taskFile, "utf-8")}`);
    }
    if (args.manifestDir) {
      // Include only relevant contracts referenced in the envelope
      const envelope = fs.readFileSync(args.escalationEnvelope, "utf-8");
      const contracts = readDir(path.join(args.manifestDir, "contracts"), ".yaml");
      for (const [name, content] of Object.entries(contracts)) {
        if (envelope.includes(name.replace(".yaml", ""))) {
          parts.push(`--- CONTRACT: ${name} ---\n${content}`);
        }
      }
    }
    parts.push("\nResolve this escalation. Output your decision as YAML, then on the final line: ok or err:escalate_to_director");
    
    userMessage = parts.join("\n\n");
    maxTokens = 4000;

    const result = await callClaude(args.model, systemPrompt, userMessage, maxTokens);
    
    if (result.error) {
      console.log(`err:api:${result.error}`);
      process.exit(1);
    }

    const text = result.text.trim();
    const lines = text.split("\n");
    const lastLine = lines[lines.length - 1].trim();

    // Backstop: if the model returned pure YAML (ignoring the terminal-token
    // instruction), inspect the body for `escalate_to_director: true` so we
    // never silently fall through to "ok" and trigger an infinite requeue.
    const hasTerminalToken = lastLine === "ok" || lastLine.startsWith("err:");
    const yamlBody = hasTerminalToken ? lines.slice(0, -1).join("\n") : text;
    const escalateFlag = /^\s*escalate_to_director\s*:\s*true\b/m.test(yamlBody);

    // Write the decision to the escalation directory
    if (args.escalationEnvelope) {
      const decisionFile = args.escalationEnvelope.replace(".yaml", "-decision.yaml");
      fs.writeFileSync(decisionFile, extractYAML(yamlBody));
    }

    if (escalateFlag) {
      console.log("err:escalate_to_director");
    } else if (hasTerminalToken) {
      console.log(lastLine);
    } else {
      // No terminal token AND no escalate flag — protocol violation; surface
      // as an error rather than silently requeueing.
      console.log("err:escalation_handler_no_terminal_token");
    }

  // ── RETRY-UPDATE PHASE (surgical edit driven by producer-symbol-check) ──
  // Same coder persona, but a TIGHT instruction: apply ONLY the deterministically
  // located fixes (rename emitted symbol → the EXACT contract name + its in-file
  // references) and change nothing else. Minimal context (the file + the issues),
  // not the full generative task prompt.
  } else if (args.phase === "retry-update") {
    // TOOL-ONLY surgical repair. The validator already located the issue
    // (from/to/line); the LLM only picks the STRATEGY (rename-at-line vs
    // re-export) and applies it via edit-ops.js. It gets NO ability to emit a
    // file or freeform-edit ("no nano") — only the edit-ops tool via Bash. That
    // structurally prevents frontmatter loss / unrelated rewrites / check-gaming.
    if (!args.outputFile || !fs.existsSync(args.outputFile)) {
      console.log(`err:retry_update_no_output_file:${args.outputFile || ""}`); process.exit(1);
    }
    let issuesDoc = {};
    if (args.issues && fs.existsSync(args.issues)) {
      try { issuesDoc = JSON.parse(fs.readFileSync(args.issues, "utf-8")); } catch {}
    }
    const issues = Array.isArray(issuesDoc.issues) ? issuesDoc.issues : [];
    if (issues.length === 0) { console.log("ok:no_issues_to_update"); process.exit(0); }

    const taskId = args.taskFile && fs.existsSync(args.taskFile)
      ? ((fs.readFileSync(args.taskFile, "utf-8").match(/^task_id:\s*"?([^"\n]+)"?/m) || [])[1] || "").trim()
      : "";
    const skillDir = path.resolve(__dirname, "..");
    const editOps = path.join(skillDir, "scripts", "edit-ops.js");
    const absFile = path.resolve(args.outputFile);
    const current = fs.readFileSync(args.outputFile, "utf-8");

    systemPrompt = [
      "You are a surgical code-fixer. You fix producer-symbol mismatches that have ALREADY been located",
      "for you (file, wrong name, required name, line). You make changes ONLY by calling the edit-ops tool",
      "via Bash — you do NOT write files, output code, or use any other editor. The contract surface is",
      "authoritative: the file must EXPORT the exact required symbol name.",
      "",
      "For EACH located issue choose exactly one strategy and run the matching command:",
      `  A) RENAME (the symbol is simply mis-named): node ${editOps} rename-symbol --file ${absFile} --from <found> --to <expected> --line <line>`,
      `  B) RE-EXPORT (the required name is a DIFFERENT existing thing — e.g. the file has`,
      `     'class ConfigStore implements IConfigStore' where IConfigStore is an imported interface; renaming`,
      `     would collide): node ${editOps} add-export --file ${absFile} --statement \"export { <expected> } from '<source>';\"`,
      "Prefer (A) only when <found> is genuinely just the wrong name for the SAME symbol. If renaming would",
      "create a name collision or a self-referential declaration, use (B). Never collide.",
      "After applying the edits, your FINAL line must be exactly 'ok' or 'err:<reason>'. No other prose.",
    ].join("\n");

    const issueLines = issues.map(i =>
      `  - found="${i.found}" expected="${i.expected}" line=${i.line} kind=${i.kind || "?"} contract=${i.contract_id || "?"} | ${String(i.line_content || "").trim()}`
    ).join("\n");

    userMessage = [
      `Apply edit-ops to ${absFile}.`,
      `\n--- LOCATED ISSUES (deterministic; use these exact from/to/line) ---\n${issueLines}`,
      `\n--- CURRENT FILE (context only — DO NOT reproduce it; edit via edit-ops) ---\n${current}`,
    ].join("\n");
    maxTokens = 4000;

    // Bash tool so the worker can invoke edit-ops.js (the ONLY edit path).
    const result = await callClaude(args.model, systemPrompt, userMessage, maxTokens, undefined, "Bash");
    if (result.error) {
      const crashReason = classifyCrash(result.stdout, result.stderr, result.status, result.timedOut);
      captureCrash(taskId, crashReason, result.status, result.stdout, result.stderr, result.timedOut);
      console.log(`err:exec:${crashReason}:${String(result.error).slice(0, 160)}`);
      process.exit(0);
    }
    // The file was mutated by the worker's edit-ops calls; we do NOT write it.
    const status = (result.text || "").trim().split("\n").pop().trim();
    console.log(status === "ok" || status.startsWith("err:") ? status : "ok");

  // ── FREEFORM PHASE (build-a-prompt, get-text-back; no council persona) ──
  // A thin "produce text from a prompt file" path so other scripts route their
  // model calls through subagent.js (the single claude entry point) instead of
  // re-spawning the CLI. Used by e2e-generate.js. Writes the cleaned text to
  // --output-file and prints `ok:freeform` / `err:...`.
  } else if (args.phase === "freeform") {
    if (!fs.existsSync(args.promptFile)) {
      console.log(`err:prompt_file_not_found:${args.promptFile}`); process.exit(1);
    }
    const prompt = fs.readFileSync(args.promptFile, "utf-8");
    systemPrompt = "You produce exactly the artifact the prompt asks for. Output only the artifact — no preamble, no explanation, no surrounding prose.";
    maxTokens = 16000;

    const result = await callClaude(args.model, systemPrompt, prompt, maxTokens);
    if (result.error) {
      console.log(`err:api:${result.error}`); process.exit(1);
    }
    const cleaned = cleanWorkerOutput(result.text || "", args.outputFile);
    if (!cleaned.trim()) {
      console.log("err:empty_output"); process.exit(1);
    }
    fs.mkdirSync(path.dirname(path.resolve(args.outputFile)), { recursive: true });
    fs.writeFileSync(args.outputFile, cleaned);
    console.log(`ok:freeform:${args.outputFile}`);

  } else {
    console.log(`err:unknown phase: ${args.phase}`);
    process.exit(1);
  }
}

// Export pure helpers for unit testing. The main entrypoint only fires when
// invoked as a script (`node subagent.js …`), not when required from a test.
module.exports = { cleanWorkerOutput, commentPrefixFor, buildDeliverablesChecklist, classifyCrash, buildCouncilPrompt, mintBlock, manifestAwarenessBlock, buildImportBindingBlock, buildSurfaceBindingBlock, isTestArtifact };

if (require.main === module) {
  main().catch(e => {
    console.log(`err:uncaught:${e.message}`);
    process.exit(1);
  });
}
