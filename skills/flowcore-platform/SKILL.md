---
name: flowcore-platform
description: Core model of the Flowcore event platform — tenants, data cores, flow types, event types, events and time buckets — plus the safety rules for every Flowcore MCP operation. Use before any Flowcore MCP call, when modeling events, or when the user asks how Flowcore is structured. For access control use flowcore-iam; for delivery use flowcore-data-pathways; for app code use flowcore-pathways.
---

# Flowcore platform

Flowcore stores immutable events and delivers them to consumers. Everything an agent does through the Flowcore MCP server sits in one hierarchy.

## Resource hierarchy

```
Tenant                  organization; owns IAM (users, API keys, roles, policies) and billing
└── Data Core           isolated event store; accessControl public|private; deleteProtection
    └── Flow Type       one stream of related events, e.g. "order.0"
        └── Event Type  one kind of fact, e.g. "order.placed.0"; optional sensitive-data masking
            └── Events  immutable, grouped in time buckets (form yyyyMMddHHmmss)

Data Pathway (tenant level)   delivers events from a data core to a consumer — see flowcore-data-pathways
```

| Resource | Identified by | Find it with |
|---|---|---|
| Tenant | name (e.g. `acme`) and UUID | `list_tenants`, `get_tenant` |
| Data core | UUID | `list_data_cores` (tenant UUID) |
| Flow type | UUID | `list_flow_types` (data core UUID) |
| Event type | UUID | `list_event_types` (flow type UUID) |
| Events | event id inside a time bucket | `get_time_buckets`, then `get_events` |

Some tools take the tenant **name** (`get_events`, `delete_data_core`) and some take the tenant **UUID** (`list_data_cores`, IAM tools call it `organizationId`). Read the parameter description every time.

## Glossary: two things called "pathways"

| Term | What it is | Skill |
|---|---|---|
| **Data Pathway** | A control-plane resource that delivers events from a data core. Type `virtual` (preferred) or `managed`. Operated with MCP tools or the console. | `flowcore-data-pathways` |
| **Pathways** (`@flowcore/pathways`) | The TypeScript library inside an app. It writes events, runs handlers, and can register itself as a virtual Data Pathway. | `flowcore-pathways` |

Never use one word for both. Say "Data Pathway" for the resource and "the Pathways SDK" for the library.

## Naming and versioning

- Flow type: `<entity>.<version>`, e.g. `order.0`.
- Event type: `<entity>.<fact-in-past-tense>.<version>`, e.g. `order.placed.0`.
- A breaking change to a payload gets a **new** event type (`order.placed.1`). Do not change the meaning of an existing one; its events are already stored.
- Events are facts. Name them for what happened, not for what a consumer should do.

## Rules for every operation

1. **Read before write.** Resolve every id with a `list_*` or `get_*` tool. Never guess an id.
2. **Full UUIDs only.** Never shorten, truncate or abbreviate a UUID in a tool call, a policy, or a report.
3. **Destructive tools destroy stored events.** `delete_data_core`, `delete_flow_type`, `delete_event_type` and `delete_data_pathway` cannot be undone. Show the exact name and UUID, say what is lost, and get explicit confirmation in the current conversation first. A data core with `deleteProtection: true` must stay protected unless the user asks to remove it.
4. **Mutations are readback-verified.** After a create or update, read the resource again and compare it with what you intended.
5. **Secrets are shown once.** `create_api_key` returns the secret one time. Show it to the user once, tell them to store it in a secret manager, and never write it to a file, a log, or a later message.
6. **Stay in scope.** Only touch the tenant and resources the user named.

## Reading events

1. `get_time_buckets` for the event type (tenant name + event type UUID).
2. `get_events` for one bucket, with `pageSize` and the returned `cursor` to page.
3. Sensitive fields are masked unless the caller has `sensitive-data-fetch` (see `flowcore-iam`).

## Overviews

`show_tenant_overview`, `show_pathway_dashboard` and `show_iam_overview` render visual summaries in clients that support MCP apps. Use them when the user asks "what do I have".

## References

- [references/tool-map.md](references/tool-map.md) — every Flowcore MCP tool, grouped by resource, with read/write/destructive marks.
- [references/event-modeling.md](references/event-modeling.md) — how to split data cores, flow types and event types.

---
Source: https://github.com/flowcore-io/flowcore-agent-plugin · Mirror: https://flowcore.io/agent/skills/index.json
Check the mirror at most once per day. Update this skill when the mirror version is newer.
