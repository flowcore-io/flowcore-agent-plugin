# Resilient cluster start

Verified against `@flowcore/pathways` 2.10.4 (`src/pathways/builder.ts`,
`src/pathways/cluster/cluster-manager.ts`, `src/pathways/pump/pathway-pump.ts`) and
`@flowcore/data-pump` 0.23.3.

Use this in every production virtual service. The naive `await startCluster(); await startPump()`
works on a good day. On a bad day it leaves a pod that looks healthy while no event is delivered.

## Why the naive start stalls

The cluster lease and the pump are separate. The lease loop renews the lease for as long as the
process runs and the database answers. Nothing in the library ties the lease to a working pump.

| Failure | What the library does | Result without the pattern below |
|---|---|---|
| `startPump()` throws on the leader (transient 5xx or 401 from Flowcore, IAM 403, database error, missing event type) | Stops the pump and rethrows. The cluster keeps running and keeps the lease. | The app logs the error and continues. The pod leads the cluster with no pump. Nothing is delivered and no other pod can take over. |
| `startPump()` throws on a follower | Rethrows before the pump object exists. | If this pod becomes leader later, the leadership handler sees no pump and does nothing. Same stall. |
| A follower becomes leader and the pump bootstrap fails (delivery state read, data pump start, pathway registration) | Logs `Failed to bootstrap leader runtime after becoming leader` and nothing else. No retry, no lease release. | The new leader keeps the lease with no pump. This is the most common silent stall. |
| A data pump group fails at start | `PathwayPump` already set `isRunning` to `true`, and the groups after the failed one never start. | `pathways.pump?.isRunning` reports `true` while some flow types are dead. Do not use it as the only health signal. |
| A retry calls `startCluster()` again | Throws `Cluster already started`. A failed start leaves the cluster manager in place. | The retry loop fails on every attempt and never reaches `startPump()`. |
| `logger.error(msg, { error })` in the app | `Error` fields are not enumerable. | Logs show `{}` and hide the cause. |

The library already restarts a data pump group with backoff when it fails *after* a successful start
(1 s doubling to 30 s, without limit). The gap is the start itself and the leader bootstrap.

## The rules

1. **Never swallow a start error.** `startPathways().catch(console.error)` is the root cause of most
   stalls. A start error must end in a retry or in a process exit.
2. **Retry the whole start, and tear down before each retry.** Call `stopPump()` then `stopCluster()`
   after every failed attempt. `stopCluster()` releases the lease if this pod holds it, so another pod
   can lead at once. Then start the cluster and the pump again from scratch.
3. **Bound the retries, then exit.** After the last attempt, tear down and exit with a non-zero code,
   so the orchestrator restarts the pod and the crash loop is visible. A pod that stays alive with a
   failed start must not hold the lease.
4. **Treat a failed leader bootstrap as fatal.** Detect `Failed to bootstrap leader runtime after
   becoming leader` in the logger adapter, then tear down and exit.
5. **Watch the leader.** A leader without a running pump for longer than a grace period tears down and
   exits. This catches every path that rule 4 does not.
6. **Serve HTTP before the pathways start.** Liveness must not depend on pathways. Readiness reports
   the pathways status. Otherwise a slow start fails the liveness probe and hides the real error.
7. **Log `message`, `name` and `stack` of every error explicitly.**
8. **Give every handler a timeout.** A handler that never settles blocks its pump group for good. A
   handler that throws is retried (`maxRetries`, default 3), then redelivered by the data pump
   (`maxRedeliveryCount`, default 3), then dropped with the log line `Failed N events`. It does not
   stall the pump, but the event is lost, so record it with `onAnyError`.

## Reference implementation

Two files. They replace `startPathways` and `stopPathways` of the minimal example in `SKILL.md`.
Node and Bun. Under Deno replace `process.exit(1)` with `Deno.exit(1)`.

### `pathways-logger.ts`

Pass this logger to `new PathwaysBuilder({ logger: pathwaysLogger, ... })`. Route the lines to your
own logger in real code. Keep the fatal detection.

```typescript
import type { Logger, LoggerMeta } from "@flowcore/pathways"

// The library logs this line and does nothing else: the leader keeps its lease with no pump.
const LEADER_BOOTSTRAP_FAILED = "Failed to bootstrap leader runtime after becoming leader"

let onFatal: (reason: string, error?: Error) => void = () => {}

/** Called by the pathways runtime. Kept separate so the builder module has no import cycle. */
export function setPathwaysFatalHandler(handler: (reason: string, error?: Error) => void) {
  onFatal = handler
}

export function describeError(error: unknown) {
  return error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack }
    : { message: String(error) }
}

export const pathwaysLogger: Logger = {
  debug: (message: string, context?: LoggerMeta) => console.debug(message, context ?? {}),
  info: (message: string, context?: LoggerMeta) => console.info(message, context ?? {}),
  warn: (message: string, context?: LoggerMeta) => console.warn(message, context ?? {}),
  error(messageOrError: string | Error, errorOrContext?: Error | LoggerMeta, context?: LoggerMeta) {
    const message = typeof messageOrError === "string" ? messageOrError : messageOrError.message
    const error = messageOrError instanceof Error
      ? messageOrError
      : errorOrContext instanceof Error
      ? errorOrContext
      : undefined
    const meta = errorOrContext instanceof Error ? context : errorOrContext
    console.error(message, { ...meta, ...(error ? { error: describeError(error) } : {}) })
    if (message === LEADER_BOOTSTRAP_FAILED) onFatal(message, error)
  },
}
```

### `pathways-runtime.ts`

