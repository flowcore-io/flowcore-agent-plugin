#!/usr/bin/env node
/**
 * Validates the Flowcore Agent Plugin package.
 *
 * Checks, per the PRD's CI requirements:
 *   FR-1  manifest presence, shape, and Agent Plugins 1.0.0 schema URL
 *   FR-1  skill layout and Agent Skills frontmatter
 *   FR-1  mcp.json shape and transport
 *   FR-1  path containment and symlink safety
 *   SEC   no credentials in tracked package files
 *   SEC   no private workspace identifiers or internal URLs
 *   IAM   every concrete FRN in a skill code block is valid for Flowcore IAM
 *
 * No dependencies. Node 20+.
 *
 * Exit 0 = pass (warnings allowed), 1 = at least one error.
 */

import { readFileSync, readdirSync, lstatSync, realpathSync, existsSync } from "node:fs";
import { join, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

const PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
const VALID_TRANSPORTS = ["stdio", "streamable-http", "sse"];

// Claude Code reads its own manifests and uses "http" where Agent Plugins says
// "streamable-http". Supporting both clients means shipping both files, so the
// duplication is deliberate and guarded by a parity check below.
const CLAUDE_DIR = ".claude-plugin";
const CLAUDE_MCP = ".mcp.json";
const CLAUDE_TRANSPORTS = ["stdio", "http", "sse"];
// An OAuth client_id is a public identifier, not a credential, so it may be
// packaged. Anything that could carry a secret may not.
const CLAUDE_OAUTH_PUBLIC_KEYS = new Set(["clientId", "callbackPort", "scopes"]);
// Exactly what the Flowcore MCP OAuth client can grant. Omitting the list makes
// Claude Code request every advertised scope, which Keycloak can reject.
const CLAUDE_REQUIRED_OAUTH_SCOPES = [
  "openid",
  "profile",
  "email",
  "flowcore_user",
  "offline_access",
];
const ALLOWED_MANIFEST_KEYS = new Set([
  "$schema", "name", "version", "description", "author",
  "homepage", "repository", "license", "keywords", "extensions",
]);

const errors = [];
const warnings = [];
const passes = [];

const fail = (check, msg) => errors.push(`${check}: ${msg}`);
const warn = (check, msg) => warnings.push(`${check}: ${msg}`);
const pass = (msg) => passes.push(msg);

const read = (p) => readFileSync(join(ROOT, p), "utf8");
const readJson = (p) => JSON.parse(read(p));

/**
 * Collects every string in a nested structure that looks like a plugin-relative
 * path, so extension-declared assets can be checked for existence.
 */
function collectPluginRelativePaths(node, acc = []) {
  if (typeof node === "string") {
    if (node.startsWith("./") || /^\.\.?\//.test(node)) acc.push(node);
    return acc;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectPluginRelativePaths(item, acc);
    return acc;
  }
  if (node && typeof node === "object") {
    for (const value of Object.values(node)) collectPluginRelativePaths(value, acc);
  }
  return acc;
}

/** Recursively walk the repo, skipping VCS and ignored build dirs. */
function walk(dir, acc = []) {
  const SKIP = new Set([".git", "node_modules", "dist"]);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else acc.push(full);
  }
  return acc;
}

// ── FR-1: manifest ───────────────────────────────────────────────────────────
function validateManifest() {
  const CHECK = "plugin.json";

  if (!existsSync(join(ROOT, "plugin.json"))) {
    fail(CHECK, "missing at package root");
    return null;
  }

  let m;
  try {
    m = readJson("plugin.json");
  } catch (e) {
    fail(CHECK, `invalid JSON — ${e.message}`);
    return null;
  }

  if (m.$schema !== PLUGIN_SCHEMA) {
    fail(CHECK, `$schema must be "${PLUGIN_SCHEMA}", found ${JSON.stringify(m.$schema)}`);
  }

  if (typeof m.name !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(m.name)) {
    fail(CHECK, `name must be lowercase alphanumeric with hyphens, found ${JSON.stringify(m.name)}`);
  }

  // Optional in the spec, required by our release process.
  if (typeof m.version !== "string" || !/^\d+\.\d+\.\d+(-[\w.]+)?(\+[\w.]+)?$/.test(m.version)) {
    fail(CHECK, `version must be SemVer, found ${JSON.stringify(m.version)}`);
  }

  for (const field of ["description", "homepage", "repository", "license"]) {
    if (!m[field]) fail(CHECK, `missing required field "${field}"`);
  }

  if (!Array.isArray(m.keywords) || m.keywords.length === 0) {
    warn(CHECK, "no keywords — these aid discovery");
  }

  for (const key of Object.keys(m)) {
    if (!ALLOWED_MANIFEST_KEYS.has(key)) {
      fail(CHECK, `unknown top-level field "${key}"; client-specific metadata belongs under "extensions"`);
    }
  }

  if (m.extensions) {
    for (const key of Object.keys(m.extensions)) {
      if (!key.includes(".")) {
        fail(CHECK, `extension key "${key}" must use a reverse-domain namespace`);
      }
    }

    // Client extensions may reference packaged files (icons, logos). A broken
    // reference ships a plugin that renders without branding, which is exactly
    // the sort of defect that is invisible until a user sees it.
    for (const [ns, value] of Object.entries(m.extensions)) {
      for (const path of collectPluginRelativePaths(value)) {
        if (!path.startsWith("./")) {
          fail(CHECK, `extension "${ns}" path ${JSON.stringify(path)} must be plugin-relative and begin with "./"`);
          continue;
        }
        const resolved = resolve(ROOT, path);
        if (!resolved.startsWith(ROOT + sep)) {
          fail(CHECK, `extension "${ns}" path ${JSON.stringify(path)} escapes the plugin root`);
        } else if (!existsSync(resolved)) {
          fail(CHECK, `extension "${ns}" references missing file ${path}`);
        }
      }
    }
  }

  if (errors.every((e) => !e.startsWith(CHECK))) pass(`${CHECK} conforms to Agent Plugins 1.0.0`);
  return m;
}

// ── FR-1: skills ─────────────────────────────────────────────────────────────
function validateSkills() {
  const CHECK = "skills";
  const skillsDir = join(ROOT, "skills");

  if (!existsSync(skillsDir)) {
    warn(CHECK, "no skills/ directory");
    return;
  }

  const dirs = readdirSync(skillsDir, { withFileTypes: true });

  for (const entry of dirs) {
    if (!entry.isDirectory()) {
      fail(CHECK, `skills/${entry.name} is not a directory; skills must be directories`);
      continue;
    }

    const name = entry.name;
    const skillFile = join(skillsDir, name, "SKILL.md");

    if (!existsSync(skillFile)) {
      fail(CHECK, `skills/${name}/ has no SKILL.md`);
      continue;
    }

    const content = readFileSync(skillFile, "utf8");
    const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);

    if (!fm) {
      fail(CHECK, `skills/${name}/SKILL.md has no YAML frontmatter block`);
      continue;
    }

    // Flat key: value frontmatter is all the Agent Skills spec requires.
    const fields = {};
    for (const line of fm[1].split(/\r?\n/)) {
      const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (kv) fields[kv[1]] = kv[2].trim();
    }

    if (!fields.name) {
      fail(CHECK, `skills/${name}/SKILL.md frontmatter missing required "name"`);
    } else if (fields.name !== name) {
      fail(CHECK, `skills/${name}/SKILL.md name "${fields.name}" does not match its directory`);
    }

    if (!fields.description) {
      fail(CHECK, `skills/${name}/SKILL.md frontmatter missing required "description"`);
    } else if (fields.description.length < 40) {
      warn(CHECK, `skills/${name} description is very short; it should say what the skill does AND when to use it`);
    }

    // Every referenced reference file must exist.
    for (const [, ref] of content.matchAll(/references\/([A-Za-z0-9._-]+\.md)/g)) {
      if (!existsSync(join(skillsDir, name, "references", ref))) {
        fail(CHECK, `skills/${name}/SKILL.md references missing file references/${ref}`);
      }
    }

    pass(`skills/${name} valid`);
  }
}

