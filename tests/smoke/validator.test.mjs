#!/usr/bin/env node
/**
 * Self-test for scripts/validate-package.mjs.
 *
 * A validator that never fails is indistinguishable from no validator, so each
 * case below breaks the package in one specific way inside a temporary copy and
 * asserts the validator actually rejects it.
 *
 * No dependencies. Node 20+.
 *
 *   node tests/smoke/validator.test.mjs
 */

import { mkdtempSync, cpSync, writeFileSync, readFileSync, rmSync, mkdirSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

/** Runs the validator in `dir`; returns { code, output }. */
function runValidator(dir) {
  try {
    const output = execFileSync("node", [join(dir, "scripts", "validate-package.mjs")], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, output };
  } catch (e) {
    return { code: e.status ?? 1, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

/** Copies the package into a temp dir, applies `mutate`, then validates. */
function inSandbox(mutate) {
  const dir = mkdtempSync(join(tmpdir(), "fap-test-"));
  try {
    for (const entry of [
      "plugin.json", "mcp.json", ".mcp.json", ".claude-plugin",
      "skills", "assets", "docs", "scripts", "LICENSE",
    ]) {
      cpSync(join(ROOT, entry), join(dir, entry), { recursive: true });
    }
    mutate(dir);
    return runValidator(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const cases = [
  {
    name: "unmodified package passes",
    mutate: () => {},
    expect: (r) => r.code === 0,
    describe: "should exit 0",
  },
  {
    name: "rejects credentials in mcp.json headers",
    mutate: (dir) => {
      const mcp = JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8"));
      mcp.mcpServers.flowcore.headers = { Authorization: "Bearer someactualtokenvalue" };
      writeFileSync(join(dir, "mcp.json"), JSON.stringify(mcp, null, 2));
    },
    expect: (r) => r.code === 1 && /headers/.test(r.output),
    describe: "should reject a packaged Authorization header",
  },
  {
    name: "rejects env block in mcp.json",
    mutate: (dir) => {
      const mcp = JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8"));
      mcp.mcpServers.flowcore.env = { FLOWCORE_TOKEN: "abc123def456" };
      writeFileSync(join(dir, "mcp.json"), JSON.stringify(mcp, null, 2));
    },
    expect: (r) => r.code === 1 && /env/.test(r.output),
    describe: "should reject credential-bearing env",
  },
  {
    name: "rejects non-https MCP url",
    mutate: (dir) => {
      const mcp = JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8"));
      mcp.mcpServers.flowcore.url = "http://flowcore.io/api/mcp";
      writeFileSync(join(dir, "mcp.json"), JSON.stringify(mcp, null, 2));
    },
    expect: (r) => r.code === 1 && /https/.test(r.output),
    describe: "should require https",
  },
  {
    name: "rejects wrong schema version",
    mutate: (dir) => {
      const m = JSON.parse(readFileSync(join(dir, "plugin.json"), "utf8"));
      m.$schema = "https://agent-plugins.org/schemas/0.9.0/plugin.schema.json";
      writeFileSync(join(dir, "plugin.json"), JSON.stringify(m, null, 2));
    },
    expect: (r) => r.code === 1 && /\$schema/.test(r.output),
    describe: "should pin the 1.0.0 schema",
  },
  {
    name: "rejects non-SemVer version",
    mutate: (dir) => {
      const m = JSON.parse(readFileSync(join(dir, "plugin.json"), "utf8"));
      m.version = "v1";
      writeFileSync(join(dir, "plugin.json"), JSON.stringify(m, null, 2));
    },
    expect: (r) => r.code === 1 && /SemVer/.test(r.output),
    describe: "should require SemVer",
  },
  {
    name: "rejects unknown manifest field",
    mutate: (dir) => {
      const m = JSON.parse(readFileSync(join(dir, "plugin.json"), "utf8"));
      m.customField = "not allowed at top level";
      writeFileSync(join(dir, "plugin.json"), JSON.stringify(m, null, 2));
    },
    expect: (r) => r.code === 1 && /unknown top-level field/.test(r.output),
    describe: "should reject undeclared top-level fields",
  },
  {
    name: "rejects skill missing frontmatter",
    mutate: (dir) => {
      const p = join(dir, "skills", "flowcore-platform", "SKILL.md");
      writeFileSync(p, "# No frontmatter here\n");
    },
    expect: (r) => r.code === 1 && /frontmatter/.test(r.output),
    describe: "should require YAML frontmatter",
  },
  {
    name: "rejects skill name not matching its directory",
    mutate: (dir) => {
      const p = join(dir, "skills", "flowcore-platform", "SKILL.md");
      const c = readFileSync(p, "utf8").replace(
        "name: flowcore-platform",
        "name: something-else"
      );
      writeFileSync(p, c);
    },
    expect: (r) => r.code === 1 && /does not match its directory/.test(r.output),
    describe: "should require name/directory agreement",
  },
  {
    name: "rejects private workspace UUID",
    mutate: (dir) => {
      const p = join(dir, "skills", "flowcore-platform", "SKILL.md");
      // Synthetic, deliberately not resembling any real workspace.
      const c = readFileSync(p, "utf8") +
        "\nWorkspace: 00000000-0000-4000-8000-000000000000\n";
      writeFileSync(p, c);
    },
    expect: (r) => r.code === 1 && /UUID/.test(r.output),
    describe: "should reject leaked workspace identifiers",
  },
  {
    name: "rejects a symlink escaping the package root",
    mutate: (dir) => {
      symlinkSync("/etc/passwd", join(dir, "docs", "escape.md"));
    },
    expect: (r) => r.code === 1 && /symlink/.test(r.output),
    describe: "should enforce path containment",
  },
  {
    name: "rejects a missing referenced file",
    mutate: (dir) => {
      rmSync(join(dir, "skills", "flowcore-platform", "references", "tool-map.md"));
    },
    expect: (r) => r.code === 1 && /references missing file/.test(r.output),
    describe: "should catch dangling reference links",
  },
  {
    name: "rejects a skill that is not a directory",
    mutate: (dir) => {
      writeFileSync(join(dir, "skills", "stray.md"), "not a skill directory\n");
    },
    expect: (r) => r.code === 1 && /not a directory/.test(r.output),
    describe: "should require skills to be directories",
  },
  {
    name: "rejects a missing LICENSE",
    mutate: (dir) => {
      rmSync(join(dir, "LICENSE"));
    },
    expect: (r) => r.code === 1 && /LICENSE/.test(r.output),
    describe: "should require a license file",
  },
  {
    name: "rejects a missing extension asset",
    mutate: (dir) => {
      rmSync(join(dir, "assets", "flowcore-icon.svg"));
    },
    expect: (r) => r.code === 1 && /references missing file/.test(r.output),
    describe: "should catch an icon path that does not resolve",
  },
  {
    name: "rejects an extension path escaping the plugin root",
    mutate: (dir) => {
      const m = JSON.parse(readFileSync(join(dir, "plugin.json"), "utf8"));
      m.extensions["com.openai"].interface.logo = "../../../etc/passwd";
      writeFileSync(join(dir, "plugin.json"), JSON.stringify(m, null, 2));
    },
    expect: (r) => r.code === 1 && /(escapes the plugin root|must be plugin-relative)/.test(r.output),
    describe: "should enforce containment on extension-declared paths",
  },
  {
    name: "rejects an extension namespace without a reverse domain",
    mutate: (dir) => {
      const m = JSON.parse(readFileSync(join(dir, "plugin.json"), "utf8"));
      m.extensions.codex = m.extensions["com.openai"];
      delete m.extensions["com.openai"];
      writeFileSync(join(dir, "plugin.json"), JSON.stringify(m, null, 2));
    },
    expect: (r) => r.code === 1 && /reverse-domain namespace/.test(r.output),
    describe: "should require reverse-domain extension keys",
  },
  {
    name: "rejects a secret in the Claude oauth block",
    mutate: (dir) => {
      const mcp = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8"));
      mcp.mcpServers.flowcore.oauth.clientSecret = "not-a-real-secret-value";
      writeFileSync(join(dir, ".mcp.json"), JSON.stringify(mcp, null, 2));
    },
    expect: (r) => r.code === 1 && /not a recognised public field/.test(r.output),
    describe: "should fail closed on unrecognised oauth fields",
  },
  {
    name: "rejects missing Claude OAuth scopes",
    mutate: (dir) => {
      const mcp = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8"));
      delete mcp.mcpServers.flowcore.oauth.scopes;
      writeFileSync(join(dir, ".mcp.json"), JSON.stringify(mcp, null, 2));
    },
    expect: (r) => r.code === 1 && /oauth\.scopes must be an array/.test(r.output),
    describe: "should prevent Claude from requesting every advertised server scope",
  },
  {
    name: "rejects unsupported Claude OAuth scopes",
    mutate: (dir) => {
      const mcp = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8"));
      mcp.mcpServers.flowcore.oauth.scopes.push("workspace.delete");
      writeFileSync(join(dir, ".mcp.json"), JSON.stringify(mcp, null, 2));
    },
    expect: (r) => r.code === 1 && /exactly the supported scopes/.test(r.output),
    describe: "should reject scopes outside the scopes the Flowcore client grants",
  },
  {
    name: "rejects headers in .mcp.json",
    mutate: (dir) => {
      const mcp = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8"));
      mcp.mcpServers.flowcore.headers = { Authorization: "Bearer someactualtokenvalue" };
      writeFileSync(join(dir, ".mcp.json"), JSON.stringify(mcp, null, 2));
    },
    expect: (r) => r.code === 1 && /headers/.test(r.output),
    describe: "should reject a packaged header in the Claude MCP config",
  },
  {
    name: "rejects the Agent Plugins transport in .mcp.json",
    mutate: (dir) => {
      const mcp = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8"));
      mcp.mcpServers.flowcore.type = "streamable-http";
      writeFileSync(join(dir, ".mcp.json"), JSON.stringify(mcp, null, 2));
    },
    expect: (r) => r.code === 1 && /Claude Code uses "http"/.test(r.output),
    describe: "should catch the transport identifiers being swapped",
  },
  {
    name: "rejects MCP configs that disagree on url",
    mutate: (dir) => {
      const mcp = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8"));
      mcp.mcpServers.flowcore.url = "https://staging.flowcore.io/api/mcp";
      writeFileSync(join(dir, ".mcp.json"), JSON.stringify(mcp, null, 2));
    },
    expect: (r) => r.code === 1 && /points at/.test(r.output),
    describe: "should catch drift between the two MCP documents",
  },
  {
    name: "rejects MCP configs that disagree on server set",
    mutate: (dir) => {
      const mcp = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8"));
      mcp.mcpServers.extra = { type: "http", url: "https://example.invalid/mcp" };
      writeFileSync(join(dir, ".mcp.json"), JSON.stringify(mcp, null, 2));
    },
    expect: (r) => r.code === 1 && /must be offered the same servers/.test(r.output),
    describe: "should require both clients to get the same servers",
  },
  {
    name: "rejects Claude plugin name mismatch",
    mutate: (dir) => {
      const p = JSON.parse(readFileSync(join(dir, ".claude-plugin", "plugin.json"), "utf8"));
      p.name = "flowcore-something-else";
      writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify(p, null, 2));
    },
    expect: (r) => r.code === 1 && /does not match root plugin.json name/.test(r.output),
    describe: "should keep the two plugin manifests in agreement",
  },
  {
    name: "rejects Claude plugin version mismatch",
    mutate: (dir) => {
      const p = JSON.parse(readFileSync(join(dir, ".claude-plugin", "plugin.json"), "utf8"));
      p.version = "9.9.9";
      writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify(p, null, 2));
    },
    expect: (r) => r.code === 1 && /does not match root plugin.json version/.test(r.output),
    describe: "should catch a version that would ship stale in one client",
  },
  {
    name: "rejects marketplace source with no plugin manifest",
    mutate: (dir) => {
      const m = JSON.parse(readFileSync(join(dir, ".claude-plugin", "marketplace.json"), "utf8"));
      m.plugins[0].source = "./docs";
      writeFileSync(join(dir, ".claude-plugin", "marketplace.json"), JSON.stringify(m, null, 2));
    },
    expect: (r) => r.code === 1 && /has no \.claude-plugin\/plugin\.json/.test(r.output),
    describe: "should verify the marketplace points at a real plugin",
  },
  {
    name: "rejects marketplace missing owner",
    mutate: (dir) => {
      const m = JSON.parse(readFileSync(join(dir, ".claude-plugin", "marketplace.json"), "utf8"));
      delete m.owner;
      writeFileSync(join(dir, ".claude-plugin", "marketplace.json"), JSON.stringify(m, null, 2));
    },
    expect: (r) => r.code === 1 && /owner\.name/.test(r.output),
    describe: "should require the owner field Claude Code mandates",
  },
  {
    name: "rejects an undocumented MCP url",
    mutate: (dir) => {
      const mcp = JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8"));
      mcp.mcpServers.flowcore.url = "https://example.invalid/api/mcp";
      writeFileSync(join(dir, "mcp.json"), JSON.stringify(mcp, null, 2));
    },
    expect: (r) => r.code === 1 && /not documented/.test(r.output),
    describe: "should require the shipped endpoint to be documented",
  },
  {
    name: "rejects a named id in an FRN example",
    mutate: (dir) => {
      const p = join(dir, "skills", "flowcore-platform", "SKILL.md");
      writeFileSync(p, readFileSync(p, "utf8") + '\n```json\n{"resource": "frn::acme:data-core/orders", "action": "read"}\n```\n');
    },
    expect: (r) => r.code === 1 && /invalid FRN/.test(r.output),
    describe: "should reject FRNs that IAM accepts but never matches",
  },
  {
    name: "rejects an unhyphenated FRN type",
    mutate: (dir) => {
      const p = join(dir, "skills", "flowcore-platform", "SKILL.md");
      writeFileSync(p, readFileSync(p, "utf8") + '\n```\nfrn::acme:datacore/*\n```\n');
    },
    expect: (r) => r.code === 1 && /invalid FRN/.test(r.output),
    describe: "should require data-core, not datacore",
  },
  {
    name: "rejects an uppercase action example",
    mutate: (dir) => {
      const p = join(dir, "skills", "flowcore-platform", "SKILL.md");
      writeFileSync(p, readFileSync(p, "utf8") + '\n```json\n{"resource": "frn::acme:*", "action": ["READ"]}\n```\n');
    },
    expect: (r) => r.code === 1 && /invalid action/.test(r.output),
    describe: "should require lowercase actions",
  },
  {
    name: "rejects .mcp.json scopes that differ from the Flowcore client",
    mutate: (dir) => {
      const mcp = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8"));
      mcp.mcpServers.flowcore.oauth.scopes = ["openid"];
      writeFileSync(join(dir, ".mcp.json"), JSON.stringify(mcp, null, 2));
    },
    expect: (r) => r.code === 1 && /oauth\.scopes/.test(r.output),
    describe: "should pin the exact scope list",
  },
];

let failed = 0;

for (const c of cases) {
  const result = inSandbox(c.mutate);
  if (c.expect(result)) {
    console.log(`  ok      ${c.name}`);
  } else {
    failed++;
    console.log(`  FAILED  ${c.name} — ${c.describe}`);
    console.log(`          exit ${result.code}`);
    console.log(result.output.split("\n").map((l) => `          ${l}`).join("\n"));
  }
}

console.log(`\n${cases.length - failed}/${cases.length} validator self-tests passed`);

if (failed > 0) {
  console.error("Validator self-test failed.");
  process.exit(1);
}
