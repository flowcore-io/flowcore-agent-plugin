---
name: flowcore-pathways
description: Use when building or changing a TypeScript app that writes or consumes Flowcore events with the @flowcore/pathways library, including registering event types, handlers, pathways.write, the data pump, cluster mode, auto-provisioning, virtual pathways, encryption, chunking and transformers. This is the SDK and build skill. Operating Data Pathways in the control plane (pause, restart, inspect, delete) belongs to the flowcore-data-pathways skill.
---

# Flowcore Pathways (`@flowcore/pathways`)

Verified against `@flowcore/pathways` 2.10.4. If the installed version differs, check the
library README and source before you rely on an option below.

## Glossary: two different things

- **Data Pathway**: a delivery resource in the Flowcore control plane. It has a type:
  - `virtual`: your own long-running process runs the data pump. The control plane only records the
    pathway, receives its pulses and sends it commands (pause, resume, restart).
  - `managed`: Flowcore workers run the pump and POST events to an HTTP endpoint in your app.
- **Pathways**: this TypeScript library. It registers event contracts, writes events, runs handlers,
  runs the pump, and can create a Data Pathway for you (auto-provisioning).

Do not mix them up. "Pause the pathway" is a control-plane operation (see `flowcore-data-pathways`).
"Add a handler" is a library change (this skill).

## Rules

Each rule has a reason. Keep the reason when you explain a decision to the user.

1. **Default to a virtual pathway with auto-provisioning.** Describe owned resources in code
   (`dataCoreDescription`, `flowTypeDescription`, `description`) and let the library create them.
   Set `pathwayMode: "virtual"` explicitly. Reason: when `runtimeEnv` is `production` the library
   defaults `pathwayMode` to `managed`, so leaving it unset silently changes the delivery model.
2. **Use managed only when the user chooses it.** A typical case is a serverless app with no
   long-running process. Never switch to managed as an automatic fallback because something failed.
   Reason: managed changes who runs the pump and needs an HTTP endpoint, a secret and `managedConfig`.
3. **Production virtual runs in cluster mode.** Call `startCluster()` before `startPump()`. The pump
   runs only on the elected leader. All instances share one PostgreSQL database for leases, instances,
   pump cursors, pathway state and chunks. Reason: the library throws
   `Cluster mode must be started before production virtual pump startup` otherwise, and several
   standalone pumps would each process every event.
4. **Serverless cannot run cluster mode.** If production is Vercel, Lambda, Next.js standalone or any
   runtime without a stable long-lived process and an open WebSocket port, stop and ask the user.
   Offer: move the consumer to a long-running service, or choose managed delivery explicitly.
5. **Development runs a local pump and does not register a control-plane pathway.** With
   `runtimeEnv: "development"` (or `NODE_ENV` unset/unknown) the library skips the pathway upsert even
   with `autoProvision.pathway: true` (2.5.5+). Do not add `allowDevelopmentPathwayRegistration`
   unless the user is doing control-plane work on purpose. Reason: every laptop would create a shared
   pathway and could receive restart commands meant for production.
6. **Write-only events use `subscribe: false`.** Do not add an empty handler to drain them. Write
   them with `options: { fireAndForget: true }`. Reason: the pump does not pull a `subscribe: false`
   pathway, so nothing marks the event processed and a blocking write would time out.
7. **Library tables are not app schema.** `pathway_state`, `pathway_pump_state`, `pathway_leases`,
   `pathway_instances`, `pathway_chunks` and `pathway_delivery_state` (or their `statePrefix` forms)
   are created at runtime by the library. Exclude them from ORM migrations and never let `db push`
   drop or alter them. See [schema-and-migrations](references/schema-and-migrations.md).
8. **Configure the Postgres chunk store in long-running services.** Without
   `withPathwayChunkStore()`, events over 64 000 bytes fail with a Flowcore 400 and received part
   events throw. `InternalPathwayChunkStore` is single-process only.
