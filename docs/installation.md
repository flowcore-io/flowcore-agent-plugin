# Installation

## Claude Code

```bash
claude plugin marketplace add flowcore-io/flowcore-agent-plugin
claude plugin install flowcore@flowcore
```

The plugin declares the `flowcore` MCP server and the four skills. If you already configured a user-level server named `flowcore`, that server shadows the plugin server. Remove the old entry (`claude mcp remove flowcore --scope user`) or keep it, but do not keep two servers with the same URL.

Upgrade: `claude plugin update flowcore@flowcore`. Uninstall: `claude plugin uninstall flowcore@flowcore`.

## Codex

Install the skills in `~/.agents/skills`. Prefer it over `~/.codex/skills`.

```bash
git clone --depth 1 https://github.com/flowcore-io/flowcore-agent-plugin /tmp/flowcore-agent-plugin
mkdir -p ~/.agents/skills
cp -R /tmp/flowcore-agent-plugin/skills/* ~/.agents/skills/
codex mcp add flowcore --url https://flowcore.io/api/mcp --oauth-client-id flowcore-mcp
codex mcp login flowcore
```

Start a new Codex session after this. Existing sessions do not load new skills or MCP servers.

## Other agents

1. Add a remote MCP server at user level: URL `https://flowcore.io/api/mcp`, OAuth, optional client ID `flowcore-mcp`, no client secret.
2. Fetch <https://flowcore.io/agent/skills/index.json>. For each skill, download every listed file into `<your agent's user skills dir>/<skill name>/`, keeping relative paths.
3. Restart the agent.

## Verify

- Call `list_tenants`. It is read-only.
- Ask the agent to list its skills. Expect `flowcore-platform`, `flowcore-iam`, `flowcore-data-pathways`, `flowcore-pathways`.
