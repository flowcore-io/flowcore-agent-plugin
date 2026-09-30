# Setup reference

Verified against `@flowcore/pathways` 2.10.4 (`src/pathways/builder.ts`, `src/pathways/types.ts`).
Install with `npm install @flowcore/pathways` or `npx jsr add @flowcore/pathways`. The library needs
`zod` 3 (peer dependency `^3.25.63`); event schemas must be Zod object schemas.

## Before you edit

Find the existing setup instead of assuming a layout:

```text
grep -rn "PathwaysBuilder" src
grep -rn "pathways.write\|\.register({\|\.handle(" src
grep -rn "startCluster\|startPump\|withPathwayState\|withPathwayChunkStore" src
grep -rn "FLOWCORE_" .env* deploy* 2>/dev/null
```

Reuse the project's env var names. If there are none, propose names and ask before adding them.

## `PathwaysBuilder` constructor options

Required: `baseUrl`, `tenant`, `dataCore`, `apiKey`. The README uses `baseUrl: "https://api.flowcore.io"`.
Since 2.10.3 the same `baseUrl` is also passed to the data pump source.

| Option | Default | Notes |
|---|---|---|
| `runtimeEnv` | from `NODE_ENV` | `"development" \| "production" \| "test"`. Any other value, or unset, becomes `development`. |
| `pathwayMode` | `managed` in production, else `virtual` | Set `"virtual"` explicitly for the default model. |
| `pathwayName` | none | Required for by-name registration of a virtual pathway. Keep it distinct per environment. |
| `pathwayLabels` | `{}` | Sent on every registration. Set `name` and `description` so the pathway is readable in the console. |
| `autoProvision` | `{ dataCore: true, flowType: true, eventType: true, pathway: false }` | Object on the builder. Omitted fields keep their defaults. |
| `allowDevelopmentPathwayRegistration` | `false` | Escape hatch for control-plane work only. Warns on every boot. |
| `dataCoreDescription` | none | Set only if this service owns the data core. |
| `dataCoreAccessControl` | `"private"` | Used when the data core is created. |
| `dataCoreDeleteProtection` | `false` | Used when the data core is created. |
| `provisionFailure` | check: continue, apply: throw | `"throw"`, `"continue"`, or `{ check, apply }`. |
| `provisionConcurrency` | `4` | Parallel sibling operations during provisioning. |
| `provisionRetry` | 3 attempts | `{ maxAttempts, baseDelayMs, maxDelayMs, jitterRatio }`. |
| `managedConfig` | none | `{ endpointUrl, authHeaders?, sizeClass? }`. Only for managed mode. |
| `pathwayTimeoutMs` | `10000` | How long a blocking `write()` waits for processing. |
| `logger` | `NoopLogger` | Pass a `Logger` (for example `new ConsoleLogger()`), or you see nothing. |
| `logLevel` | see source | `writeSuccess`, `pulseSuccess`, `pulseFailure`, `provisionSuccess`, `provisionFailure`. |
| `encryption` | none | `{ mode: "symmetric", key }`. See below. |
| `chunking` | 64 000 / 45 000 bytes | `{ enabled?, maxEventBytes?, partBudgetBytes? }`. Active only with a chunk store. |
| `pulseUrl`, `pulseIntervalMs`, `commandPollingIntervalMs` | control-plane defaults | Leave unset unless told otherwise. |

`advertisedUrl`, `resetSecret` and `resetPath` are deprecated and unused. `defaultAutoProvision` is
deprecated; use `autoProvision`.

Builder methods that return the builder: `withPathwayState`, `withPathwayChunkStore`,
`withPathwayDeliveryStore`, `withAudit`, `withUserResolver`, `withSessionUserResolver`,
`register`, `handle`, `subscribe`, `onError`, `onAnyError`.

## What provisioning does per runtime

| `runtimeEnv` | Shared resources (data core, flow types, event types) | Pathway registration | Local pump |
|---|---|---|---|
| `development` | provisioned | skipped (2.5.5+) | started, single instance |
| `production` + `virtual` | provisioned | with `pathwayName` and `autoProvision.pathway: true`, done by the leader | leader only, cluster required |
| `production` + `managed` | provisioned | with `autoProvision.pathway: true`, needs `managedConfig.endpointUrl` | not started |
| `test` | skipped by `startPump()` | skipped | started |

- `provision(override?)` runs provisioning without starting a pump. Use it in CI or bootstrap jobs.
- `startPump({ autoProvision })` accepts a boolean or object that overrides the builder setting.
- Provisioning is additive. It creates missing resources and updates drifted descriptions. It never deletes.

### Ownership by description

| Level | Field | Set | Not set |
|---|---|---|---|
| Data core | `dataCoreDescription` (constructor) | create or update | must already exist |
| Flow type | `flowTypeDescription` (`register`) | create or update | must already exist |
| Event type | `description` (`register`) | create or update | must already exist |

Only describe what this service owns. Register events owned by another service without descriptions,
so the provisioner treats them as references and never changes them.

## `register()` contract

