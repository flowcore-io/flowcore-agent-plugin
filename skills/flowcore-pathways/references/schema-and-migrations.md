# Library-owned tables, ORMs and migrations

Verified against `@flowcore/pathways` 2.10.4. Every table below is created by the library at runtime
with `CREATE TABLE IF NOT EXISTS`, and some are altered at runtime (the pump state table adds
`pump_group` and rebuilds its primary key when upgrading from older versions).

## Tables the library owns

| Default name | Created by | Purpose |
|---|---|---|
| `pathway_state` | `createPostgresPathwayState` | Processed-event markers; blocking writes poll it |
| `pathway_pump_state` | `createPostgresPumpStateManagerFactory` | Pump cursor per `(flow_type, pump_group)` |
| `pathway_leases` | `createPostgresPathwayCoordinator` | Cluster leader lease |
| `pathway_instances` | `createPostgresPathwayCoordinator` | Cluster instance heartbeats |
| `pathway_chunks` | `createPostgresPathwayChunkStore` | Parts of oversized events (2.8.0+) |
| `pathway_delivery_state` | `createPostgresPathwayDeliveryStore` | Durable pause cache (2.9.0+) |

With `statePrefix: "orders_service"` the names become `orders_service_pathway_state` and so on. An
explicit `tableName`, `leasesTable` or `instancesTable` overrides the prefix.

## Rules

- Do not create these tables in application migrations. The library owns their DDL and changes it
  between versions.
- Do not accept a `db push` or schema-sync prompt that drops, renames, clears or alters them.
- Do not truncate them to "reset" anything. Clearing `pathway_pump_state` moves consumers; clearing
  `pathway_leases` or `pathway_state` breaks coordination and blocking writes. Use the control plane
  or `resetPump()` for cursor changes.

## Drizzle

Exclude the tables from Drizzle's view of the schema:

```typescript
// drizzle.config.ts
export default defineConfig({
  // ...
  tablesFilter: ["!pathway_*"], // or ["!orders_service_pathway_*"] with a statePrefix
})
```

The filter stops `drizzle-kit push` and `pull` from treating the library tables as drift.

- For journaled migrations (`drizzle-kit generate`), SQL is built from your schema files. Any table
  declared there, including a mirror, becomes a `CREATE TABLE` in a migration. Keep mirrors out of the
  files listed in the Drizzle `schema` config. After generating, grep the SQL:
  `grep -rn "pathway_" drizzle/` (your migrations folder) must return nothing.
- In the deploy job, run journaled migrations (`drizzle-kit migrate` or your migrator). `drizzle-kit push`
  is for local development only. It can prompt, a deploy job cannot answer a prompt, and `--force`
  accepts destructive changes without asking.
- Declare a read-only mirror only if application code needs typed reads of a library table, or in a
  push-only project that cannot use `tablesFilter`. Copy the shape from the installed library's DDL and
  never write to it. In projects that use `drizzle-kit generate`, keep mirrors outside the Drizzle
  `schema` files. Example for the pump cursor table in 2.10.4:

```typescript
import { pgTable, primaryKey, text } from "drizzle-orm/pg-core"

export const pathwayPumpState = pgTable("pathway_pump_state", {
  flowType: text("flow_type").notNull(),
  pumpGroup: text("pump_group").notNull().default("default"),
  timeBucket: text("time_bucket").notNull(),
  eventId: text("event_id"),
}, (t) => [primaryKey({ columns: [t.flowType, t.pumpGroup] })])
```

If `db push` ever proposes dropping `pump_group` or another library column, stop: a mirror is stale
or a table escaped the filter. Fix the filter or mirror; do not confirm the prompt.

## Other ORMs and schema tools

The same rule applies to Prisma, Kysely codegen, TypeORM synchronize, Atlas and similar tools: exclude
`pathway_*` (or the prefixed names) from diffing and synchronisation. If the tool cannot exclude
tables, give the library its own schema or database through the connection string.

## First boot and upgrades

If a mirror references a column the library adds at runtime, boot the service once (or run one
`startPump()` against the database) so the library migrates its own tables, then run your ORM
tooling. Do not add the column through an application migration.