9. **Pause is durable only with the right setup.** From 2.10.0 a registered virtual pathway reads its
   pause state from the control plane at boot and applies it before the pump starts. Also configure
   `withPathwayDeliveryStore(createPostgresPathwayDeliveryStore(...))`, because the default local store
   is in memory and is the fallback when the control plane cannot answer.
10. **Await `pathways.write()` for local CRUD.** When the handler runs in the same app, the default
    (no `fireAndForget`) returns after the handler has processed the event, so you can return the real
    resource. Use `fireAndForget: true` only when the user asks, or for write-only and remote-consumer
    events. A write timeout means the event is stored but not yet processed: do not retry the write.
11. **Never invent APIs.** If an option or method is not in the installed library, say
    "I cannot verify that API" and offer a verified alternative. Known non-existent examples:
    `enableEncryption()`, field-level encryption, automatic key rotation, `getStatus()`.

## Decision flow

```text
Consumer runtime in production?
  long-running, can open a port to peers -> virtual + cluster (default)
  serverless / no long-lived process     -> STOP. Ask: long-running service, or managed?
Does this service handle the event?
  yes -> register + .handle(), subscribe default (true)
  no  -> register({ subscribe: false }), write with fireAndForget
Handler in the same app as the writer?
  yes -> await pathways.write(...)   (default)
  no  -> fireAndForget: true, return an id and a processing status
```

## Minimal end-to-end example

One module, verified against 2.10.4. `NODE_ENV=production` gives cluster + leader-only pump +
virtual pathway registration. Any other value gives a single local pump and no registration.

```typescript
import { z } from "zod" // zod 3 (peer dependency ^3.25.63)
import {
  createPostgresPathwayChunkStore,
  createPostgresPathwayCoordinator,
  createPostgresPathwayDeliveryStore,
  createPostgresPathwayState,
  createPostgresPumpStateManagerFactory,
  ConsoleLogger,
  PathwaysBuilder,
} from "@flowcore/pathways"

const connectionString = process.env.DATABASE_URL!
const statePrefix = "orders_service" // one prefix per deployable sharing a database
const isProduction = process.env.NODE_ENV === "production"

const OrderPlaced = z.object({ orderId: z.string(), total: z.number() })
const OrderExported = z.object({ orderId: z.string(), target: z.string() })

export const pathways = new PathwaysBuilder({
  baseUrl: "https://api.flowcore.io",
  tenant: process.env.FLOWCORE_TENANT!,
  dataCore: process.env.FLOWCORE_DATA_CORE!,
  apiKey: process.env.FLOWCORE_API_KEY!,
  dataCoreDescription: "Orders service events", // omit if you do not own the data core
  pathwayMode: "virtual", // production default would be "managed"
  pathwayName: process.env.FLOWCORE_PATHWAY_NAME!, // distinct per environment
  pathwayLabels: { name: "Orders service", description: "Consumes order events" },
  autoProvision: { pathway: true }, // register the virtual pathway (skipped in development)
  logger: new ConsoleLogger(), // default is NoopLogger, which hides every log line below
})
  .withPathwayState(createPostgresPathwayState({ connectionString, statePrefix }))
  .withPathwayChunkStore(createPostgresPathwayChunkStore({ connectionString, statePrefix }))
  .withPathwayDeliveryStore(createPostgresPathwayDeliveryStore({ connectionString, statePrefix }))
  .register({
    flowType: "order.0",
    eventType: "order.placed.0",
    schema: OrderPlaced,
    flowTypeDescription: "Order lifecycle events",
    description: "An order was placed",
  })
  .register({
    flowType: "order.0",
    eventType: "order.exported.0",
    schema: OrderExported,
    subscribe: false, // written for history, not consumed here
    description: "An order was exported",
  })
  .handle("order.0/order.placed.0", async (event) => {
    // event.payload is typed from OrderPlaced. Keep the handler idempotent.
    await ordersReadModel.upsert(event.payload)
  })

export async function startPathways() {
  if (isProduction) {
    const coordinator = await createPostgresPathwayCoordinator({ connectionString }, { statePrefix })
    await pathways.startCluster({
      coordinator,
      advertisedAddress: process.env.POD_IP!, // host only; the library builds ws://host:port
      port: 9090,
    })
  }
  await pathways.startPump({
    stateManagerFactory: await createPostgresPumpStateManagerFactory({ connectionString, statePrefix }),
    notifier: { type: "websocket" },
  })
}

export async function stopPathways() {
  await pathways.stopPump()
  await pathways.stopCluster()
}

// In a request handler (same app handles the event):
export async function placeOrder(orderId: string, total: number) {
  const eventId = await pathways.write("order.0/order.placed.0", { data: { orderId, total } })
  return { eventId, order: await ordersReadModel.get(orderId) }
}

// Write-only event: never block on it.
export async function recordExport(orderId: string, target: string) {
  await pathways.write("order.0/order.exported.0", {
    data: { orderId, target },
    options: { fireAndForget: true },
  })
}
```

