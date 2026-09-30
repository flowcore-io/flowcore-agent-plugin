---
name: flowcore-iam
description: Flowcore access control — users, API keys, roles, policies, FRN resource names and actions. Use when the user asks to give or remove access, create an API key for a service, write or fix a policy, or debug a "forbidden" error on Flowcore. Contains the only valid policy statement format; named resource ids silently never match.
---

# Flowcore IAM

## Access model

```
Principal: User | API key
   ├── link_user_role / link_key_role ──▶ Role ──link_role_policy──▶ Policy
   └── link_user_policy / link_key_policy ─────────────────────────▶ Policy   (exceptions only)

Policy  = name + version + statements[]
Statement = { statementId?, resource: FRN, action: action | action[] }
```

- Effective access is the **union** of every statement the principal reaches, through any role or direct policy. There is no deny.
- Roles and policies belong to one tenant. IAM tools call the tenant UUID `organizationId`.
- Prefer roles. Use a direct policy link only for a temporary or one-off grant.
- Policies and roles marked `flowcoreManaged` belong to Flowcore. Never edit them.

## The only valid statement format

```
resource: frn::<tenant-name>:<type>/<uuid>      one resource
          frn::<tenant-name>:<type>/*           every resource of that type in the tenant
          frn::<tenant-name>:*                  everything in the tenant
action:   one of, lowercase:  *  read  write  fetch  ingest  sensitive-data-fetch
types:    tenant  data-core  flow-type  event-type  compute  database  key  user  policy  role
```

**The tenant segment is the tenant NAME. Every other id MUST be a full UUID.**
IAM compares the id segment by exact string. A statement such as `frn::acme:data-core/orders` is accepted when you create the policy, but it never matches anything. The service then gets "forbidden" and nothing points at the policy. This is the most common mistake agents make. Resolve UUIDs first:

```
list_tenants                          → tenant name (for the FRN) and tenant UUID (organizationId)
list_data_cores   (tenant UUID)       → data core UUID
list_flow_types   (data core UUID)    → flow type UUID
list_event_types  (flow type UUID)    → event type UUID
```

### Valid example — a service that writes and reads one data core

```json
[
  {
    "statementId": "orders-ingest-fetch",
    "resource": "frn::acme:data-core/3f2c9a1e-7b4d-4c8a-9e21-5d6f0a1b2c3d",
    "action": ["read", "ingest", "fetch"]
  }
]
```

Pass this as the `policyDocuments` JSON string to `create_policy`.

### Invalid → why

| Statement | Problem |
|---|---|
| `"resource": "frn::acme:data-core/orders"` | Named id. Matches nothing. Use the UUID. |
| `"resource": "frn::acme:datacore/3f2c9a1e-…"` | Type is `data-core`, with a hyphen. |
| `"resource": "frn::7c1e…-tenant-uuid:data-core/*"` | The tenant segment must be the tenant name. |
| `"resource": "*"` or `"frn:*"` | Malformed. Everything in a tenant is `frn::acme:*`. |
| `"resource": "frn::acme/data-core/*"` | Separator after the tenant is `:`, not `/`. |
| `"action": "READ"` | Actions are lowercase. |
| `"action": ["delete"]` / `["update"]` | Not actions. Changes and deletes need `write`. |
| A shortened UUID (`3f2c9a1e`) | Ids are compared exactly. Always use the full UUID. |

Before you send `create_policy` or `update_policy`, check every resource against this regex:

```
^frn::[a-z0-9-]+:(\*|(tenant|data-core|flow-type|event-type|compute|database|key|user|policy|role)/(\*|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}))$
```

## Actions

| Action | Grants |
|---|---|
| `read` | Read metadata: tenants, data cores, flow types, event types, IAM objects |
| `write` | Create, change and delete resources |
| `ingest` | Write events into a data core |
| `fetch` | Read events |
| `sensitive-data-fetch` | Read events with masked fields unmasked |
| `*` | All of the above |

A request is allowed when one statement has **all** the requested actions (or `*`) and a matching resource. Flowcore checks event access against the chain data core → flow type → event type, and a match on any link is enough. A data core statement therefore covers every flow type and event type in it.

## Changing a policy

`update_policy` **replaces every statement**. Always:
1. `list_policies` and copy the current statements of the policy.
2. Add or change only what the user asked for.
3. Send the full list, with the version bumped.
4. `list_policies` again and compare.

## Recipes

See [references/recipes.md](references/recipes.md) for:
- an API key for a service (ingest + fetch on one data core),
- a read-only teammate,
- temporary direct access,
- debugging "forbidden".

## Safety

- Least privilege: one data core UUID beats `data-core/*`, and `data-core/*` beats `frn::<tenant>:*`.
- `create_api_key` returns the secret once. Show it once, tell the user to store it in a secret manager, and never repeat it.
- `unlink_*`, `archive_*` and `delete_api_key` remove access immediately and can break running services. Name the affected principal and get confirmation first.
- Before you archive a policy, check that no role still uses it.

---
Source: https://github.com/flowcore-io/flowcore-agent-plugin · Mirror: https://flowcore.io/agent/skills/index.json
Check the mirror at most once per day. Update this skill when the mirror version is newer.
