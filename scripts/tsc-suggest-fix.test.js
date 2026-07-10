const test = require("node:test");
const assert = require("node:assert");
const { parseTscSuggestions, applyFix } = require("./tsc-suggest-fix.js");

// ── H3: quoted-literal suggestion (sameSite "Lax" → "lax"), TS2769 ──
// TS wraps these onto indented continuation lines; the parser must join them.
const TS2769_BLOCK = `src/server/plugins/facebook-login/oauth-start.route.ts(103,38): error TS2769: No overload matches this call.
  Overload 1 of 3, '(name: string, val: string, options: CookieOptions): Response', gave the following error.
    Argument of type '{ sameSite: "Lax"; }' is not assignable to parameter of type 'CookieOptions'.
      Types of property 'sameSite' are incompatible.
        Type '"Lax"' is not assignable to type 'boolean | "strict" | "lax" | "none" | undefined'. Did you mean '"lax"'?`;

test("parse: TS2769 quoted-literal → literal handler Lax→lax", () => {
  const diags = parseTscSuggestions(TS2769_BLOCK);
  assert.equal(diags.length, 1);
  const d = diags[0];
  assert.equal(d.code, "TS2769");
  assert.equal(d.line, 103);
  assert.equal(d.handler, "literal");
  assert.equal(d.from, "Lax");
  assert.equal(d.to, "lax");
});

test("apply: literal rename of cookie sameSite value on its line", () => {
  const content = [
    "line1",
    "line2",
    'res.cookie("fb_state", state, { httpOnly: true, sameSite: "Lax", secure: true });',
  ].join("\n");
  const diag = { handler: "literal", from: "Lax", to: "lax", line: 3 };
  const r = applyFix(diag, content);
  assert.ok(!r.error, r.error);
  assert.match(r.content, /sameSite: "lax"/);
  assert.doesNotMatch(r.content, /"Lax"/);
});

// ── H1: TS2613 default import where only named export exists ──
const TS2613 = `src/ui/components/__tests__/AdminConfigPanel.test.tsx(33,8): error TS2613: Module '"/abs/path/AdminConfigPanel"' has no default export. Did you mean to use 'import { AdminConfigPanel } from "/abs/path/AdminConfigPanel"' instead?`;

test("parse: TS2613 → default-import handler, named symbol extracted", () => {
  const diags = parseTscSuggestions(TS2613);
  assert.equal(diags.length, 1);
  assert.equal(diags[0].handler, "default-import");
  assert.equal(diags[0].to, "AdminConfigPanel");
});

test("apply: default→named import preserves the original specifier", () => {
  const content = [
    "import React from 'react';",
    "import AdminConfigPanel from '../AdminConfigPanel';",
  ].join("\n");
  const diag = { handler: "default-import", to: "AdminConfigPanel", line: 2 };
  const r = applyFix(diag, content);
  assert.ok(!r.error, r.error);
  // Original RELATIVE specifier kept (not TS's absolute-path suggestion).
  assert.match(r.content, /import \{ AdminConfigPanel \} from '\.\.\/AdminConfigPanel';/);
  // React default import untouched.
  assert.match(r.content, /import React from 'react';/);
});

test("apply: mixed default+named import folds the default into the named group", () => {
  const content = "import AdminConfigPanel, { AdminConfigPanelProps } from '../AdminConfigPanel';";
  const diag = { handler: "default-import", to: "AdminConfigPanel", line: 1 };
  const r = applyFix(diag, content);
  assert.ok(!r.error, r.error);
  assert.match(r.content, /import \{ AdminConfigPanel, AdminConfigPanelProps \} from '\.\.\/AdminConfigPanel';/);
});

test("apply: literal defined away from the reported line → unambiguous file-wide fallback", () => {
  // TS reports the cookie() call site, but sameSite: "Lax" is in the options obj above.
  const content = [
    "const cookieOptions = {",
    '  sameSite: "Lax",',
    "  secure: true,",
    "};",
    "res.cookie('OAUTH_STATE', state, cookieOptions);",
  ].join("\n");
  const diag = { handler: "literal", from: "Lax", to: "lax", line: 5 }; // reported at call site
  const r = applyFix(diag, content);
  assert.ok(!r.error, r.error);
  assert.match(r.content, /sameSite: "lax"/);
  assert.match(r.summary, /file-wide/);
});

test("apply: ambiguous file-wide token (>1 occurrence, none on reported line) is skipped", () => {
  const content = [
    "const a = Foo;",
    "const b = Foo;",
    "doThing();", // reported line, no Foo
  ].join("\n");
  const diag = { handler: "rename", from: "Foo", to: "Bar", line: 3 };
  const r = applyFix(diag, content);
  assert.ok(r.error, "must not guess between multiple occurrences");
  assert.match(r.error, /ambiguous/);
});

// ── H2: identifier rename suggestion ──
test("parse: TS2551 property typo → rename handler", () => {
  const out = `src/foo.ts(10,5): error TS2551: Property 'lenght' does not exist on type 'string[]'. Did you mean 'length'?`;
  const diags = parseTscSuggestions(out);
  assert.equal(diags[0].handler, "rename");
  assert.equal(diags[0].from, "lenght");
  assert.equal(diags[0].to, "length");
});

test("parse: TS2552 cannot-find-name → rename handler", () => {
  const out = `src/foo.ts(4,1): error TS2552: Cannot find name 'consoel'. Did you mean 'console'?`;
  const diags = parseTscSuggestions(out);
  assert.equal(diags[0].handler, "rename");
  assert.equal(diags[0].from, "consoel");
  assert.equal(diags[0].to, "console");
});

// ── Bucket C must NOT be touched: negative-test fixtures with no suggestion ──
test("parse: TS2322 invalid-literal WITHOUT a suggestion is left unhandled (SKIP)", () => {
  const out = `src/server/plugins/facebook-login/__tests__/config.route.test.ts(286,7): error TS2322: Type '"invalid"' is not assignable to type '"default" | "dark" | "light"'.`;
  const diags = parseTscSuggestions(out);
  assert.equal(diags.length, 1);
  assert.equal(diags[0].handler, null, "no 'Did you mean' → must not be auto-fixed");
});

test("parse: union-narrowing TS2339 without suggestion stays unhandled", () => {
  const out = `src/lib/__tests__/account-resolver.test.ts(70,21): error TS2339: Property 'user' does not exist on type 'AccountResolutionResult'.`;
  const diags = parseTscSuggestions(out);
  assert.equal(diags[0].handler, null);
});

test("parse: multiple diagnostics, mixed handled/unhandled", () => {
  const out = [TS2769_BLOCK, TS2613].join("\n");
  const diags = parseTscSuggestions(out);
  assert.equal(diags.length, 2);
  assert.equal(diags.filter(d => d.handler).length, 2);
});

test("apply: rename on a line that lacks the symbol returns no_match (never silently wrong)", () => {
  const content = "const x = 1;\nconst y = 2;";
  const diag = { handler: "rename", from: "missing", to: "present", line: 1 };
  const r = applyFix(diag, content);
  assert.ok(r.error, "expected an error when the from-symbol is absent");
});
