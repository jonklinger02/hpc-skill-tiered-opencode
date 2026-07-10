"use strict";
/**
 * models.js — resolve a model token to a concrete { providerID, modelID }.
 *
 * The single indirection behind HPC's cheap/capable model strategy. Every
 * model-spawning script passes whatever it received on `--model` (or
 * `--worker-model`, `--validator-model`, …) through `resolveModel()` before
 * calling callAgent(). A token may be:
 *
 *   • a TIER name        — "cheap" | "standard" | "capable" | "frontier"
 *   • an ASSIGNMENT role — "worker", "csuite_council", "acceptance_judge", …
 *                          (resolved to its tier via models.yaml `assignments:`)
 *   • a "provider/model" string — split on first "/" into { providerID, modelID }
 *   • a literal model id — "claude-…" → wrapped as { providerID: "anthropic", modelID }
 *
 * Config comes from models.yaml at the skill root. If that file is missing or
 * unparseable, the built-in DEFAULTS below apply, so the resolver never throws
 * and a stripped-down checkout still runs.
 */

const fs = require("fs");
const path = require("path");

let yaml = null;
try { yaml = require("js-yaml"); } catch { /* fall back to built-ins */ }

// Built-in fallback — tiers use object form matching models.yaml.
const DEFAULTS = {
  tiers: {
    cheap:    { providerID: "anthropic", modelID: "claude-haiku-4-5" },
    standard: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
    capable:  { providerID: "anthropic", modelID: "claude-opus-4-8" },
    frontier: { providerID: "anthropic", modelID: "claude-fable-5" },
  },
  assignments: {
    worker: "cheap", worker_promoted: "standard", worker_escalated: "capable",
    schema_validator: "cheap", integration_validator: "standard",
    triage: "standard", patch: "cheap",
    engineer_council: "standard", director_council: "standard",
    csuite_council: "frontier", escalation: "capable",
    corpus_filter: "standard", acceptance_extract: "standard",
    e2e_generate: "standard", e2e_chase_tier1: "standard", e2e_chase_tier2: "capable",
    acceptance_judge: "frontier",
    recovery_director: "standard", recovery_csuite: "capable",
  },
};

let _cache = null;

function findConfigPath() {
  // models.yaml lives at the skill root (one level up from scripts/lib).
  const candidates = [
    process.env.HPC_MODELS_FILE,
    path.resolve(__dirname, "..", "..", "models.yaml"),
    path.resolve(process.cwd(), "models.yaml"),
  ].filter(Boolean);
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
  }
  return null;
}

/**
 * Normalize any tier value to { providerID, modelID }.
 * Accepts: already-object, "provider/model" string, or bare "claude-..." string.
 */
function normalizeTierValue(v) {
  if (v && typeof v === "object" && v.providerID && v.modelID) return v;
  if (typeof v === "string") {
    const slash = v.indexOf("/");
    if (slash !== -1) return { providerID: v.slice(0, slash), modelID: v.slice(slash + 1) };
    return { providerID: "anthropic", modelID: v };
  }
  return null;
}

function loadConfig() {
  if (_cache) return _cache;

  const defaultTiers = {};
  for (const [k, v] of Object.entries(DEFAULTS.tiers)) {
    defaultTiers[k] = normalizeTierValue(v);
  }

  let cfg = { tiers: defaultTiers, assignments: DEFAULTS.assignments };

  const p = yaml && findConfigPath();
  if (p) {
    try {
      const parsed = yaml.load(fs.readFileSync(p, "utf-8"));
      if (parsed && typeof parsed === "object") {
        const yamlTiers = {};
        for (const [k, v] of Object.entries(parsed.tiers || {})) {
          const normalized = normalizeTierValue(v);
          if (normalized) yamlTiers[k] = normalized;
        }
        cfg = {
          tiers: { ...defaultTiers, ...yamlTiers },
          assignments: { ...DEFAULTS.assignments, ...(parsed.assignments || {}) },
        };
      }
    } catch { /* keep defaults */ }
  }

  _cache = cfg;
  return cfg;
}

/**
 * Resolve a token to { providerID, modelID }.
 * @param {string} token  tier name, assignment role, "provider/model", or literal claude-… id
 * @param {string} [fallbackTier]  tier to use when token is empty/unresolvable
 * @returns {{ providerID: string, modelID: string }}
 */
function resolveModel(token, fallbackTier = "standard") {
  const cfg = loadConfig();
  const t = (token == null ? "" : String(token)).trim();

  // Literal claude-… id — wrap as anthropic object (back-compat with --model claude-…).
  if (/^(?:us\.)?(?:anthropic\.)?claude[-.]/i.test(t)) {
    return { providerID: "anthropic", modelID: t };
  }

  // "provider/model" string shorthand.
  const slash = t.indexOf("/");
  if (slash !== -1) {
    return { providerID: t.slice(0, slash), modelID: t.slice(slash + 1) };
  }

  // Assignment role → its tier.
  let tier = t;
  if (Object.prototype.hasOwnProperty.call(cfg.assignments, t)) {
    tier = cfg.assignments[t];
  }

  // Tier → { providerID, modelID }.
  if (Object.prototype.hasOwnProperty.call(cfg.tiers, tier)) return cfg.tiers[tier];

  // Unknown / empty token → fallback tier (then built-in standard).
  return cfg.tiers[fallbackTier] || DEFAULTS.tiers[fallbackTier] || DEFAULTS.tiers.standard;
}

/** Resolve a bare tier name to { providerID, modelID } (throws-free; unknown → standard). */
function tierModel(tier) {
  const cfg = loadConfig();
  return cfg.tiers[tier] || cfg.tiers.standard || DEFAULTS.tiers.standard;
}

/** Test/seam hook: drop the cached config so a new models.yaml is re-read. */
function _resetCache() { _cache = null; }

module.exports = { resolveModel, tierModel, loadConfig, _resetCache, DEFAULTS };
