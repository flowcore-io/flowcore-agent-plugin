# Troubleshooting

Verified against `@flowcore/pathways` 2.10.4. Pass a real `logger` first; the default `NoopLogger`
hides every message quoted here.

| Symptom | Likely cause | Fix |
|---|---|---|
| `Cluster mode must be started before production virtual pump startup` | Production + virtual without `startCluster()` | Call `startCluster()` before `startPump()`. On serverless, stop and ask the user (long-running service or managed). |
| Production never runs a local pump and logs `Not starting local pump — production managed pathways rely on control-plane delivery` | `pathwayMode` not set; production defaults to `managed` | Set `pathwayMode: "virtual"` unless the user chose managed. |
| `managedConfig.endpointUrl is required when provisioning a managed pathway` | Managed registration without an endpoint | Add `managedConfig`, or set `pathwayMode: "virtual"`. |
| No virtual pathway appears in the control plane | Missing `pathwayName`, missing `autoProvision: { pathway: true }`, development runtime, or no leader yet | Check all four. In development this is expected. |
| A stray pathway appears for a developer machine | Library older than 2.5.5, or `allowDevelopmentPathwayRegistration: true` | Upgrade; remove the flag; delete the stray pathway through the control plane. |
| `Data core "X" not found on tenant "Y". Provide dataCoreDescription ...` | Data core missing and not owned in code | Add `dataCoreDescription` if this service owns it; otherwise create it or fix the name. |
| `Flow type "X" not found ...` / `Event type "X" not found ...` | Missing and no description in `register()` | Add `flowTypeDescription` / `description` if owned; otherwise ask the owning service. |
| Provisioning fails with permission errors | API key cannot manage data core resources | Grant the needed actions on `frn::<tenant-name>:data-core/<data-core-uuid>` (see `flowcore-iam`), or disable the stages with `autoProvision: { dataCore: false, flowType: false, eventType: false }` and provision elsewhere. |
| `Pathway processing timed out after ...ms for event ...` | Handler slow or failing, pathway paused, `subscribe: false` with a blocking write, pathway state not shared, no leader, or a dropped notification | The event is stored: do not retry. Check handler errors, pause state and leader logs. Use `fireAndForget` for write-only paths. Use the shared Postgres pathway state. Consider `pathwayTimeoutMs` above 20 000. |
| Only one of two services processes events; the other logs `Could not acquire lease, becoming worker` forever | Two deployables share a database without `statePrefix` | Give each deployable its own `statePrefix` on every Postgres store and the coordinator. |
| Followers never receive events | `advertisedAddress` not reachable, includes a scheme, or port blocked | Use a host or IP only (the library adds `ws://` and the port) and open the port between instances. |
| `Pathway X is not writable` | Registered with `writable: false` | Remove the flag if the service writes it. |
| `Invalid data for pathway ...` | Payload fails the Zod schema | Fix the data or the schema. Validation runs before sending. |
| `Someone is already handling pathway ... in this instance` | Two `.handle()` calls for one path | Keep one handler per path. |
| Handler never runs for a registered path | `subscribe: false` on that registration | Remove `subscribe: false` if this service must handle it. |
| `400 Event size exceeds maximum limit of 64000 bytes` on write | No chunk store | Add `withPathwayChunkStore(createPostgresPathwayChunkStore(...))`. |
| `received a chunked event but no chunk store is configured` | Consumer lacks a chunk store or is older than 2.8.0 | Configure the store on every consumer and upgrade. |
| Pathway delivers again after a redeploy while the console shows paused | Library older than 2.10.0, or the control plane was unreachable and the local delivery store is in memory | Upgrade, and configure `createPostgresPathwayDeliveryStore`. |
| `db push` wants to drop `pathway_*` tables or columns | Library tables visible to the ORM | Do not confirm. Add `tablesFilter: ["!pathway_*"]` or fix the mirror. See [schema-and-migrations](schema-and-migrations.md). |
| Cluster breaks with `EADDRINUSE` in Next.js | Module evaluated in several contexts, each calling `startCluster()` | Do not run cluster mode in Next.js. Ask the user to choose a long-running consumer or managed delivery. |
| `poller` or `nats` notifier seems ignored | Library older than 2.5.4 | Upgrade; treat it as a behaviour change. |

## When to escalate to the control plane

If the process looks healthy but the pathway shows no pulses, stale delivery, or a command stuck in a
non-terminal state, inspect the pathway with MCP `get_data_pathway` and `show_pathway_dashboard`, then
use the `flowcore-data-pathways` skill for pause, resume and restart. Avoid disabling a virtual pathway
to stop delivery; use pause.
