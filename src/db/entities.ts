/**
 * Data access for entities and the knowledge graph.
 * All functions are synchronous (better-sqlite3).
 */

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { Entity, EntityEdge } from "../types/data.js";

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface NewEntity {
  type: string;
  name: string;
  metadata?: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

/** Find an entity by name, optionally filtered by type. Uses canonical_name for matching. */
export function findEntity(
  db: Database.Database,
  name: string,
  type?: string,
): Entity | null {
  const canonical = name.toLowerCase().trim();
  let sql = `SELECT * FROM entities WHERE canonical_name = ?`;
  const params: unknown[] = [canonical];

  if (type !== undefined) {
    sql += ` AND type = ?`;
    params.push(type);
  }

  const row = db.prepare(sql).get(...params) as
    | (Omit<Entity, "metadata"> & { metadata: string | null })
    | undefined;
  if (!row) return null;
  return {
    ...row,
    metadata: row.metadata
      ? (JSON.parse(row.metadata) as Record<string, unknown>)
      : null,
  };
}

/** Find an entity by canonical name. */
export function findEntityByCanonical(
  db: Database.Database,
  canonicalName: string,
): Entity | null {
  const row = db
    .prepare(`SELECT * FROM entities WHERE canonical_name = ?`)
    .get(canonicalName) as
    | (Omit<Entity, "metadata"> & { metadata: string | null })
    | undefined;
  if (!row) return null;
  return {
    ...row,
    metadata: row.metadata
      ? (JSON.parse(row.metadata) as Record<string, unknown>)
      : null,
  };
}

/** Create an entity. Sets canonical_name = lower(trim(name)). */
export function createEntity(
  db: Database.Database,
  entity: NewEntity,
): Entity {
  const id = randomUUID();
  const now = new Date().toISOString();
  const canonical = entity.name.toLowerCase().trim();
  const metadata = entity.metadata ? JSON.stringify(entity.metadata) : null;

  db.prepare(
    `INSERT INTO entities
       (id, type, name, canonical_name, metadata, created_at, access_count, last_accessed_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, NULL)`,
  ).run(id, entity.type, entity.name, canonical, metadata, now);

  return {
    id,
    type: entity.type,
    name: entity.name,
    canonical_name: canonical,
    metadata: entity.metadata ?? null,
    created_at: now,
    access_count: 0,
    last_accessed_at: null,
  };
}

/** Find or create an entity. Returns existing if found by canonical name + type. */
export function findOrCreateEntity(
  db: Database.Database,
  entity: NewEntity,
): { entity: Entity; created: boolean } {
  const existing = findEntity(db, entity.name, entity.type);
  if (existing) return { entity: existing, created: false };

  const created = createEntity(db, entity);
  return { entity: created, created: true };
}

// ---------------------------------------------------------------------------
// Fact–Entity links
// ---------------------------------------------------------------------------

/** Link a fact to an entity. INSERT OR IGNORE (composite PK handles dedup). */
export function linkFactEntity(
  db: Database.Database,
  factId: string,
  entityId: string,
  relationship: string,
): void {
  db.prepare(
    `INSERT OR IGNORE INTO fact_entities (fact_id, entity_id, relationship)
     VALUES (?, ?, ?)`,
  ).run(factId, entityId, relationship);
}

// ---------------------------------------------------------------------------
// Entity edges
// ---------------------------------------------------------------------------

/** Create or strengthen an entity-to-entity edge. */
/**
 * Logarithmic potentiation rate for entity edge strengthening.
 * Models synaptic LTP: early co-occurrences cause large jumps,
 * later ones diminish as the edge approaches saturation.
 *
 * Formula: new_strength = 1 - 1 / (1 + count * EDGE_POTENTIATION_K)
 * With K=0.5: 1 co-occurrence → 0.33, 2 → 0.50, 5 → 0.71, 10 → 0.83, 20 → 0.91
 *
 * Phase 3: the inference pipeline can adjust this based on
 * observed correction patterns (parametric feedback).
 */
export const EDGE_POTENTIATION_K = 0.5;

/** Create or strengthen an entity-to-entity edge using logarithmic potentiation. */
export function upsertEntityEdge(
  db: Database.Database,
  fromEntity: string,
  toEntity: string,
  relationship: string,
): void {
  const now = new Date().toISOString();

  db.transaction(() => {
    // Try to insert new edge with initial strength
    const initialStrength = 1 - 1 / (1 + EDGE_POTENTIATION_K); // ~0.33 for K=0.5
    const inserted = db.prepare(
      `INSERT OR IGNORE INTO entity_edges
         (from_entity, to_entity, relationship, strength, metadata, created_at, last_accessed_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?)`,
    ).run(fromEntity, toEntity, relationship, initialStrength, now, now);

    if (inserted.changes > 0) return; // new edge created

    // Edge exists — read current strength, compute co-occurrence count from it,
    // then apply logarithmic curve for the next increment.
    const row = db.prepare(
      `SELECT strength FROM entity_edges
       WHERE from_entity = ? AND to_entity = ? AND relationship = ?`,
    ).get(fromEntity, toEntity, relationship) as { strength: number } | undefined;

    if (!row) return;

    // Invert the formula to estimate co-occurrence count from current strength:
    // strength = 1 - 1/(1 + count*K)  →  count = (1/(1-strength) - 1) / K
    const currentStrength = row.strength;
    const estimatedCount = currentStrength >= 0.999
      ? 100 // avoid division by zero at saturation
      : (1 / (1 - currentStrength) - 1) / EDGE_POTENTIATION_K;

    const newCount = estimatedCount + 1;
    const newStrength = 1 - 1 / (1 + newCount * EDGE_POTENTIATION_K);

    db.prepare(
      `UPDATE entity_edges SET strength = ?, last_accessed_at = ?
       WHERE from_entity = ? AND to_entity = ? AND relationship = ?`,
    ).run(newStrength, now, fromEntity, toEntity, relationship);
  })();
}

/** Get all edges from or to an entity. */
export function getEntityEdges(
  db: Database.Database,
  entityId: string,
): EntityEdge[] {
  const rows = db
    .prepare(
      `SELECT * FROM entity_edges WHERE from_entity = ? OR to_entity = ?`,
    )
    .all(entityId, entityId) as Array<
    Omit<EntityEdge, "metadata"> & { metadata: string | null }
  >;

  return rows.map((row) => ({
    ...row,
    metadata: row.metadata
      ? (JSON.parse(row.metadata) as Record<string, unknown>)
      : null,
  }));
}

// ---------------------------------------------------------------------------
// Access tracking
// ---------------------------------------------------------------------------

/** Update access tracking on an entity. */
export function updateEntityAccess(
  db: Database.Database,
  entityId: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE entities SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?`,
  ).run(now, entityId);
}