`ordersReadModel` stands for your own persistence code. In real code, pass an adapter to your own
logger that implements the library `Logger` interface (`debug`, `info`, `warn`, `error`).

## Verification checklist

Run these before you call the work done.

- [ ] Typecheck passes, and every `.handle()` / `.write()` path is a registered literal key.
- [ ] Boot logs (needs a real logger) show `Auto-provisioning Flowcore resources` and no provisioning error.
- [ ] Flow types and event types exist: MCP `list_flow_types` / `list_event_types`, or the console.
- [ ] Development boot logs `Skipping pathway-instance registration in development runtime`, and no new
      pathway appears in `list_data_pathways` for the tenant.
- [ ] Production: exactly one instance logs `Acquired leader lease`; the others log
      `Could not acquire lease, becoming worker`. All report the same `leaseKey` only if they are one deployable.
- [ ] Production: the leader logs `virtual pathway registered` with a `pathwayId`. MCP
      `list_data_pathways` (filter `tenant`) shows the pathway, and `get_data_pathway` with that id shows
      type `virtual` and the expected flow types. `show_pathway_dashboard` shows recent pulses.
- [ ] Events flow: an awaited `pathways.write()` returns without timeout and the read model changes.
      To inspect stored events use MCP `get_time_buckets`, then `get_events` with the event type id.
- [ ] Generated ORM migrations contain no `pathway_` tables (grep the SQL).
- [ ] Graceful shutdown calls `stopPump()` then `stopCluster()`.

## API keys and IAM

The API key in `apiKey` writes events, reads them through the pump, and (with auto-provisioning)
creates and updates the data core, flow types and event types. Grant only what the service needs.
Resource names use the form `frn::<tenant-name>:data-core/<data-core-uuid>` with lowercase actions such
as `ingest`, `fetch`, `read`, `write`, `sensitive-data-fetch` or `*`. Only the tenant segment is a name;
every other id is a full UUID. Use the `flowcore-iam` skill for policies, roles and key linking.

## References

- [references/setup.md](references/setup.md): builder options, `register()` contract, ownership by
  description, writing, handlers, observers, encryption, managed mode, serverless.
- [references/cluster-and-pump.md](references/cluster-and-pump.md): cluster options, leader-only
  pump, `statePrefix`, notifiers, concurrency and pump groups, pause and resume, failure modes.
- [references/schema-and-migrations.md](references/schema-and-migrations.md): library-owned
  tables, Drizzle `tablesFilter`, read-only mirrors, deploy-time migrations.
- [references/troubleshooting.md](references/troubleshooting.md): symptoms, causes and fixes.
- [references/evaluation-scenarios.md](references/evaluation-scenarios.md): scenarios to test
  answers produced with this skill.

---
Source: https://github.com/flowcore-io/flowcore-agent-plugin · Mirror: https://flowcore.io/agent/skills/index.json
Check the mirror at most once per day. Update this skill when the mirror version is newer.
