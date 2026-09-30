# Data Pathway troubleshooting

Start every diagnosis read-only: `get_data_pathway`, then `show_pathway_dashboard` when available.

## Consumer receives nothing
| Check | How |
|---|---|
| Pathway enabled | `get_data_pathway` → `enabled` |
| Paused | Dashboard or pathway state shows paused targets → `resume_data_pathway` after the user confirms |
| Right event types | Compare `virtualConfig.flowTypes` (virtual) or `config.sources[].eventTypes` (managed) with the event types that actually receive events (`get_time_buckets`) |
| Events exist | `get_time_buckets` + `get_events` for the event type |
| Virtual: service running | The consumer's pump runs only on the cluster leader. Ask the user for the service logs and leader state. |
| Virtual: no pulses, pods healthy | The leader holds the lease without a running pump (a caught start error, or `Failed to bootstrap leader runtime after becoming leader`). Delete the leader pod to recover. Then fix the service start with the `flowcore-pathways` skill (`references/resilient-startup.md`). |
| Managed: endpoint reachable | The endpoint must be public HTTPS and accept the configured auth headers |
| Permissions | The pathway or service API key needs `fetch` on the data core (see `flowcore-iam`) |

## Consumer is behind
- Read lag on the dashboard.
- Virtual: check for a paused pump group, handler errors in the service logs, and the service's own concurrency settings.
- Managed: check endpoint latency and error rate. `sizeClass` and `maxInFlight` limit throughput.

## Need to reprocess events
- Use `restart_data_pathway` with `timestamp` and, if possible, `flowTypes`. Handlers must be idempotent, because a replay delivers events again.
- Do not disable and enable to "reset". Disable deletes the API key and can skip the backlog.

## Virtual pathway missing after deploy
- The Pathways SDK registers the Data Pathway by name in production runtimes only. Development runtimes run a local pump and do not register.
- Check the service's tenant, data core and API key permissions. Registration needs `write` if the service also provisions flow types and event types.

## Do not
- Switch a virtual pathway to managed to "make it work".
- Delete and recreate a pathway to clear an error. That loses pump state and the delivery log.
