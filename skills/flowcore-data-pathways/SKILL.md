---
name: flowcore-data-pathways
description: Operate Flowcore Data Pathways — the control-plane resources that deliver events from a data core to a consumer. Covers virtual vs managed pathways, create, pause, resume, restart/replay, disable, delete and delivery troubleshooting through the Flowcore MCP tools. Use when the user asks to deliver events somewhere, replay events, hold or resume delivery, or why a consumer is behind. For writing app code with the @flowcore/pathways SDK use flowcore-pathways.
---

# Flowcore Data Pathways

A **Data Pathway** is a control-plane resource that delivers events from one data core to one consumer. It is not the `@flowcore/pathways` SDK (see the glossary in `flowcore-platform`). The SDK can register itself as a virtual Data Pathway.

## Virtual (default) vs managed

| | **Virtual — preferred** | Managed |
|---|---|---|
| Who runs the pump | The consumer service, in-process, with the Pathways SDK | The Flowcore worker fleet (one assigned slot) |
| How events arrive | Directly into the service's handlers | Workers HTTP-POST batches to the `endpoints` in `config.sources` |
| Network | Outbound only. Works behind NAT and in private networks. | Needs a public HTTPS endpoint |
| Control commands | The service polls the control plane (about every 5 s) | Dispatched to the assigned worker |
| Pause / resume | Yes. Durable, no gap, no replay. | No |
| Usual registration | Automatic, by name, when the SDK starts in production | `create_data_pathway` with full `config.sources` |
| Choose when | Any long-running service. This is the default. | Only when the user explicitly chooses it — for example a serverless app with no long-running process |

Rules:
- Recommend virtual. Build the consumer with the `flowcore-pathways` skill; the SDK creates and updates the virtual Data Pathway itself.
- In SDK code, set `pathwayMode: "virtual"` explicitly. The SDK defaults to `managed` when `runtimeEnv` is production.
- **Never switch to managed as a fallback** (for example after a virtual setup fails) without explicit user approval. Report the failure instead.

## Inspect first

```
list_data_pathways (tenant)      → find the pathway; note type, enabled, sizeClass
get_data_pathway (id)            → full config, virtualConfig.flowTypes, sources
show_pathway_dashboard           → delivery state and lag, in clients that render MCP apps
```

## Operations

| Goal | Tool | Notes |
|---|---|---|
| Hold delivery for a while | `pause_data_pathway` | Virtual only. The pump keeps its cursor. `resume_data_pathway` continues at the same event. Target one flow type (`orders.0`) or one pump group (`orders.0::hot`), or omit targets for all. The paused state survives redeploys. |
| Continue delivery | `resume_data_pathway` | Omit targets to resume every pump. This always works as an escape hatch. |
| Replay from a point | `restart_data_pathway` | Prefer `timestamp` (ISO 8601 or `now`); the tool converts it to a safe time bucket + event boundary. Limit with `flowTypes`. Mode `datapumpRestart` (default) keeps running; `hardReset` makes the scheduler re-place a managed pathway. |
| Stop and remove access | `disable_data_pathway` | **Destructive for delivery:** deletes the pathway API key, and a later enable can reset the cursor to latest and skip the backlog. Use pause for a temporary hold. |
| Remove | `delete_data_pathway` | Deletes the pathway, its delivery log and pump state. Confirm first. |
| Create or change | `create_data_pathway` | Omit `id` to create. Pass the existing `id` to update in place (keeps pump state and delivery log). |

## Change procedure (every write)

1. `get_data_pathway` — the live state is the only source of truth.
2. Build the full intended object. `create_data_pathway` with an `id` writes the whole pathway, so start from the live `config` / `virtualConfig` / `labels` and change only what the user asked for.
3. Show the user an exact diff (sources, flow types, event types, endpoints, enabled). Get explicit confirmation.
4. Apply.
5. `get_data_pathway` again and compare with the diff. Report any unexpected difference and stop.

## Managed pathway config (only when the user chose managed)

```json
{
  "sources": [
    {
      "flowType": "order.0",
      "eventTypes": ["order.placed.0", "order.paid.0"],
      "endpoints": [{ "url": "https://orders.example.com/api/flowcore", "authHeaders": { "x-secret": "<from the user's secret store>" } }],
      "batchSize": 100,
      "maxInFlight": 10
    }
  ]
}
```

- Every source needs at least one endpoint. `flowType` and `eventTypes` are names, as in the data core.
- Never invent an auth header value. Ask the user for it or for the secret reference.
- Virtual pathways use `virtualConfig: {"flowTypes": [...]}`. Their `config.sources` is informational only and must have empty `endpoints`.

## Troubleshooting

See [references/troubleshooting.md](references/troubleshooting.md).

---
Source: https://github.com/flowcore-io/flowcore-agent-plugin · Mirror: https://flowcore.io/agent/skills/index.json
Check the mirror at most once per day. Update this skill when the mirror version is newer.
