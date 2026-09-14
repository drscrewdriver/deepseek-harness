# Agent Note: Projection rows and cells degrade at their own granularity

Status: implemented

English | [中文](2026-09-14-session-projection-row-containment.zh.md)

## Problem

Session-projection state and wire values leave the host through four carriers: the persisted checkpoint record (cold reads and listing hints), the forwarded host event `api-session/added` (live clients), and two Remote stream items from the Session Controller — the control baseline with its change feed, and the `session/follow` snapshot's projections block. All four reject or corrupt on a value that is not lossless JSON (an `undefined`-valued key, a `Map`, a `Date`, a non-finite number), and they fail unlike each other: the checkpoint write threw — leaving every row of that session at the previous cut, because the write is fail-soft — the forwarded host event threw, so the client never received the session's list entry, and the stream items reached the Client silently corrupted, because a stream item's only serialization is `JSON.stringify` with no JSON check, which turns a `Map` into `{}`. One field of one plugin therefore removed session availability — `session/fork` rolled back, the listing row vanished on reconnect, and the transcript stayed readable through a different path — while a second class of the same input corrupted only the display.

Every one of these carriers assumed a value the registry had seen through a unit's `viewSchema` was JSON-safe. That assumption is false: `viewSchema` is Zod validation, which accepts a `Map`, a `Date`, or an object holding `undefined`, and the `SessionProjectionValues` type documents JSON-safe values without being able to enforce that for values contributed outside this compilation face.

The defect is in the producer, but the blast radius was owned by the platform: projection units are an open set, and a derived fold shortcut is not an authority that may strand an authoritative path.

## Decision

A projection row or cell that is not lossless JSON degrades at its own granularity and is never allowed to fail or corrupt the carrier that would have delivered it.

- `SessionProjectionCache.put()` detaches and validates each row separately; a row that is not losslessly JSON-serializable is omitted from the record with one warning naming the key and session, and the remaining rows still land on the same cut.
- `losslessProjectionValues()` owns the cell rule for every wire carrier: it keeps the cells `isJsonValue` accepts and reports each dropped key to its caller, which warns with the key, the session id, and its own carrier. `ApiSessionList.projectionsFor()`, `SessionControlController.projectionBaseline()`, and the `session/follow` projection block all pass their values through it.
- `SessionControlController` drops a change-feed frame whose value is not lossless JSON before broadcasting it: a frame the Client cannot receive correctly is never sent as a corrupted one.
- `asOfSeq` stays the registry's cut in every carrier, so an omission can only overstate staleness, and `isJsonValue` keeps its current strictness. No carrier normalizes or reinterprets business values; only the carriage changes.

## Alternatives considered

**Normalize the offending value at the carrier.** Rejected: transport does not reinterpret business fields, and stripping a value silently would hide the producer defect instead of locating it.

**Keep failing the record and the event, and fix producers instead.** Rejected: the producer set is open and unbounded, while the consequence of one bad field is session-level unavailability. Producer-side correctness stays a separate obligation.

**Fail loud by default (abort the record, surface a hard error).** Rejected: the projection cache is a derived fold shortcut whose stated contract is that a stale or unreadable cache costs a longer tail replay and never a wrong value; a hard failure on a derived row turns a display cell into an outage.

**Contain only the carriers that throw (the record and the forwarded event).** Rejected: the same input reaches the two stream carriers, where it is worse — `JSON.stringify` publishes a structurally valid, semantically wrong value with no warning anywhere, so the Client shows a permanently empty column instead of a missing one.

**Bump a `stateVersion` or migrate the offending row.** Rejected: a value that is not JSON cannot be migrated into JSON, and the row's problem is producer-side, not schema evolution.

## Consequences

A unit that produces a non-JSON state or wire value now costs its own row or cell: the session keeps listing, forking, and checkpointing, and the key refolds (or the cell stays absent, in the listing and in the stream frames alike) until the producer is corrected. Each omission is reported once per carrier with the key and session id — the warning is the locating signal, so operators must watch logs rather than expect the platform to refuse; a deliberate strict or counting surface remains the producer's or a future platform policy's to add. An omitted row pulls `restoreFloor` to its minimum, zero, so the next cold read re-reads the stored log from the start: the omitted key refolds from init while the remaining keys still seed from their cached rows, which makes a persistently offending unit a cold-read latency cost for long Sessions. The underlying producer defect and its fix remain owned by the unit's author.
