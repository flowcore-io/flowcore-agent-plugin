# Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `invalid_scope` in the browser | The client requested scopes the Flowcore client cannot grant | Use this plugin's `.mcp.json` (pinned scopes), clear the MCP auth, sign in again |
| Codex: resource or issuer mismatch | Configured URL is not `https://flowcore.io/api/mcp` | Remove the server and add it again with the exact URL |
| Tools missing after install | The session started before the install | Start a new session |
| Logged out after a restart | Old grant without `offline_access` | Log out and log in again |
| Two `flowcore` servers | A user-level server and the plugin server | Keep one |
| "forbidden" from a service using a new policy | The policy uses a named id, `datacore`, or uppercase actions | See the `flowcore-iam` skill: tenant by name, all other ids by UUID, lowercase actions |
