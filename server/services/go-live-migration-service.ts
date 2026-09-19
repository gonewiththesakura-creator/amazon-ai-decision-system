import { backup as sqliteBackup } from 'node:sqlite';
import type { AppDatabase } from '../database/database.js';
import { transaction } from '../database/database.js';

interface CountRow {
  count: number;
}

export interface GoLivePreview {
  delete: { marketSnapshots: number; productSnapshots: number };
  preserve: { products: number; rules: number; decisions: number };
}

export interface GoLiveVerification {
  mockObservations: number;
  realMarketSnapshots: number;
  realOwnedProductSnapshots: number;
  activeOwnedProducts: number;
  hasMinimumRealCoverage: boolean;
}

export class GoLiveMigrationService {
  constructor(private readonly database: AppDatabase) {}

  preview(): GoLivePreview {
    return {
      delete: {
        marketSnapshots: this.count(`SELECT COUNT(*) AS count FROM market_snapshots WHERE source_type = 'mock'`),
        productSnapshots: this.count(`SELECT COUNT(*) AS count FROM product_snapshots WHERE source_type = 'mock'`),
      },
      preserve: {
        products: this.count('SELECT COUNT(*) AS count FROM products'),
        rules: this.count('SELECT COUNT(*) AS count FROM rule_profiles'),
        decisions: this.count('SELECT COUNT(*) AS count FROM decisions'),
      },
    };
  }

  async backup(targetPath: string): Promise<void> {
    await sqliteBackup(this.database, targetPath);
  }

  clearDemoObservations(): GoLivePreview {
    const preview = this.preview();
    transaction(this.database, () => {
      this.database.prepare(`DELETE FROM import_batches WHERE task_id IN (
        SELECT id FROM data_tasks WHERE source_id = 'source-mock'
      )`).run();
      this.database.prepare(`DELETE FROM data_tasks WHERE source_id = 'source-mock'`).run();
      this.database.prepare(`DELETE FROM competitor_relations
        WHERE owned_product_id IN (SELECT id FROM products WHERE source_type = 'mock')
          AND competitor_product_id IN (SELECT id FROM products WHERE source_type = 'mock')`).run();
      this.database.prepare(`DELETE FROM product_snapshots WHERE source_type = 'mock'`).run();
      this.database.prepare(`DELETE FROM market_snapshots WHERE source_type = 'mock'`).run();
    });
    return preview;
  }

  verify(): GoLiveVerification {
    const mockObservations = this.count(`
      SELECT COUNT(*) AS count FROM market_snapshots WHERE source_type = 'mock'
      UNION ALL SELECT COUNT(*) AS count FROM product_snapshots WHERE source_type = 'mock'
    `, true);
    const realMarketSnapshots = this.count(`
      SELECT COUNT(*) AS count FROM market_snapshots WHERE source_type IN ('mcp', 'amazon', 'import')
    `);
    const activeOwnedProducts = this.count(`
      SELECT COUNT(*) AS count FROM products WHERE is_owned = 1 AND status = 'active'
    `);
    const realOwnedProductSnapshots = this.count(`
      SELECT COUNT(DISTINCT snapshot.product_id) AS count
      FROM product_snapshots snapshot
      JOIN products product ON product.id = snapshot.product_id
      WHERE product.is_owned = 1 AND product.status = 'active'
        AND snapshot.source_type IN ('mcp', 'amazon', 'import')
    `);
    return {
      mockObservations,
      realMarketSnapshots,
      realOwnedProductSnapshots,
      activeOwnedProducts,
      hasMinimumRealCoverage: mockObservations === 0
        && realMarketSnapshots > 0
        && realOwnedProductSnapshots === activeOwnedProducts,
    };
  }

  activateLiveMode(): void {
    const verification = this.verify();
    if (!verification.hasMinimumRealCoverage) {
      const problem = verification.mockObservations > 0 ? 'Mock 观察仍存在。' : '真实数据覆盖不足。';
      throw new Error(`无法切换 Live 模式：${problem}`);
    }
    this.database.prepare(`UPDATE app_settings SET mode = 'live' WHERE id = 1`).run();
  }

  private count(sql: string, sum = false): number {
    const rows = this.database.prepare(sql).all() as unknown as CountRow[];
    return sum ? rows.reduce((total, row) => total + Number(row.count), 0) : Number(rows[0]?.count ?? 0);
  }
}