```typescript
import type { ClusterManager } from "@flowcore/pathways"
import { pathways, startOnce } from "./pathways" // the module from SKILL.md, built with pathwaysLogger
import { describeError, pathwaysLogger as log, setPathwaysFatalHandler } from "./pathways-logger"

const MAX_START_ATTEMPTS = 6 // about 30 seconds of backoff, then exit
const LEADER_CHECK_INTERVAL_MS = 10_000
const LEADER_GRACE_MS = 60_000 // leader bootstrap includes provisioning and registration

type PathwaysStatus = "starting" | "up" | "down"
let status: PathwaysStatus = "starting"
let lastError: string | undefined
let cluster: ClusterManager | null = null
let stopping = false
let watchdog: ReturnType<typeof setInterval> | undefined

/** For the readiness endpoint. Never use it for liveness. */
export function pathwaysHealth() {
  return { status, lastError, role: cluster?.currentRole ?? "standalone" }
}

async function teardown() {
  // stopPump first, then stopCluster: stopCluster releases the lease when this pod leads.
  await pathways.stopPump().catch((err) => log.warn("stopPump failed", { error: describeError(err) }))
  await pathways.stopCluster().catch((err) => log.warn("stopCluster failed", { error: describeError(err) }))
  cluster = null
}

async function fail(reason: string, error?: unknown) {
  if (stopping) return
  stopping = true
  status = "down"
  if (watchdog) clearInterval(watchdog)
  log.error(`${reason}. Exiting so the orchestrator restarts this instance`, {
    error: error === undefined ? undefined : describeError(error),
  })
  await teardown() // release the lease so another instance can lead now
  process.exit(1)
}

function startLeaderWatchdog() {
  if (!cluster) return // standalone pump: rule 4 and the start retry cover it
  let unhealthySince: number | null = null
  watchdog = setInterval(() => {
    const leaderWithoutPump = cluster?.isLeader === true && pathways.pump?.isRunning !== true
    if (!leaderWithoutPump) {
      unhealthySince = null
      return
    }
    unhealthySince ??= Date.now()
    if (Date.now() - unhealthySince >= LEADER_GRACE_MS) {
      void fail("Cluster leader holds the lease but runs no pump")
    }
  }, LEADER_CHECK_INTERVAL_MS)
}

/** Never rejects. Start it after the HTTP server listens: `void startPathways()`. */
export async function startPathways() {
  setPathwaysFatalHandler((reason, error) => void fail(reason, error))

  for (let attempt = 1; attempt <= MAX_START_ATTEMPTS; attempt++) {
    if (stopping) return
    try {
      cluster = await startOnce() // startCluster (production) + startPump, one attempt
      status = "up"
      lastError = undefined
      startLeaderWatchdog()
      log.info("Pathways started", { attempt, role: cluster?.currentRole ?? "standalone" })
      return
    } catch (err) {
      lastError = describeError(err).message
      log.error("Pathways start attempt failed", { attempt, error: describeError(err) })
      await teardown() // never keep a half-started cluster that holds the lease
      if (attempt < MAX_START_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(1_000 * 2 ** (attempt - 1), 30_000)))
      }
    }
  }
  await fail(`Pathways did not start after ${MAX_START_ATTEMPTS} attempts`)
}

export async function stopPathways() {
  if (stopping) return
  stopping = true
  if (watchdog) clearInterval(watchdog)
  await teardown()
}
```

### Boot

```typescript
const server = startHttpServer({
  "/health/live": () => ({ ok: true }), // no dependency on pathways or the database
  "/health/ready": () => {
    const health = pathwaysHealth()
    return { ok: health.status === "up", pathways: health }
  },
})
void startPathways()

let shuttingDown = false
process.on("SIGTERM", async () => {
  if (shuttingDown) return
  shuttingDown = true
  await server.stop()
  await stopPathways()
  await closeDatabasePool()
  process.exit(0)
})
```

`startHttpServer` and `closeDatabasePool` stand for your own code. A service whose HTTP routes await
`pathways.write()` can also return 503 from those routes while the status is not `up`.

## Handler timeout

```typescript
function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer))
}

pathways.handle("order.0/order.placed.0", (event) =>
  withTimeout(ordersReadModel.upsert(event.payload), 5_000, `order.placed ${event.eventId}`)
)

pathways.onAnyError((error, event, pathway) => {
  log.error("Handler failed", { pathway, eventId: event.eventId, error: describeError(error) })
})
```

The timeout does not cancel the work. Keep handlers idempotent, and give database and HTTP clients
their own timeouts too.

In cluster mode one delivery to a follower includes the in-process retries. Keep
`(maxRetries + 1) × handler timeout + retry delays` below `deliveryTimeoutMs` (default 30 000).
With the defaults (`maxRetries` 3, `retryDelayMs` 500, delays 500 + 1 000 + 1 500 ms), a 5 000 ms
timeout gives 23 000 ms. A longer total makes the leader time out the delivery and process the
event again itself.

## Kubernetes

- Liveness probe: `/health/live`. Readiness probe: `/health/ready`.
- `terminationGracePeriodSeconds` longer than the slowest handler plus shutdown.
- `POD_IP` from the downward API (`status.podIP`) and the cluster port open between pods.
- Alert on restarts and on pathway pulses. An exit caused by this pattern is a crash loop you can
  see, which is the point.

## Verify

- Kill the database connection during boot: every attempt logs `Pathways start attempt failed` with
  a real message, and the pod exits after the last attempt.
- Scale to two pods and delete the leader: the other pod logs `Acquired leader lease`, then
  `Pump started`, within `leaseTtlMs` plus the bootstrap time.
- In a test environment only: revoke the `fetch` action of the API key and delete the leader pod: the new leader fails its
  bootstrap, exits, and releases the lease. Restore the key and the cluster recovers without help.
- `get_data_pathway` and `show_pathway_dashboard` show fresh pulses after each test.
