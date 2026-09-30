# Evaluation scenarios

Use these to test an answer produced with this skill. Each lists what the answer must and must not
contain.

## Default setup for a long-running service

Input: "Set up a new long-running service that consumes and writes Flowcore events."

Must include:
- `pathwayMode: "virtual"` set explicitly, with `pathwayName` and `autoProvision: { pathway: true }`
- descriptions on owned data core, flow types and event types
- chained `.register(...)` calls and typed `.handle()` on registered keys
- `withPathwayState(createPostgresPathwayState(...))`,
  `withPathwayChunkStore(createPostgresPathwayChunkStore(...))` and a Postgres delivery store,
  all with the same connection string and `statePrefix`
- a verification step that checks the pathway with `list_data_pathways` / `get_data_pathway`

Must not include:
- `InternalPathwayChunkStore` in production
- a claim that chunking is on without a chunk store
- application migrations for `pathway_*` tables

## Production virtual pathway

Input: "Run this virtual pathway in production."

Must include:
- `startCluster()` before `startPump()`
- the pump runs only on the leader
- shared PostgreSQL for coordination and state
- stop-and-ask when the runtime is serverless

Must not include:
- a standalone production pump without cluster mode
- managed delivery as an automatic fallback
- cluster mode inside Next.js or another serverless runtime

## Serverless production target

Input: "Deploy the consumer to Vercel."

Must include:
- an explanation that virtual cluster mode needs a long-running process and an open port
- a question: move the consumer to a long-running service, or choose managed delivery
- if the user picks managed: `pathwayMode: "managed"`, `managedConfig.endpointUrl`, a `PathwayRouter`
  route with a secret

Must not include:
- switching to managed without the user's decision
- `startCluster()` in the serverless app

## Development boot

Input: "Run the service locally."

Must include:
- a local pump without cluster mode
- no control-plane pathway registration in development
- `NODE_ENV` or `runtimeEnv` decides the behaviour

Must not include:
- `allowDevelopmentPathwayRegistration: true` without a stated control-plane reason

## Write-only event

Input: "Write audit events, but this service does not consume them."

Must include:
- `register({ subscribe: false })` with `writable` left true
- `fireAndForget: true` on those writes
- the pump skips that pathway

Must not include:
- an empty no-op handler
- `writable: false` as the fix

## Awaited local CRUD

Input: "Add a create endpoint; the handler runs in the same app."

Must include:
- `await pathways.write(...)` without `fireAndForget`
- return the created resource after the write resolves
- a timeout means the event is stored; do not retry the write

Must not include:
- `fireAndForget: true` unless the user asked for it
- returning `{ status: "processing" }` and polling for status

## ORM wants to drop library tables

Input: "`db:push` wants to drop `pathway_pump_state` and `pathway_leases`."

Must include:
- these tables are owned by the library and created at runtime
- do not confirm the prompt
- `tablesFilter: ["!pathway_*"]` (or the prefixed form), or a corrected read-only mirror
- no application migrations for these tables

Must not include:
- dropping, clearing or recreating `pathway_state`, `pathway_pump_state`, `pathway_leases`,
  `pathway_instances`, `pathway_chunks` or `pathway_delivery_state`

## Journaled migrations

Input: "We use `drizzle-kit generate` and a `pathway_` table appeared in the generated SQL."

Must include:
- remove the table (or mirror) from the Drizzle schema files and keep `tablesFilter` exclusions
- grep the generated SQL for `pathway_` before committing
- `drizzle-kit push` is for local development, not the deploy job

Must not include:
- `CREATE TABLE pathway_state` in an application migration
- `drizzle-kit push --force` in a deploy hook

## Encrypted payloads

Input: "Set up a pathway with encrypted payloads."

Must include:
- `encryption: { mode: "symmetric", key }` on the builder
- `encrypted: true` on the registration
- whole-payload encryption with an `encryptedPayload` envelope

Must not include:
- `enableEncryption()`, `encryptedFields`, `keyRotationInterval`, or field-level encryption
- encrypted file pathways

## Unverifiable API

Input: "Use the built-in helper that rotates pathway encryption keys automatically."

Must include:
- "I cannot verify that API"
- a verified alternative, for example rotating the key outside the library with a planned re-deploy

Must not include:
- an implementation of a key-rotation helper

## Two services share one database

Input: "Two services use the same Postgres; only one of them processes events."

Must include:
- a distinct `statePrefix` per deployable on every Postgres store and the coordinator
- the lease-key log line to confirm the fix

Must not include:
- a separate database as the only option
