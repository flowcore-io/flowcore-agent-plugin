# Cluster mode and the data pump

Verified against `@flowcore/pathways` 2.10.4 (`src/pathways/builder.ts`,
`src/pathways/cluster/*`, `src/pathways/pump/*`).

## How it works

- Every instance calls `startCluster()`. They elect one leader through a lease row in PostgreSQL.
- Every instance calls `startPump()`. Only the leader starts the pump. Followers create the pump object
  but do not start it, so they can take over immediately.
- The leader fetches events and sends them over WebSocket to followers (round robin). If no follower is
  available, the leader processes events itself.
- When the leader loses its lease, it stops its pump. The next instance to acquire the lease starts its
  pump from the cursor saved in PostgreSQL. Some events may be processed again, so handlers must be
  idempotent.
- In production + virtual, the leader also registers the virtual pathway (when `pathwayName` and
  `autoProvision.pathway: true` are set), sends pulses and polls the control plane for commands.

## Startup order

```typescript
// 1. Register pathways and handlers, configure state stores (module scope).
// 2. Join the cluster.
await pathways.startCluster({ coordinator, advertisedAddress, port: 9090 })
// 3. Start the pump. Deferred on followers.
await pathways.startPump({ stateManagerFactory, notifier: { type: "websocket" } })
```

In production + virtual, `startPump()` without an active cluster throws
`Cluster mode must be started before production virtual pump startup`.

Shutdown:

```typescript
process.on("SIGTERM", async () => {
  await pathways.stopPump()
  await pathways.stopCluster()
})
```

## `startCluster(options)` (`PathwayClusterOptions`)

| Option | Default | Notes |
|---|---|---|
| `coordinator` | required | `await createPostgresPathwayCoordinator(pgConfig, { statePrefix })` |
| `advertisedAddress` | required | Host or IP only. The library registers `ws://<advertisedAddress>:<port>`. Must be unique and reachable from the other instances (for example the pod IP). |
| `port` | required | WebSocket port. Must be open between instances. No load balancer is needed. |
| `statePrefix` | none | Namespaces the lease key. Setting it on the coordinator is enough. |
| `leaseKey` | derived | Explicit lease key. Overrides the prefix. |
| `leaseTtlMs` | 30 000 | A crashed leader is replaced after this. |
| `leaseRenewIntervalMs` | 10 000 | |
| `heartbeatIntervalMs` | 5 000 | |
| `staleThresholdMs` | 15 000 | A follower without heartbeat for this long is dropped. |
| `deliveryTimeoutMs` | 30 000 | |
| `workerConcurrency` | 5 | |
| `transport` | auto | Deno APIs under Deno, the `ws` package under Node and Bun. |

## `startPump(options)` (`PathwayPumpOptions`)

| Option | Default | Notes |
|---|---|---|
| `stateManagerFactory` | required | `await createPostgresPumpStateManagerFactory({ connectionString, statePrefix })` in any shared or production setup. |
| `notifier` | `{ type: "websocket" }` | Also `{ type: "poller", pollerIntervalMs }` and `{ type: "nats", natsServers }`. |
| `bufferSize` | 1000 | Events held per pump. |
| `maxRedeliveryCount` | 3 | |
| `autoProvision` | builder setting | Boolean or `AutoProvisionConfig`. Overrides the builder for this call. |
| `concurrency` | 1 | Number, or `{ default, byFlowType, byPumpGroup }`. Keys of `byPumpGroup` are `"flowType::pumpGroup"`. |
| `pulse` | auto | Set automatically after virtual registration. Leave unset. |

Before 2.5.4 the `poller` and `nats` notifiers were silently ignored and every pump used `websocket`.

### Pump groups

`register({ pumpGroup: "hot" })` puts event types of one flow type on separate pumps with separate
cursors and concurrency. The WebSocket notifier is flow-type scoped, so isolation is in processing and
state, not in bandwidth. Omit `pumpGroup` (or use `"default"`) for one pump per flow type.