```typescript
.register({
  flowType: "order.0",          // literal string; forms the key "order.0/order.placed.0"
  eventType: "order.placed.0",
  schema: OrderPlaced,          // zod object schema; drives payload types
  writable: true,               // default true; false removes the path from write()
  subscribe: true,              // default true; false = pump does not pull this pathway
  pumpGroup: "hot",             // optional; separate pump and cursor inside one flow type
  maxRetries: 3,                // default 3
  retryDelayMs: 500,            // default 500
  timeoutMs: 10000,             // optional per-pathway processing timeout
  encrypted: false,             // whole-payload encryption; needs builder encryption key
  isFilePathway: false,         // file pathways cannot be encrypted, batched, or chunked
  flowTypeDescription: "...",   // ownership, see above
  description: "...",           // ownership, see above
})
```

Chain `.register(...)` calls on the builder. Each call extends the builder type, so `handle`, `write`
and `subscribe` only accept registered keys and infer payload types from the schema. Splitting
registration through untyped helpers loses this.

## Handlers

```typescript
pathways.handle("order.0/order.placed.0", async (event) => {
  // event: FlowcoreEvent<z.infer<typeof OrderPlaced>>
  // fields: eventId, timeBucket, tenant, dataCoreId, flowType, eventType, metadata, payload, validTime
})
```

- One handler per path per instance. A second `.handle()` on the same path throws.
- The payload is already validated and decrypted. Do not `JSON.parse` it.
- Make handlers idempotent. Leader failover and retries can deliver an event again.
- A registered, subscribed path with no handler is marked processed after observers run.
- Errors: `onError(path, (error, event) => ...)` and `onAnyError((error, event, pathway) => ...)`.

## Observers are not `subscribe: false`

- `.subscribe(path, handler, "before" | "after" | "all")` adds a local observer around processing.
  The default stage is `"before"`. Use it for logs and metrics, not for state changes.
- `register({ subscribe: false })` stops the pump from pulling that pathway. `.write()` still works.
  A `.handle()` on it is accepted but never runs.
- `subscribe: false` does not remove the flow type from pathway registration. The virtual pathway's
  flow type list and managed sources are built from all registrations. Remove a registration you no
  longer need instead of relying on the flag for control-plane scope.
- `writable: false` only blocks writes. It is not a fix for pump back-pressure.

## Writing

```typescript
await pathways.write(path, {
  data,                       // validated against the schema before sending
  metadata: { source: "api" },
  options: {
    fireAndForget: false,     // default: wait until processed
    auditMode: "user",        // or "system"
    sessionId: "...",
    headers: {},
  },
})
await pathways.write(path, { batch: true, data: [a, b] }) // returns one id per item
```

- Without `fireAndForget`, `write()` polls the pathway state until the event is processed. The handler
  may run on another instance in cluster mode, so the pathway state must be the shared Postgres store.
- A timeout error means the event is stored and will still be processed. Do not retry the write; it
  would duplicate the event. If a dropped notification must not fail the call, raise
  `pathwayTimeoutMs` above the pump's 20 s safety re-poll (the README suggests 25 000).
- Use `fireAndForget: true` for `subscribe: false` pathways, for events handled by another service,
  and when the user asks for asynchronous request handling.
- Write events for state changes. Do not write domain state straight to the database from API code
  and then emit an event afterwards; the handler owns the read model.

## Encryption (optional)

```typescript
new PathwaysBuilder({ /* ... */ encryption: { mode: "symmetric", key: process.env.PATHWAYS_ENCRYPTION_KEY } })
  .register({ flowType: "secret.0", eventType: "secret.created.0", schema, encrypted: true })
```

- Whole-payload AES-256-GCM. The event carries `{ encryptedPayload }` and metadata
  `pathways/encrypted: "true"`, `pathways/encryption-scheme: "aes-256-gcm-sha256-v1"`.
- `write()` validates plaintext first. Processing decrypts before validation and handlers.
- Without a key, `encrypted: true` pathways are written in plaintext and no marker is added.
- There is no field-level encryption and no key rotation in the library. Design rotation outside it.
- Encrypted payloads are opaque to Flowcore indexing and sensitive-data masking.
- File pathways cannot be encrypted (`register()` throws).

## Managed mode (only when the user chooses it)

Managed delivery means Flowcore workers POST events to your app. Use it when the user explicitly picks
it, usually for serverless apps.

```typescript
const pathways = new PathwaysBuilder({
  /* ... */
  pathwayMode: "managed",
  pathwayName: "orders-web-prod",
  autoProvision: { pathway: true },
  managedConfig: {
    endpointUrl: "https://app.example.com/api/transformer",
    authHeaders: { "x-secret": process.env.TRANSFORMER_SECRET! },
  },
})

// HTTP route
import { PathwayRouter } from "@flowcore/pathways"
const router = new PathwayRouter(pathways, process.env.TRANSFORMER_SECRET!)
export async function POST(req: Request) {
  const secret = req.headers.get("x-secret") ?? ""
  await router.processEvent(await req.json(), secret)
  return Response.json({ status: "ok" })
}
```

- `startPump()` in production + managed provisions and returns without starting a local pump.
  `provision()` does the same without creating a pump object.
- In development the same app can run a local pump (`NODE_ENV=development`) with no cluster.
- Serverless platforms may not run startup hooks reliably. Run `pathways.provision()` as a deploy step
  if provisioning must happen before traffic.
- `PathwayRouter` throws when the secret is empty.

## Serverless and Next.js

Do not call `startCluster()` or run a production pump inside a serverless or stateless HTTP runtime.
Known failures: startup hooks that do not run in standalone builds, WebSocket port collisions when the
module is evaluated more than once, and leases that nobody renews. Stop and ask the user whether to
run the consumer as a long-running service or to use managed delivery.
