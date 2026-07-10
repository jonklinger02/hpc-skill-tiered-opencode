"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { resolveModel, tierModel, loadConfig } = require("./lib/models.js");

test("tier names resolve to { providerID, modelID } objects", () => {
  assert.deepStrictEqual(resolveModel("cheap"),    { providerID: "anthropic", modelID: "claude-haiku-4-5" });
  assert.deepStrictEqual(resolveModel("standard"), { providerID: "anthropic", modelID: "claude-sonnet-4-6" });
  assert.deepStrictEqual(resolveModel("capable"),  { providerID: "anthropic", modelID: "claude-opus-4-8" });
  assert.deepStrictEqual(resolveModel("frontier"), { providerID: "anthropic", modelID: "claude-fable-5" });
});

test("assignment roles resolve through their tier to { providerID, modelID }", () => {
  assert.deepStrictEqual(resolveModel("worker"),               { providerID: "anthropic", modelID: "claude-haiku-4-5" });   // cheap
  assert.deepStrictEqual(resolveModel("schema_validator"),     { providerID: "anthropic", modelID: "claude-haiku-4-5" });   // cheap
  assert.deepStrictEqual(resolveModel("integration_validator"),{ providerID: "anthropic", modelID: "claude-sonnet-4-6" }); // standard
  assert.deepStrictEqual(resolveModel("csuite_council"),       { providerID: "anthropic", modelID: "claude-fable-5" });    // frontier
  assert.deepStrictEqual(resolveModel("acceptance_judge"),     { providerID: "anthropic", modelID: "claude-fable-5" });    // frontier
  assert.deepStrictEqual(resolveModel("escalation"),           { providerID: "anthropic", modelID: "claude-opus-4-8" });   // capable
});

test("literal claude-... ids are wrapped with providerID anthropic (back-compat)", () => {
  assert.deepStrictEqual(resolveModel("claude-sonnet-4-6"),        { providerID: "anthropic", modelID: "claude-sonnet-4-6" });
  assert.deepStrictEqual(resolveModel("claude-opus-4-6"),          { providerID: "anthropic", modelID: "claude-opus-4-6" });
  assert.deepStrictEqual(resolveModel("claude-haiku-4-5-20251001"),{ providerID: "anthropic", modelID: "claude-haiku-4-5-20251001" });
  assert.deepStrictEqual(resolveModel("claude-fable-5"),           { providerID: "anthropic", modelID: "claude-fable-5" });
});

test('"provider/model" string shorthand splits into { providerID, modelID }', () => {
  assert.deepStrictEqual(resolveModel("openai/gpt-4o"),              { providerID: "openai",     modelID: "gpt-4o" });
  assert.deepStrictEqual(resolveModel("anthropic/claude-sonnet-4-6"),{ providerID: "anthropic", modelID: "claude-sonnet-4-6" });
  assert.deepStrictEqual(resolveModel("opencode-go/deepseek-v4-flash"),{ providerID: "opencode-go", modelID: "deepseek-v4-flash" });
});

test("empty / unknown tokens fall back to the given tier object", () => {
  assert.deepStrictEqual(resolveModel("", "cheap"),             { providerID: "anthropic", modelID: "claude-haiku-4-5" });
  assert.deepStrictEqual(resolveModel(undefined, "capable"),    { providerID: "anthropic", modelID: "claude-opus-4-8" });
  assert.deepStrictEqual(resolveModel("nonsense-token"),        { providerID: "anthropic", modelID: "claude-sonnet-4-6" }); // default fallback = standard
  assert.deepStrictEqual(resolveModel("nonsense-token", "frontier"), { providerID: "anthropic", modelID: "claude-fable-5" });
});

test("config loads tiers (as objects) and assignments from models.yaml", () => {
  const cfg = loadConfig();
  assert.ok(cfg.tiers.cheap && cfg.tiers.frontier);
  assert.deepStrictEqual(cfg.tiers.cheap, { providerID: "anthropic", modelID: "claude-haiku-4-5" });
  assert.strictEqual(cfg.assignments.worker, "cheap");
  assert.strictEqual(cfg.assignments.acceptance_judge, "frontier");
});

test("tierModel resolves a bare tier and defaults unknown to standard", () => {
  assert.deepStrictEqual(tierModel("capable"), { providerID: "anthropic", modelID: "claude-opus-4-8" });
  assert.deepStrictEqual(tierModel("bogus"),   { providerID: "anthropic", modelID: "claude-sonnet-4-6" });
});
