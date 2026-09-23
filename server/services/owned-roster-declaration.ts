import { createHash } from 'node:crypto';
import type { AppDatabase } from '../database/database.js';

export interface OwnedRosterIdentity { asin: string; sku: string | null }

export type OwnedRosterDeclarationStatus = 'missing' | 'pending_validation' | 'confirmed' | 'mismatch';

export interface OwnedRosterState {
  expectedOwnedProducts: number | null;
  ownedRosterDeclarationStatus: OwnedRosterDeclarationStatus;
  ownedRosterMatches: boolean;
}

export function ownedRosterDigest(identities: OwnedRosterIdentity[]): string {
  const normalized = identities.map((identity) => [
    identity.asin.trim().toUpperCase(), (identity.sku ?? '').trim().toUpperCase(),
  ]).sort(([asinA, skuA], [asinB, skuB]) =>
    asinA!.localeCompare(asinB!) || skuA!.localeCompare(skuB!));
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

export function activeOwnedRoster(database: AppDatabase, marketplace: string): OwnedRosterIdentity[] {
  return database.prepare(`
    SELECT asin, sku FROM products WHERE marketplace = ? AND is_owned = 1 AND is_parent = 0
      AND status = 'active' AND source_type <> 'mock' ORDER BY id
  `).all(marketplace) as unknown as OwnedRosterIdentity[];
}

export function ownedRosterState(database: AppDatabase, marketplace: string): OwnedRosterState {
  const declaration = database.prepare(`SELECT status, declared_count AS declaredCount,
    expected_count AS expectedCount,
    expected_digest AS expectedDigest FROM owned_roster_declarations WHERE marketplace = ?`
  ).get(marketplace) as { status: 'pending_validation' | 'confirmed';
    declaredCount: number; expectedCount: number | null; expectedDigest: string | null } | undefined;
  if (!declaration) return {
    expectedOwnedProducts: null, ownedRosterDeclarationStatus: 'missing', ownedRosterMatches: false,
  };
  if (declaration.status !== 'confirmed') return {
    expectedOwnedProducts: declaration.declaredCount,
    ownedRosterDeclarationStatus: 'pending_validation', ownedRosterMatches: false,
  };
  const current = activeOwnedRoster(database, marketplace);
  const matches = current.length === declaration.expectedCount
    && ownedRosterDigest(current) === declaration.expectedDigest;
  return {
    expectedOwnedProducts: declaration.expectedCount,
    ownedRosterDeclarationStatus: matches ? 'confirmed' : 'mismatch',
    ownedRosterMatches: matches,
  };
}

export function requireConfirmedOwnedRoster(database: AppDatabase, marketplace: string): void {
  if (!ownedRosterState(database, marketplace).ownedRosterMatches) {
    throw new Error('关键同步前置条件失败：自有 SKU roster 声明未确认或与当前活跃主档不一致。');
  }
}
