# ADR-001: Persistence layer — flat JSON vs. SQLite

**Status:** Accepted (stay on flat JSON; keep data access isolated for a future switch)
**Date:** 2026-06-16
**Deciders:** Project owner

## Context

All application state lives in flat JSON files loaded into memory at boot
([lib/store.js](../../lib/store.js)). Every mutation rewrites the entire file via
an atomic temp-file + rename. Images are stored on disk under `assets/`, with
only file references in JSON. This is the architecture's defining trade-off, so
it is worth making the decision explicit before public launch.

## Decision

**Stay on flat JSON for now**, but keep every data access behind the
`store.js` / `helpers.js` functions so that swapping to SQLite later is a
contained change rather than a rewrite.

## Options Considered

### Option A: Flat JSON (current)

| Dimension | Assessment |
|-----------|------------|
| Complexity | Lowest — zero dependencies, trivial to read and debug |
| Cost | None |
| Scalability | Hundreds of items comfortably; O(total) write cost per mutation |
| Team familiarity | Total — it is plain `JSON.parse`/`stringify` |

**Pros:** No dependencies, no schema migrations, human-readable data, atomic writes already in place.
**Cons:** Whole-file rewrite per mutation (a single "like" rewrites all posts); everything held in RAM; single-process only; no indexes or transactions.

### Option B: SQLite (`node:sqlite` on Node 22+, or `better-sqlite3`)

| Dimension | Assessment |
|-----------|------------|
| Complexity | Low — one dependency (or built-in), SQL to learn |
| Cost | None (embedded, file-based) |
| Scalability | Millions of rows, real indexes, WAL concurrency |
| Team familiarity | Moderate — requires SQL and a query layer |

**Pros:** O(1) row writes, indexes, transactions, concurrent reads under WAL, room to grow.
**Cons:** A dependency in the security perimeter; a one-time migration of `store.js`/`helpers.js`; data no longer trivially hand-editable.

## Trade-off Analysis

At the intended scale — friends-only, ~100 photos, a handful of communities — the
flat-file write cost is microseconds and irrelevant. The simplicity and
zero-dependency posture are real security and maintenance advantages for a small
public deployment. SQLite only pays off once posts/likes reach the thousands or a
second process is needed, at which point the whole-file rewrite and the
single-process RAM model become the bottleneck.

## Consequences

- **Easier now:** keep shipping features without a query layer or migrations.
- **Harder later:** if usage grows, a migration to SQLite is required — kept small by routing all access through `store.js`/`helpers.js`.
- **To revisit when:** posts or likes reach the low thousands, write latency becomes noticeable, or horizontal scaling / multiple processes are needed.

## Action Items

1. [x] Keep all reads/writes inside `store.js` / `helpers.js` (no direct file access from `server.js`).
2. [ ] Add a nightly backup of `data/` + `assets/` (done — see `scripts/backup.js`).
3. [ ] If the revisit trigger is hit: introduce a `db.js` exposing the same function surface backed by SQLite, swap the `require`, migrate existing JSON in a one-shot script.
