# Changelog

## [0.2.0] - 2026-09-30

### Added
- `flowcore-pathways`: `references/resilient-startup.md`, a production start runtime for virtual pathways. It retries the whole start with `stopPump()` + `stopCluster()` between attempts, exits when the retries run out, exits when a leader holds the lease without a running pump, detects `Failed to bootstrap leader runtime after becoming leader` in the logger adapter, and separates liveness from readiness. It also adds handler timeouts sized to `deliveryTimeoutMs`.
- Evaluation scenario for a resilient cluster start.

### Changed
- `flowcore-pathways`: new rule 11. A start error must never leave a silent stall. The minimal example now makes one start attempt (`startOnce`) and uses the resilient runtime.
- `flowcore-pathways` troubleshooting: rows for a leader without a pump, `Cluster already started` on retry, `{}` error logs, hanging handlers, dropped events after retries, and Bun `NODE_ENV` inlining.
- `flowcore-data-pathways` troubleshooting: row for a virtual pathway without pulses while pods are healthy.

### Fixed
- `flowcore-pathways` cluster failure modes: a PostgreSQL outage does not make the leader step down. Lease renewal throws, the error is logged as `Lease loop error`, and the leader keeps its role (verified against `@flowcore/pathways` 2.10.4).

## [0.1.0] - 2026-09-30

### Added
- Skills: `flowcore-platform`, `flowcore-iam`, `flowcore-data-pathways`, `flowcore-pathways`.
- Flowcore MCP server declaration for Agent Plugins (`mcp.json`) and Claude Code (`.mcp.json`, pinned OAuth scopes).
- Package validator with a check that every FRN example in a skill code block is valid for Flowcore IAM.