// ── FR-1: mcp.json ───────────────────────────────────────────────────────────
function validateMcp() {
  const CHECK = "mcp.json";

  if (!existsSync(join(ROOT, "mcp.json"))) {
    warn(CHECK, "not present; the package will ship skills only");
    return;
  }

  let mcp;
  try {
    mcp = readJson("mcp.json");
  } catch (e) {
    fail(CHECK, `invalid JSON — ${e.message}`);
    return;
  }

  if (mcp.$schema !== MCP_SCHEMA) {
    fail(CHECK, `$schema must be "${MCP_SCHEMA}", found ${JSON.stringify(mcp.$schema)}`);
  }

  if (!mcp.mcpServers || typeof mcp.mcpServers !== "object") {
    fail(CHECK, "missing mcpServers object");
    return;
  }

  for (const [name, server] of Object.entries(mcp.mcpServers)) {
    if (!VALID_TRANSPORTS.includes(server.type)) {
      fail(CHECK, `server "${name}" type must be one of ${VALID_TRANSPORTS.join(", ")}, found ${JSON.stringify(server.type)}`);
    }
    if (server.type === "sse") {
      warn(CHECK, `server "${name}" uses deprecated "sse" transport`);
    }

    if (server.type === "stdio") {
      if (!server.command) fail(CHECK, `stdio server "${name}" needs a command`);
      if (typeof server.command === "string" && /[|;&><$`]/.test(server.command)) {
        fail(CHECK, `server "${name}" command looks like a shell string; use an executable plus an args array`);
      }
    } else if (!server.url) {
      fail(CHECK, `server "${name}" (${server.type}) needs a url`);
    } else if (!server.url.startsWith("https://")) {
      fail(CHECK, `server "${name}" url must use https, found ${server.url}`);
    }

    // The core security invariant: no credentials, ever.
    if (server.headers) {
      fail(CHECK, `server "${name}" declares headers; credentials must not be packaged — authentication is client-managed OAuth 2.1`);
    }
    if (server.env) {
      fail(CHECK, `server "${name}" declares env; credential-bearing environment variables must not be packaged`);
    }
  }

  if (errors.every((e) => !e.startsWith(CHECK))) pass(`${CHECK} is URL-only and credential-free`);
}

// ── Claude Code: .mcp.json ───────────────────────────────────────────────────
function validateClaudeMcp() {
  const CHECK = CLAUDE_MCP;

  if (!existsSync(join(ROOT, CLAUDE_MCP))) {
    warn(CHECK, "not present; Claude Code will load skills but no MCP server");
    return;
  }

  let mcp;
  try {
    mcp = readJson(CLAUDE_MCP);
  } catch (e) {
    fail(CHECK, `invalid JSON — ${e.message}`);
    return;
  }

  if (!mcp.mcpServers || typeof mcp.mcpServers !== "object") {
    fail(CHECK, "missing mcpServers object");
    return;
  }

  for (const [name, server] of Object.entries(mcp.mcpServers)) {
    if (!CLAUDE_TRANSPORTS.includes(server.type)) {
      fail(CHECK, `server "${name}" type must be one of ${CLAUDE_TRANSPORTS.join(", ")}, found ${JSON.stringify(server.type)} — Claude Code uses "http", not "streamable-http"`);
    }
    if (server.type !== "stdio") {
      if (!server.url) {
        fail(CHECK, `server "${name}" (${server.type}) needs a url`);
      } else if (!server.url.startsWith("https://")) {
        fail(CHECK, `server "${name}" url must use https, found ${server.url}`);
      }
    }
    if (server.headers) {
      fail(CHECK, `server "${name}" declares headers; credentials must not be packaged`);
    }
    if (server.env) {
      fail(CHECK, `server "${name}" declares env; credential-bearing environment variables must not be packaged`);
    }

    // Claude Code accepts an oauth block here. A client_id is a public
    // identifier and is safe to ship; a client secret or token is not. This
    // fails closed: only explicitly known-public keys are permitted, so a
    // future secret-bearing field cannot slip through by being unrecognised.
    if (server.oauth !== undefined) {
      if (typeof server.oauth !== "object" || server.oauth === null) {
        fail(CHECK, `server "${name}" oauth must be an object`);
      } else {
        for (const key of Object.keys(server.oauth)) {
          if (!CLAUDE_OAUTH_PUBLIC_KEYS.has(key)) {
            fail(CHECK, `server "${name}" oauth.${key} is not a recognised public field; only ${[...CLAUDE_OAUTH_PUBLIC_KEYS].join(", ")} may be packaged. Secrets and tokens must never ship.`);
          }
        }
        if (server.oauth.clientId !== undefined && typeof server.oauth.clientId !== "string") {
          fail(CHECK, `server "${name}" oauth.clientId must be a string`);
        }
        if (!Array.isArray(server.oauth.scopes) ||
            server.oauth.scopes.some((scope) => typeof scope !== "string" || !scope)) {
          fail(CHECK, `server "${name}" oauth.scopes must be an array of non-empty strings`);
        } else if (server.oauth.scopes.length !== CLAUDE_REQUIRED_OAUTH_SCOPES.length ||
                   CLAUDE_REQUIRED_OAUTH_SCOPES.some((scope) => !server.oauth.scopes.includes(scope))) {
          fail(CHECK, `server "${name}" oauth.scopes must contain exactly the supported scopes: ${CLAUDE_REQUIRED_OAUTH_SCOPES.join(", ")}`);
        }
      }
    }
  }

  if (errors.every((e) => !e.startsWith(CHECK))) {
    pass(`${CHECK} declares no credentials (public oauth client id only)`);
  }
}

// ── Parity between the two MCP documents ─────────────────────────────────────
// They cannot be byte-identical because the transport identifiers differ, so
// compare what must agree: which servers exist and where they point. Without
// this, one file could be updated and the other silently left behind.
function validateMcpParity() {
  const CHECK = "mcp-parity";

  if (!existsSync(join(ROOT, "mcp.json")) || !existsSync(join(ROOT, CLAUDE_MCP))) return;

  let a, b;
  try {
    a = readJson("mcp.json").mcpServers ?? {};
    b = readJson(CLAUDE_MCP).mcpServers ?? {};
  } catch {
    return; // shape errors already reported by the per-file checks
  }

  const namesA = Object.keys(a).sort();
  const namesB = Object.keys(b).sort();

  if (namesA.join(",") !== namesB.join(",")) {
    fail(CHECK, `mcp.json declares [${namesA}] but ${CLAUDE_MCP} declares [${namesB}]; both clients must be offered the same servers`);
    return;
  }

  for (const name of namesA) {
    if (a[name].url !== b[name].url) {
      fail(CHECK, `server "${name}" points at ${a[name].url} in mcp.json but ${b[name].url} in ${CLAUDE_MCP}`);
    }
  }

  if (errors.every((e) => !e.startsWith(CHECK))) {
    pass(`mcp.json and ${CLAUDE_MCP} agree on servers and URLs`);
  }
}

// ── Claude Code: plugin and marketplace manifests ────────────────────────────
function validateClaudeManifests(rootManifest) {
  const CHECK = CLAUDE_DIR;

  const pluginPath = join(ROOT, CLAUDE_DIR, "plugin.json");
  const marketPath = join(ROOT, CLAUDE_DIR, "marketplace.json");

  if (!existsSync(pluginPath) && !existsSync(marketPath)) {
    warn(CHECK, "absent; the package will not be installable in Claude Code");
    return;
  }

  if (existsSync(pluginPath)) {
    let p;
    try {
      p = JSON.parse(readFileSync(pluginPath, "utf8"));
    } catch (e) {
      fail(CHECK, `plugin.json invalid JSON — ${e.message}`);
      p = null;
    }
    if (p) {
      if (!p.name) fail(CHECK, "plugin.json missing required \"name\"");
      if (rootManifest && p.name && p.name !== rootManifest.name) {
        fail(CHECK, `plugin.json name "${p.name}" does not match root plugin.json name "${rootManifest.name}"`);
      }
      if (rootManifest && p.version && p.version !== rootManifest.version) {
        fail(CHECK, `plugin.json version "${p.version}" does not match root plugin.json version "${rootManifest.version}"`);
      }
      if (!p.description) warn(CHECK, "plugin.json has no description");
    }
  } else {
    fail(CHECK, `marketplace.json present but ${CLAUDE_DIR}/plugin.json is missing`);
  }

  if (existsSync(marketPath)) {
    let m;
    try {
      m = JSON.parse(readFileSync(marketPath, "utf8"));
    } catch (e) {
      fail(CHECK, `marketplace.json invalid JSON — ${e.message}`);
      m = null;
    }
    if (m) {
      if (!m.name) fail(CHECK, "marketplace.json missing required \"name\"");
      if (!m.owner || !m.owner.name) fail(CHECK, "marketplace.json missing required \"owner.name\"");
      if (!Array.isArray(m.plugins) || m.plugins.length === 0) {
        fail(CHECK, "marketplace.json must list at least one plugin");
      } else {
        for (const entry of m.plugins) {
          if (!entry.name) fail(CHECK, "marketplace.json plugin entry missing \"name\"");
          if (typeof entry.source === "string") {
            const resolved = resolve(ROOT, entry.source);
            if (!resolved.startsWith(ROOT)) {
              fail(CHECK, `marketplace.json plugin "${entry.name}" source ${entry.source} escapes the repository root`);
            } else if (!existsSync(join(resolved, CLAUDE_DIR, "plugin.json"))) {
              fail(CHECK, `marketplace.json plugin "${entry.name}" source ${entry.source} has no ${CLAUDE_DIR}/plugin.json`);
            }
          } else if (!entry.source) {
            fail(CHECK, `marketplace.json plugin "${entry.name}" missing "source"`);
          }
          if (rootManifest && entry.version && entry.version !== rootManifest.version) {
            fail(CHECK, `marketplace.json plugin "${entry.name}" version "${entry.version}" does not match root plugin.json version "${rootManifest.version}"`);
          }
        }
      }
    }
  }

  if (errors.every((e) => !e.startsWith(CHECK))) pass(`${CHECK} manifests valid and consistent with plugin.json`);
}

// ── FR-1: path containment and symlinks ──────────────────────────────────────
function validatePaths() {
  const CHECK = "paths";
  let clean = true;

  for (const file of walk(ROOT)) {
    const rel = relative(ROOT, file);

    if (rel.startsWith("..") || resolve(file) !== join(ROOT, rel)) {
      fail(CHECK, `${rel} resolves outside the plugin root`);
      clean = false;
    }

    if (rel.split(sep).some((seg) => seg === "..")) {
      fail(CHECK, `${rel} contains a parent-directory segment`);
      clean = false;
    }

    if (lstatSync(file).isSymbolicLink()) {
      let target;
      try {
        target = realpathSync(file);
      } catch {
        fail(CHECK, `${rel} is a broken symlink`);
        clean = false;
        continue;
      }
      if (!target.startsWith(ROOT + sep)) {
        fail(CHECK, `${rel} is a symlink escaping the plugin root`);
        clean = false;
      }
    }
  }

  if (clean) pass("all paths contained within the plugin root; no unsafe symlinks");
}

// ── SEC: credentials and private identifiers ─────────────────────────────────
function validateNoSecrets() {
  const CHECK = "secrets";

  const CREDENTIAL_PATTERNS = [
    [/\bsk-[A-Za-z0-9]{16,}/, "OpenAI-style API key"],
    [/\bsk-ant-[A-Za-z0-9-]{16,}/, "Anthropic-style API key"],
    [/\bgh[pousr]_[A-Za-z0-9]{20,}/, "GitHub token"],
    [/\bfc_[A-Za-z0-9]{8,}_[A-Za-z0-9]{8,}/, "Flowcore API key"],
    [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, "JWT"],
    [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, "private key"],
    [/\bAKIA[0-9A-Z]{16}\b/, "AWS access key ID"],
    [/"(?:authorization|client_secret|api_?key|password|bearer)"\s*:\s*"[^"$][^"]{7,}"/i, "hard-coded credential value"],
  ];

  // Private workspace UUIDs must not leak into a public package. Documented
  // discovery/config values are allowlisted.
  const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
  // The one synthetic UUID the skills use in examples. It names nothing real.
  const EXAMPLE_UUIDS = new Set(["3f2c9a1e-7b4d-4c8a-9e21-5d6f0a1b2c3d"]);

  // These files intentionally contain the very patterns being searched for: the
  // pattern definitions themselves, and the negative-case fixtures that prove
  // the scan works. Both are repository-only and excluded from release
  // archives, so neither can leak into a published package.
  const SELF_REFERENTIAL = [
    join("scripts", "validate-package.mjs"),
    join("tests", "smoke", "validator.test.mjs"),
  ];

  const scanned = walk(ROOT).filter((f) => /\.(md|json|ya?ml|mjs|js|ts)$/.test(f));
  let clean = true;

  for (const file of scanned) {
    const rel = relative(ROOT, file);
    if (SELF_REFERENTIAL.includes(rel)) continue;

    const content = readFileSync(file, "utf8");

    for (const [pattern, label] of CREDENTIAL_PATTERNS) {
      if (pattern.test(content)) {
        fail(CHECK, `${rel} appears to contain a ${label}`);
        clean = false;
      }
    }

    for (const match of content.match(UUID) ?? []) {
      if (EXAMPLE_UUIDS.has(match.toLowerCase())) continue;
      fail(CHECK, `${rel} contains a UUID (${match}); private workspace and tenant identifiers must not ship in a public package`);
      clean = false;
    }
  }

  if (clean) pass(`no credentials or private identifiers found in ${scanned.length} files`);
}

// ── IAM: FRNs shown to agents must be valid ──────────────────────────────────
// Flowcore IAM matches the tenant segment by name and every other id by exact
// UUID or "*". A named id is accepted at create time and then never matches,
// so a wrong example in a skill turns into silent "forbidden" errors.
const FRN_TYPES = ["tenant", "data-core", "flow-type", "event-type", "compute", "database", "key", "user", "policy", "role"];
const VALID_FRN = new RegExp(
  `^frn::[a-z0-9-]+:(\\*|(${FRN_TYPES.join("|")})/(\\*|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}))$`
);
const VALID_ACTIONS = new Set(["*", "read", "write", "fetch", "ingest", "sensitive-data-fetch"]);

function validateFrnExamples() {
  const CHECK = "frn";
  const skillsDir = join(ROOT, "skills");
  if (!existsSync(skillsDir)) return;
  let count = 0;

  for (const file of walk(skillsDir).filter((f) => f.endsWith(".md"))) {
    const rel = relative(ROOT, file);
    const content = readFileSync(file, "utf8");
    // Only fenced code blocks: they are what an agent copies. Prose and tables
    // may show invalid FRNs on purpose, as counter-examples.
    for (const [, block] of content.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) {
      const text = block.replace(/\\"/g, '"');
      for (const [frn] of text.matchAll(/frn:[^\s"'`,\])]*/g)) {
        // Templates such as frn::<tenant-name>:<type>/<uuid> and regex source.
        if (/[<[^]/.test(frn)) continue;
        count++;
        if (!VALID_FRN.test(frn)) fail(CHECK, `${rel} shows invalid FRN ${JSON.stringify(frn)} in a code block`);
      }
      for (const [, actions] of text.matchAll(/"action"\s*:\s*(\[[^\]]*\]|"[^"]*")/g)) {
        for (const [, action] of actions.matchAll(/"([^"]*)"/g)) {
          if (!VALID_ACTIONS.has(action)) fail(CHECK, `${rel} shows invalid action ${JSON.stringify(action)} in a code block`);
        }
      }
    }
  }

  if (errors.every((e) => !e.startsWith(CHECK))) pass(`${count} FRN example(s) in skills are valid for Flowcore IAM`);
}