## Shared PostgreSQL and `statePrefix`

All instances of one deployable use the same database and the same `statePrefix` for:
`createPostgresPathwayState`, `createPostgresPathwayChunkStore`, `createPostgresPathwayDeliveryStore`,
`createPostgresPumpStateManagerFactory` and `createPostgresPathwayCoordinator`.

When two deployables share one connection string, give each its own prefix (letters, digits and
underscores, starting with a letter or underscore, at most 40 characters). Without it they fight over
one lease. Only one deployable runs a pump and the other's projections stall while its writes still
succeed. `ClusterManager` logs its `leaseKey`; two deployables reporting the same key are contending.

The pathway state must be the shared Postgres store in cluster mode. A blocking `write()` polls the
pathway state for the event, and the handler may run on a different instance.

## Chunk store

```typescript
pathways.withPathwayChunkStore(createPostgresPathwayChunkStore({ connectionString, statePrefix }))
```

- Chunking is off until a store is configured. Then events over `maxEventBytes` (64 000) are split into
  parts of at most `partBudgetBytes` (45 000) and reassembled before validation and handlers.
- Size is measured after encryption. Parts of encrypted pathways are encrypted one by one.
- In cluster mode, reassembly happens on the leader before distribution.
- Options: `ttlMs` (default 1 hour for incomplete chunks), `cleanupIntervalMs` (default 60 000).
- Every consumer of a chunked pathway must run 2.8.0 or later with a chunk store.
- `eventTimeKey` cannot be resolved for chunked or encrypted items. `eventTime` and `validTime` still work.
- `InternalPathwayChunkStore` is in memory: tests and a single local process only.

## Pause and resume

Pause is available from 2.9.0; restoring it from the control plane at boot from 2.10.0.

- Operators pause and resume from the control plane (console, MCP `pause_data_pathway` /
  `resume_data_pathway`, or API). The commands reach the leader through the poll-based command queue.
  Details belong to the `flowcore-data-pathways` skill.
- A paused pump keeps fetching into its buffer, keeps its cursor, and keeps sending pulses. Only
  delivery to handlers stops. A batch already in a handler finishes and is acknowledged.
- `write()` keeps working while paused. Blocking writes to a paused pathway will time out.
- Targets: `"orders.0"` (all pump groups of a flow type), `"orders.0::hot"` (one pump), or none (all).
  A command that matches no pump is reported as failed.
- Durability: at boot, a registered virtual pathway reads `deliveryState` from the control plane and
  seeds the pause before the pumps start. If the control plane cannot answer, the library falls back to
  the local delivery store. The default store is in memory, so configure
  `withPathwayDeliveryStore(createPostgresPathwayDeliveryStore({ connectionString, statePrefix }))`.
  Development boots do not read the control plane.

In code (leader only; `pathways.pump` is `null` before `startPump()` and on followers):

```typescript
const pump = pathways.pump
pump?.pause({ keys: ["orders.0::hot"] })  // returns the keys it acted on
pump?.isPaused("orders.0", "hot")
pump?.pausedGroups
pump?.resume()                            // all pumps
```

Prefer the control-plane command so the console and the process agree.

## Reset

`pathways.resetPump(position?, filter?)` moves the cursor. Without a position it clears saved state
and restarts from the live position. In cluster mode the request goes to the leader, and the filter is
ignored (all pumps are reset, with a warning).

## Failure modes

| Situation | Result |
|---|---|
| Leader crashes | Lease expires after `leaseTtlMs`; another instance takes over from the saved cursor. |
| Follower crashes | Dropped after `staleThresholdMs`; events go to the remaining instances. |
| No followers | Leader processes events itself. |
| PostgreSQL unavailable | Lease renewal fails, the leader steps down and stops its pump. No instance leads until the database is back. |
| Network partition | Two leaders are possible for up to `leaseTtlMs`. Keep handlers idempotent. |
