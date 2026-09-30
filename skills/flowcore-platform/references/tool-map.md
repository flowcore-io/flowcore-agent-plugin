# Flowcore MCP tool map

Legend: **R** read · **W** write · **D** destructive (confirm first).

## Tenant
| Tool | Kind | Notes |
|---|---|---|
| `list_tenants` | R | Start here. Returns name and UUID. |
| `get_tenant` | R | |
| `create_tenant`, `update_tenant` | W | |
| `show_tenant_overview` | R | Visual summary. |

## Data core, flow type, event type
| Tool | Kind | Notes |
|---|---|---|
| `list_data_cores`, `get_data_core` | R | Takes the tenant UUID. |
| `create_data_core`, `update_data_core` | W | `accessControl`, `deleteProtection`. |
| `delete_data_core` | D | Takes tenant **name** + data core UUID. Destroys every event in it. |
| `list_flow_types`, `get_flow_type` | R | |
| `create_flow_type`, `update_flow_type` | W | |
| `delete_flow_type` | D | Destroys its event types and events. |
| `list_event_types`, `get_event_type` | R | |
| `create_event_type`, `update_event_type` | W | `sensitiveDataMask` / `sensitiveDataEnabled`. |
| `delete_event_type` | D | Destroys its events. |

## Events
| Tool | Kind | Notes |
|---|---|---|
| `get_time_buckets` | R | Tenant name + event type UUID. |
| `get_events` | R | One time bucket per call; page with `cursor`. |

## IAM (see flowcore-iam)
| Tool | Kind | Notes |
|---|---|---|
| `show_iam_overview` | R | |
| `list_roles`, `list_policies`, `list_api_keys`, `get_audit_logs` | R | IAM tools call the tenant UUID `organizationId`. |
| `create_role`, `update_role`, `create_policy`, `update_policy` | W | `update_policy` replaces every statement. |
| `archive_role`, `archive_policy` | D | |
| `create_api_key`, `edit_api_key` | W | Secret is returned once. |
| `delete_api_key` | D | Breaks every service that uses the key. |
| `invite_user` | W | |
| `link_*` / `unlink_*` (user/key ↔ role/policy, role ↔ policy) | W | `unlink_*` removes access immediately. |

## Data Pathways (see flowcore-data-pathways)
| Tool | Kind | Notes |
|---|---|---|
| `list_data_pathways`, `get_data_pathway`, `show_pathway_dashboard` | R | |
| `create_data_pathway` | W | Also updates when you pass an existing `id`. |
| `pause_data_pathway`, `resume_data_pathway` | W | Virtual pathways. No gap, no replay. |
| `restart_data_pathway` | W | Replays from a position. |
| `disable_data_pathway` | D | Deletes the pathway API key; can skip the backlog. |
| `delete_data_pathway` | D | |

## Compute
| Tool | Kind |
|---|---|
| `compute_query` | R |
| `compute_workload`, `compute_domain`, `compute_registry` | W / D |
