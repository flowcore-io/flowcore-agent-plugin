# Contributing

1. Every claim in a skill must be verified against the Flowcore source or the live MCP server. Say which in the pull request.
2. Keep examples synthetic. The only allowed UUID is `3f2c9a1e-7b4d-4c8a-9e21-5d6f0a1b2c3d`.
3. Run `node scripts/validate-package.mjs` and `node tests/smoke/validator.test.mjs`.
4. Add a `CHANGELOG.md` entry and bump the version in `plugin.json`, `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`.
