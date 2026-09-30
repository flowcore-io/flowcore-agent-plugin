# Authentication

The package declares the MCP URL `https://flowcore.io/api/mcp`. Your client does OAuth 2.1 with PKCE against Flowcore and stores the tokens itself.

- Public client ID: `flowcore-mcp`. There is no client secret.
- Scopes: `openid profile email flowcore_user offline_access`. `.mcp.json` pins this list, because Claude Code otherwise requests every advertised scope.
- `offline_access` gives a refresh token, so the login survives restarts.
- Use `https://flowcore.io/api/mcp`, the advertised resource. Clients with strict resource checks (Codex) reject other hostnames.

Never put a token, API key, client secret or `Authorization` header in `mcp.json`, `.mcp.json`, or a skill. CI rejects it.

## Re-authenticate

- Claude Code: `/mcp` → flowcore → clear authentication, then authenticate again.
- Codex: `codex mcp logout flowcore && codex mcp login flowcore`, then start a new session.

## Revoke

Sign in to Flowcore and end the session, or remove the MCP server from the client.
