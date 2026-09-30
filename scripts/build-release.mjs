#!/usr/bin/env node
/**
 * Builds the release archive from an explicit path allowlist.
 *
 * Allowlisting rather than ignore-listing is deliberate: a new file cannot leak
 * into a published artifact by default. Repository-only material (tests/,
 * scripts/, .github/, examples/) is never shipped.
 *
 * Usage:
 *   node scripts/build-release.mjs            # build into dist/
 *   node scripts/build-release.mjs --verify   # build, then assert contents match the allowlist
 *
 * No dependencies. Node 20+. Requires `tar` on PATH.
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, existsSync, readdirSync, statSync, utimesSync } from "node:fs";
import { join, resolve, relative, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DIST = join(ROOT, "dist");

/** Everything a client needs at runtime, and nothing else. */
const ALLOWLIST = [
  "plugin.json",
  "mcp.json",
  // Claude Code reads its own manifests and its own MCP filename. Both clients
  // are supported from one package, so both sets ship.
  ".claude-plugin/",
  ".mcp.json",
  "skills/",
  "assets/",
  "docs/",
  "README.md",
  "LICENSE",
  "SECURITY.md",
  "CHANGELOG.md",
];

/** Must never appear in an artifact, even if somehow matched above. */
const FORBIDDEN = [/(^|\/)\.env/, /(^|\/)\.git(\/|$)/, /node_modules/, /(^|\/)\.DS_Store$/];

const verifyOnly = process.argv.includes("--verify");

const manifest = JSON.parse(readFileSync(join(ROOT, "plugin.json"), "utf8"));
const version = manifest.version;
if (!version) {
  console.error("plugin.json has no version");
  process.exit(1);
}

// Tag/manifest agreement, enforced only when building from a tag. On branch
// pushes GITHUB_REF_NAME is the branch (e.g. "main"), which is not a version
// and must not be compared against the manifest.
const isTagBuild = process.env.GITHUB_REF_TYPE === "tag";
const tag = process.env.GITHUB_REF_NAME;
if (isTagBuild && tag) {
  const expected = tag.replace(/^v/, "");
  if (expected !== version) {
    console.error(`Version mismatch: tag ${tag} implies ${expected}, plugin.json declares ${version}`);
    process.exit(1);
  }
  console.log(`Tag ${tag} matches plugin.json version ${version}`);
}

const name = `flowcore-agent-plugin-${version}`;
const stage = join(DIST, name);

rmSync(DIST, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

// Stage allowlisted paths.
for (const entry of ALLOWLIST) {
  const src = join(ROOT, entry);
  if (!existsSync(src)) {
    if (entry === "mcp.json" || entry === ".mcp.json" || entry === ".claude-plugin/") {
      console.log(`  skip     ${entry} (absent)`);
      continue;
    }
    console.error(`Allowlisted path missing: ${entry}`);
    process.exit(1);
  }
  const dest = join(stage, entry);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true, dereference: true });
  console.log(`  staged   ${entry}`);
}

// Assert nothing forbidden was staged, and report the payload.
const staged = [];
(function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else staged.push(relative(stage, full));
  }
})(stage);

for (const file of staged) {
  for (const pattern of FORBIDDEN) {
    if (pattern.test(file)) {
      console.error(`Forbidden path in staged archive: ${file}`);
      process.exit(1);
    }
  }
}

// The archive must contain no executable code.
const executable = staged.filter((f) => /\.(mjs|js|cjs|ts|sh|bash|py|rb|exe|bin)$/.test(f));
if (executable.length > 0) {
  console.error(`Executable files must not ship in the release archive:\n  ${executable.join("\n  ")}`);
  process.exit(1);
}

console.log(`\n${staged.length} files staged:`);
for (const f of staged.sort()) {
  console.log(`  ${f} (${statSync(join(stage, f)).size} bytes)`);
}

if (verifyOnly) {
  console.log("\nVerification passed: archive contents match the allowlist and contain no executable code.");
  rmSync(DIST, { recursive: true, force: true });
  process.exit(0);
}

// ── Deterministic archive ────────────────────────────────────────────────────
// Byte-identical output for identical inputs, so a release can be reproduced
// and its checksum independently confirmed. Three sources of nondeterminism
// have to be removed: file mtimes, owner/group, and entry order. A fourth --
// the mtime gzip embeds in its header -- is handled by gzip -n.
//
// tar flags differ between GNU tar (Linux/CI) and bsdtar (macOS), and bsdtar
// has no --mtime at all, so mtimes are normalised on disk instead.
const EPOCH = new Date("2020-01-01T00:00:00Z");
for (const file of staged) {
  utimesSync(join(stage, file), EPOCH, EPOCH);
}
utimesSync(stage, EPOCH, EPOCH);

const tarVersion = execFileSync("tar", ["--version"], { encoding: "utf8" });
const isBsdTar = /bsdtar/i.test(tarVersion);
const ownerFlags = isBsdTar
  ? ["--uid", "0", "--gid", "0"]
  : ["--owner=0", "--group=0"];

// Explicit sorted entry list; relying on directory traversal order is not stable.
const entries = staged.sort().map((f) => join(name, f));

const tarPath = join(DIST, `${name}.tar`);
execFileSync(
  "tar",
  ["--format=ustar", "--numeric-owner", ...ownerFlags, "-cf", tarPath, "-C", DIST, ...entries],
  { stdio: "inherit" }
);

// -n omits the original filename and timestamp from the gzip header.
execFileSync("gzip", ["-n", "-9", tarPath], { stdio: "inherit" });
const tarball = `${tarPath}.gz`;

const digest = createHash("sha256").update(readFileSync(tarball)).digest("hex");
writeFileSync(`${tarball}.sha256`, `${digest}  ${name}.tar.gz\n`);

rmSync(stage, { recursive: true, force: true });

console.log(`\nBuilt ${relative(ROOT, tarball)} using ${isBsdTar ? "bsdtar" : "GNU tar"}`);
console.log(`SHA-256 ${digest}`);
