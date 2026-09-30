# Event modeling

## Data core
One data core per bounded context or product area, e.g. `billing`, `identity`. A data core is also the natural IAM boundary: most policies grant access per data core.

Create a new data core when:
- a different team owns the events, or
- access to the events must be granted separately.

## Flow type
One flow type per entity or aggregate whose events are read together, e.g. `invoice.0`. A consumer usually subscribes per flow type, and a Data Pathway pump runs per flow type.

## Event type
One event type per fact: `invoice.created.0`, `invoice.paid.0`, `invoice.voided.0`.

- Past tense. The event says what happened.
- Carry the entity id in the payload (for example `invoiceId`), so consumers can build state.
- Keep payloads self-contained. A consumer should not need a second call to understand the event.
- Mark personal data with sensitive-data masking on the event type (`sensitiveDataMask` with `key` = JSON path to the entity id and `schema` = fields to mask).

## Versioning
- Additive, optional fields: keep the version.
- Removed, renamed or re-typed fields: create `<name>.<n+1>` and write both until every consumer moved.

## Anti-patterns
- One catch-all event type with a `type` field inside the payload.
- Commands as events (`send-email.0`).
- Reusing an event type name with a new meaning.
