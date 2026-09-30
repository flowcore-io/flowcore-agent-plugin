# IAM recipes

All recipes start with `list_tenants`. Keep two values: the tenant **name** (for FRNs) and the tenant **UUID** (`organizationId`, `tenantId`).

## 1. API key for a service that writes and reads one data core

1. `list_data_cores` (tenant UUID) → data core UUID.
2. `create_policy`:
   ```json
   {
     "organizationId": "<tenant-uuid>",
     "name": "orders-service",
     "version": "1.0.0",
     "description": "orders-service: ingest and fetch on the orders data core",
     "policyDocuments": "[{\"statementId\":\"orders-ingest-fetch\",\"resource\":\"frn::acme:data-core/3f2c9a1e-7b4d-4c8a-9e21-5d6f0a1b2c3d\",\"action\":[\"read\",\"ingest\",\"fetch\"]}]"
   }
   ```
   If the service creates its own flow types and event types at startup (for example with auto-provisioning in the Pathways SDK), add `write` to the actions.
3. `create_role` → `link_role_policy` (role, policy).
4. `create_api_key` (tenant UUID, name) → show the secret once.
5. `link_key_role` (key, role).
6. Verify: `list_api_keys` and `list_roles` show the links.

## 2. Read-only teammate

1. `invite_user` (email).
2. Reuse or create a role with one policy: `{"resource": "frn::acme:*", "action": ["read", "fetch"]}`.
   Leave out `sensitive-data-fetch` unless the user asks for unmasked personal data.
3. `link_user_role`.

## 3. Temporary direct access

1. `create_policy` with the narrow statement and a description that says why and until when.
2. `link_user_policy` or `link_key_policy`.
3. When the access ends: `unlink_user_policy` / `unlink_key_policy`, then `archive_policy`.

## 4. Debug "forbidden"

1. Identify the principal (user or API key) and the operation that failed.
2. `show_iam_overview`, or `list_roles` + `list_policies`, to list every statement the principal reaches.
3. For each statement check, in this order:
   - tenant segment = tenant **name**, not UUID;
   - type spelled with hyphens (`data-core`);
   - id is a full UUID or `*`, never a name;
   - the action list contains the needed action (`ingest` to write events, `fetch` to read events, `write` to change resources), in lowercase.
4. `get_audit_logs` shows recent IAM changes. Use it to find a recent unlink or archive.
5. Fix the statement with `update_policy`, and resend every existing statement (see "Changing a policy" in SKILL.md).