// ── Consistency between manifest and docs ────────────────────────────────────
function validateConsistency(manifest) {
  const CHECK = "consistency";
  if (!manifest) return;

  if (existsSync(join(ROOT, "mcp.json"))) {
    const mcp = readJson("mcp.json");
    const pluginVer = manifest.$schema?.match(/schemas\/([\d.]+)\//)?.[1];
    const mcpVer = mcp.$schema?.match(/schemas\/([\d.]+)\//)?.[1];
    if (pluginVer && mcpVer && pluginVer !== mcpVer) {
      fail(CHECK, `schema version mismatch: plugin.json ${pluginVer} vs mcp.json ${mcpVer}`);
    } else {
      pass("plugin.json and mcp.json schema versions match");
    }

    // Documented endpoints must match what actually ships.
    const authDoc = join(ROOT, "docs", "authentication.md");
    if (existsSync(authDoc)) {
      const doc = readFileSync(authDoc, "utf8");
      for (const server of Object.values(mcp.mcpServers ?? {})) {
        if (server.url && !doc.includes(server.url)) {
          fail(CHECK, `mcp.json url ${server.url} is not documented in docs/authentication.md`);
        }
      }
    }
  }

  if (existsSync(join(ROOT, "LICENSE"))) {
    const license = read("LICENSE");
    if (manifest.license === "MIT" && !license.includes("MIT License")) {
      fail(CHECK, "manifest declares MIT but LICENSE does not look like the MIT license");
    }
  } else {
    fail(CHECK, "no LICENSE file");
  }
}

// ── Run ──────────────────────────────────────────────────────────────────────
console.log(`Validating package at ${ROOT}\n`);

const manifest = validateManifest();
validateSkills();
validateMcp();
validateClaudeMcp();
validateMcpParity();
validateClaudeManifests(manifest);
validatePaths();
validateNoSecrets();
validateFrnExamples();
validateConsistency(manifest);

for (const p of passes) console.log(`  ok      ${p}`);
for (const w of warnings) console.log(`  warn    ${w}`);
for (const e of errors) console.log(`  ERROR   ${e}`);

console.log(
  `\n${passes.length} passed, ${warnings.length} warning(s), ${errors.length} error(s)`
);

if (errors.length > 0) {
  console.error("\nValidation failed.");
  process.exit(1);
}
console.log("Validation passed.");
