import type { AppDatabase } from '../database/database.js';

export interface ConfirmedDirectCompetitorRow {
  ownedProductId: string;
  competitorProductId: string;
}

export function confirmedDirectCompetitors(
  database: AppDatabase,
  marketplace: string,
): ConfirmedDirectCompetitorRow[] {
  return database.prepare(`
    SELECT DISTINCT owned.id AS ownedProductId, competitor.id AS competitorProductId
    FROM competitor_candidates candidate
    JOIN products owned ON owned.id = candidate.source_product_id
    JOIN products competitor ON competitor.marketplace = candidate.marketplace
      AND UPPER(TRIM(competitor.asin)) = UPPER(TRIM(candidate.asin))
    JOIN competitor_relations relation ON relation.owned_product_id = owned.id
      AND relation.competitor_product_id = competitor.id AND relation.relation_type = 'direct'
    WHERE candidate.marketplace = ? AND candidate.status = 'confirmed'
      AND candidate.reviewed_at IS NOT NULL AND candidate.source_type <> 'mock'
      AND owned.marketplace = candidate.marketplace AND owned.is_owned = 1
      AND owned.is_parent = 0 AND owned.status = 'active' AND owned.source_type <> 'mock'
      AND competitor.is_owned = 0 AND competitor.is_parent = 0
      AND competitor.status = 'active' AND competitor.source_type <> 'mock'
      AND TRIM(relation.reason) <> ''
    ORDER BY owned.id, competitor.id
  `).all(marketplace) as unknown as ConfirmedDirectCompetitorRow[];
}
