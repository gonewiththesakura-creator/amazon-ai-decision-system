import { createHash, randomUUID } from 'node:crypto';
import { transaction } from '../database/database.js';
import type { AppDatabase } from '../database/database.js';

export interface OwnedRosterIdentity { asin: string; sku: string | null }

export interface HumanConfirmedOwnedProduct extends OwnedRosterIdentity {
  internalName:string; brand:string; title:string|null; productType:string; marketNodeId:string;
  enrichment?:{status:'pending'|'unavailable';providerStatus:string|null;evidence:Record<string,unknown>};
}

/** Explicit human attestation confirms ownership, not provider availability or inferred titles. */
export function confirmHumanOwnedRoster(database:AppDatabase, marketplace:string,
  products:HumanConfirmedOwnedProduct[], evidence:{actor:string;statement:string}) {
  if (!evidence.actor.trim() || !evidence.statement.trim() || products.length===0
    || new Set(products.map(p=>p.asin)).size!==products.length
    || new Set(products.map(p=>p.sku)).size!==products.length
    || products.some(p=>!/^B[A-Z0-9]{9}$/.test(p.asin)||!p.sku?.trim()||!p.internalName.trim()||!p.brand.trim())) {
    throw new Error('Explicit ownership evidence and unique valid identities are required');
  }
  return transaction(database,()=>{
    const now=new Date().toISOString();
    for(const p of products){
      if(!database.prepare("SELECT 1 FROM market_nodes WHERE id=? AND marketplace=? AND source_type<>'mock'").get(p.marketNodeId,marketplace))throw new Error('Real internal market required');
      const prior=database.prepare('SELECT id,is_owned,source_type FROM products WHERE asin=? AND marketplace=?').get(p.asin,marketplace);
      if(prior && (prior.is_owned!==1||prior.source_type==='mock'))throw new Error('Existing non-owned/Mock identity requires separate reconciliation');
      const id=prior?.id??randomUUID();
      database.prepare(`INSERT INTO products(id,asin,sku,internal_name,brand,title,image_url,marketplace,product_type,is_owned,market_node_id,monitoring_enabled,source_type,created_at,status)
        VALUES (?,?,?,?,?,?,'',?,?,1,?,1,'import',?,'active')
        ON CONFLICT(asin,marketplace) DO UPDATE SET sku=excluded.sku,internal_name=excluded.internal_name,
          brand=excluded.brand,market_node_id=excluded.market_node_id,monitoring_enabled=1,status='active'`)
        .run(id,p.asin,p.sku,p.internalName,p.brand,p.title??'',marketplace,p.productType,p.marketNodeId,now);
      if(p.enrichment)database.prepare(`INSERT INTO product_provider_enrichment VALUES (?,?,?,?,NULL,NULL,?,?)
        ON CONFLICT(product_id) DO UPDATE SET status=excluded.status,provider_status=excluded.provider_status,
          remote_enabled=0,node_id_path=NULL,title=NULL,evidence_json=excluded.evidence_json,updated_at=excluded.updated_at`)
        .run(id,p.enrichment.status,p.enrichment.providerStatus,0,JSON.stringify({...p.enrichment.evidence,ownershipConfirmation:evidence}),now);
    }
    const current=activeOwnedRoster(database,marketplace);
    if(ownedRosterDigest(current)!==ownedRosterDigest(products))throw new Error('Confirmed input must cover the entire active real roster');
    const confirmationId=randomUUID();
    const digest=ownedRosterDigest(current);
    database.prepare('INSERT INTO owned_roster_manual_confirmations VALUES (?,?,?,?,?,?)')
      .run(confirmationId,marketplace,digest,products.length,JSON.stringify({evidence,products}),now);
    database.prepare(`INSERT INTO owned_roster_declarations
      (marketplace,declared_count,declared_digest,expected_count,expected_digest,preview_digest,status,import_batch_id,created_at,updated_at,manual_confirmation_id)
      VALUES (?,?,?,?,?,?,'confirmed',NULL,?,?,?) ON CONFLICT(marketplace) DO UPDATE SET
      declared_count=excluded.declared_count,declared_digest=excluded.declared_digest,
      expected_count=excluded.expected_count,expected_digest=excluded.expected_digest,preview_digest=excluded.preview_digest,
      status='confirmed',import_batch_id=NULL,updated_at=excluded.updated_at,manual_confirmation_id=excluded.manual_confirmation_id`)
      .run(marketplace,products.length,digest,products.length,digest,digest,now,now,confirmationId);
    return ownedRosterState(database,marketplace);
  });
}

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

/** An explicit human-scoped unavailable provider does not invalidate ownership. */
export function sellerSpriteRosterScope(database: AppDatabase, marketplace: string) {
  const rows = database.prepare(`SELECT p.id,p.asin,p.sku,p.market_node_id AS marketNodeId,
    e.status,e.provider_status AS providerStatus,e.remote_enabled AS remoteEnabled,e.evidence_json AS evidence
    FROM products p LEFT JOIN product_provider_enrichment e ON e.product_id=p.id
    WHERE p.marketplace=? AND p.is_owned=1 AND p.is_parent=0 AND p.status='active' AND p.source_type<>'mock'
    ORDER BY p.id`).all(marketplace);
  const hasExplicitEvidence = (value:unknown) => {
    try {
      const proof = JSON.parse(String(value)) as {actor?:unknown;statement?:unknown;reason?:unknown};
      return proof && typeof proof.actor==='string' && proof.actor.trim().length>0
        && [proof.statement,proof.reason].some(v=>typeof v==='string'&&v.trim().length>0);
    } catch {return false;}
  };
  const excluded = rows.filter(row => row.remoteEnabled === 0
    && ['pending','unavailable'].includes(String(row.status))
    && hasExplicitEvidence(row.evidence));
  const excludedIds = new Set(excluded.map(row => String(row.id)));
  return {rows, excluded, eligible:rows.filter(row=>!excludedIds.has(String(row.id))),
    digest:createHash('sha256').update(JSON.stringify(rows)).digest('hex')};
}

export function requireConfirmedOwnedRoster(database: AppDatabase, marketplace: string): void {
  if (!ownedRosterState(database, marketplace).ownedRosterMatches) {
    throw new Error('关键同步前置条件失败：自有 SKU roster 声明未确认或与当前活跃主档不一致。');
  }
}
