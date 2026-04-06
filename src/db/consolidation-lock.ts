/**
 * Advisory lock for consolidation. Prevents concurrent consolidation runs.
 * Single-row table enforced by CHECK(id = 1).
 */

import type Database from "better-sqlite3";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LockState {
  holder: string;
  started_at: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Stale lock threshold in milliseconds (2 minutes). */
const STALE_LOCK_MS = 2 * 60 * 1000;

// ---------------------------------------------------------------------------
// Lock operations
// ---------------------------------------------------------------------------

/** Try to acquire the lock. Returns true if acquired. */
export function acquireLock(db: Database.Database, holder: string): boolean {
  const now = new Date().toISOString();

  const result = db.transaction(() => {
    // Attempt to insert the lock row
    const inserted = db
      .prepare(
        `INSERT OR IGNORE INTO consolidation_lock (id, holder, started_at)
         VALUES (1, ?, ?)`,
      )
      .run(holder, now);

    if (inserted.changes > 0) {
      // We inserted — lock acquired
      return true;
    }

    // Row already exists — check if we hold it or if it's stale
    const existing = db
      .prepare(`SELECT holder, started_at FROM consolidation_lock WHERE id = 1`)
      .get() as { holder: string; started_at: string } | undefined;

    if (!existing) return false;

    if (existing.holder === holder) {
      // We already hold the lock
      return true;
    }

    // Check staleness
    const elapsed =
      new Date(now).getTime() - new Date(existing.started_at).getTime();
    if (elapsed > STALE_LOCK_MS) {
      // Stale — take over
      db.prepare(
        `UPDATE consolidation_lock SET holder = ?, started_at = ? WHERE id = 1`,
      ).run(holder, now);
      return true;
    }

    return false;
  })();

  return result;
}

/** Release the lock. Only releases if the holder matches. */
export function releaseLock(db: Database.Database, holder: string): void {
  db.prepare(
    `DELETE FROM consolidation_lock WHERE id = 1 AND holder = ?`,
  ).run(holder);
}

/** Check if a lock exists and return its state. */
export function getLockState(db: Database.Database): LockState | null {
  const row = db
    .prepare(`SELECT holder, started_at FROM consolidation_lock WHERE id = 1`)
    .get() as { holder: string; started_at: string } | undefined;
  return row ?? null;
}
