# Flowcore Agent Plugin

Connects a coding agent to [Flowcore](https://flowcore.io) and teaches it to operate the platform safely.

> **Status: pre-release (`0.1.0`).**

## Contents

| Component | What it does |
|---|---|
| [`flowcore-platform`](skills/flowcore-platform/SKILL.md) | Resource hierarchy (tenant → data core → flow type → event type → events), naming, safety rules, tool map |
| [`flowcore-iam`](skills/flowcore-iam/SKILL.md) | Users, API keys, roles, policies. The only valid FRN format, with valid and invalid examples |
| [`flowcore-data-pathways`](skills/flowcore-data-pathways/SKILL.md) | Operate Data Pathways: virtual (default) vs managed, pause, resume, restart, troubleshooting |
| [`flowcore-pathways`](skills/flowcore-pathways/SKILL.md) | Build apps with the `@flowcore/pathways` SDK: virtual pathway, cluster + pump, handlers, writes |
| [`mcp.json`](mcp.json) / [`.mcp.json`](.mcp.json) | The hosted Flowcore MCP server `https://flowcore.io/api/mcp` |

No credentials ship in this package. Your client signs in with OAuth.

## Install

The easiest path: open Flowcore, select **Connect MCP** in the user menu, copy the setup prompt, and paste it into your agent. The prompt does the steps below.

**Claude Code** (MCP server + skills):

```bash
claude plugin marketplace add flowcore-io/flowcore-agent-plugin
claude plugin install flowcore@flowcore
```

**Codex** (skills in `~/.agents/skills`, MCP server added separately):

```bash
git clone --depth 1 https://github.com/flowcore-io/flowcore-agent-plugin /tmp/flowcore-agent-plugin
mkdir -p ~/.agents/skills
cp -R /tmp/flowcore-agent-plugin/skills/* ~/.agents/skills/
codex mcp add flowcore --url https://flowcore.io/api/mcp --oauth-client-id flowcore-mcp
codex mcp login flowcore
```

**Any other agent:** add the MCP server `https://flowcore.io/api/mcp` at user level. Then download each skill listed in the mirror index <https://flowcore.io/agent/skills/index.json> into the agent's user-level skills directory, one folder per skill.

Details: [docs/installation.md](docs/installation.md) · [docs/authentication.md](docs/authentication.md) · [docs/troubleshooting.md](docs/troubleshooting.md)

## Updating

The skills tell the agent to check the mirror index at most once per day, and to update local copies when the version is newer. Claude Code users can also run `claude plugin update flowcore@flowcore`.

## Development

```bash
node scripts/validate-package.mjs     # package, skills, secrets, FRN examples
node tests/smoke/validator.test.mjs   # the validator rejects each known defect
node scripts/build-release.mjs        # release archive into dist/
```
