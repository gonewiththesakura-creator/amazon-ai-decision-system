import type {
  CoreBusinessFreshness,
  DataMode,
  SystemSyncStatus,
  TaskStatus,
} from '../../shared/types.js';
import type { AppDatabase } from '../database/database.js';
import { isLiveObservationReadable } from './live-observation-readability.js';

interface SnapshotClock {
  entityId: string;
  observationDate: string;
  collectedAt: string;
}

interface TaskRow {
  task_type: string;
  target: string;
  source: string;
  status: TaskStatus;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  error_log: string | null;
}

const STALE_COLLECTION_SKEW_MS = 24 * 60 * 60 * 1_000;

export interface DashboardFreshnessInput {
  marketplace: string;
  mode: DataMode;
  marketId: string | null;
  ownedProductIds: string[];
  competitorProductIds: string[];
}

export interface DashboardFreshnessResult {
  coreBusinessFreshness: CoreBusinessFreshness;
  systemSyncStatus: SystemSyncStatus;
}

/** Keeps snapshot coverage and operational task health as separate concepts. */
export class DashboardFreshnessService {
  constructor(private readonly database: AppDatabase) {}

  getStatus(input: DashboardFreshnessInput): DashboardFreshnessResult {
    const marketClock = input.marketId
      ? this.latestMarketSnapshot(input.marketId, input.marketplace, input.mode)
      : null;
    const ownedClocks = input.ownedProductIds.map((id) => (
      this.latestProductSnapshot(id, input.marketplace, input.mode) ?? missingClock(id)
    ));
    const competitorClocks = input.competitorProductIds.map((id) => (
      this.latestProductSnapshot(id, input.marketplace, input.mode) ?? missingClock(id)
    ));
    const requiredClocks = [
      ...(input.marketId ? [marketClock ?? missingClock(input.marketId)] : []),
      ...ownedClocks,
      ...competitorClocks,
    ];
    const missingEntityIds = [
      ...(!input.marketId ? ['market:unconfigured'] : marketClock ? [] : [input.marketId]),
      ...requiredClocks.filter(isMissingClock).map((clock) => clock.entityId),
    ];
    const availableClocks = requiredClocks.filter(isSnapshotClock);
    const complete = missingEntityIds.length === 0;
    const oldestRequiredSnapshotAt = complete
      ? oldestTimestamp(availableClocks.map((clock) => clock.collectedAt))
      : null;
    const newestRequiredSnapshotAt = complete
      ? newestTimestamp(availableClocks.map((clock) => clock.collectedAt))
      : null;
    const snapshotByEntity = new Map(
      availableClocks.map((clock) => [clock.entityId, clock.collectedAt]),
    );
    const relevantTaskHasUnresolvedIssue = this.hasUnresolvedRelevantTask(
      input,
      snapshotByEntity,
    );
    const observationDates = new Set(availableClocks.map((clock) => clock.observationDate));
    const collectionSkew = timestampSkew(availableClocks.map((clock) => clock.collectedAt));

    let status: CoreBusinessFreshness['status'];
    let label: CoreBusinessFreshness['label'];
    let message: string;
    if (!input.marketId || !marketClock || input.ownedProductIds.length === 0 || ownedClocks.every(isMissingClock)) {
      status = 'insufficient';
      label = '数据不足';
      message = !input.marketId
        ? '尚未设置主市场，无法形成首页业务数据基线。'
        : '主市场或自有产品缺少可用快照。';
    } else if (!complete) {
      status = 'partial';
      label = '部分未更新';
      message = `有 ${missingEntityIds.length} 个首页依赖实体缺少合法快照，已保留其余可用数据。`;
    } else if (relevantTaskHasUnresolvedIssue) {
      status = 'partial';
      label = '部分未更新';
      message = '相关刷新未完整成功，当前继续展示上一次合法快照。';
    } else if (collectionSkew >= STALE_COLLECTION_SKEW_MS) {
      status = 'stale';
      label = '数据陈旧';
      message = '首页核心快照的采集时间相差超过 24 小时，请刷新较旧的数据。';
    } else if (observationDates.size > 1) {
      status = 'partial';
      label = '部分未更新';
      message = '首页核心数据来自不同快照日期，比较结果继续使用各自最新合法快照。';
    } else {
      status = 'normal';
      label = '正常';
      message = '主市场、自有产品与当前竞品依赖的快照日期一致。';
    }

    return {
      coreBusinessFreshness: {
        status,
        label,
        message,
        marketUpdatedAt: marketClock?.collectedAt ?? null,
        ownedProductsUpdatedAt: groupOldestTimestamp(ownedClocks),
        competitorsUpdatedAt: input.competitorProductIds.length
          ? groupOldestTimestamp(competitorClocks)
          : null,
        oldestRequiredSnapshotAt,
        newestRequiredSnapshotAt,
        missingEntityIds: [...new Set(missingEntityIds)],
        isDemo: input.mode === 'demo',
      },
      systemSyncStatus: this.systemSyncStatus(input.marketplace),
    };
  }

  private latestMarketSnapshot(marketId: string, marketplace: string, mode: DataMode): SnapshotClock | null {
    const rows = this.database.prepare(`
      SELECT snapshot.id, snapshot.market_node_id AS entity_id, snapshot.date AS observation_date,
        snapshot.collected_at, snapshot.source_type, snapshot.sync_run_id
      FROM market_snapshots snapshot
      JOIN market_nodes market ON market.id = snapshot.market_node_id
      WHERE snapshot.market_node_id = ? AND market.marketplace = ?
        AND snapshot.monthly_sales IS NOT NULL AND snapshot.monthly_sales >= 0
        AND date(snapshot.date) IS NOT NULL
        AND julianday(snapshot.collected_at) IS NOT NULL
      ORDER BY julianday(snapshot.collected_at) DESC, date(snapshot.date) DESC, snapshot.rowid DESC
    `).all(marketId, marketplace) as Array<{
      id: string;
      entity_id: string;
      observation_date: string;
      collected_at: string;
      source_type: string;
      sync_run_id: string | null;
    }>;
    const row = rows.find((candidate) => mode !== 'live' || isLiveObservationReadable(
      this.database, 'market', candidate.id, candidate.source_type, candidate.sync_run_id,
    ));
    return row ? {
      entityId: row.entity_id,
      observationDate: row.observation_date,
      collectedAt: row.collected_at,
    } : null;
  }

  private latestProductSnapshot(productId: string, marketplace: string, mode: DataMode): SnapshotClock | null {
    const rows = this.database.prepare(`
      SELECT snapshot.id, snapshot.product_id AS entity_id, snapshot.date AS observation_date,
        snapshot.collected_at, snapshot.source_type, snapshot.sync_run_id
      FROM product_snapshots snapshot
      JOIN products product ON product.id = snapshot.product_id
      WHERE snapshot.product_id = ? AND product.marketplace = ?
        AND snapshot.estimated_sales IS NOT NULL AND snapshot.estimated_sales >= 0
        AND date(snapshot.date) IS NOT NULL
        AND julianday(snapshot.collected_at) IS NOT NULL
      ORDER BY julianday(snapshot.collected_at) DESC, date(snapshot.date) DESC, snapshot.rowid DESC
    `).all(productId, marketplace) as Array<{
      id: string;
      entity_id: string;
      observation_date: string;
      collected_at: string;
      source_type: string;
      sync_run_id: string | null;
    }>;
    const row = rows.find((candidate) => mode !== 'live' || isLiveObservationReadable(
      this.database, 'product', candidate.id, candidate.source_type, candidate.sync_run_id,
    ));
    return row ? {
      entityId: row.entity_id,
      observationDate: row.observation_date,
      collectedAt: row.collected_at,
    } : null;
  }

  private hasUnresolvedRelevantTask(
    input: DashboardFreshnessInput,
    snapshotByEntity: Map<string, string>,
  ): boolean {
    const tasks = this.database.prepare(`
      SELECT task_type, target, source, status, started_at, completed_at, created_at, error_log
      FROM data_tasks
      WHERE marketplace = ? AND status IN ('failed', 'partial', 'pending', 'running')
      ORDER BY julianday(COALESCE(completed_at, started_at, created_at)) DESC, rowid DESC
    `).all(input.marketplace) as unknown as TaskRow[];
    return tasks.some((task) => {
      const taskAt = Date.parse(taskTimestamp(task));
      if (!Number.isFinite(taskAt)) return false;
      return affectedEntityIds(task, input).some((entityId) => {
        const snapshotAt = snapshotByEntity.get(entityId);
        return !snapshotAt || Date.parse(snapshotAt) <= taskAt;
      });
    });
  }

  private systemSyncStatus(marketplace: string): SystemSyncStatus {
    const latest = this.database.prepare(`
      SELECT task_type, target, source, status, started_at, completed_at, created_at, error_log
      FROM data_tasks
      WHERE marketplace = ?
      ORDER BY julianday(COALESCE(completed_at, started_at, created_at)) DESC, rowid DESC
      LIMIT 1
    `).get(marketplace) as TaskRow | undefined;
    if (!latest) {
      return { status: 'idle', latestTaskAt: null, source: null, message: null };
    }
    const status = latest.status === 'pending' || latest.status === 'running'
      ? 'running'
      : latest.status;
    return {
      status,
      latestTaskAt: taskTimestamp(latest),
      source: latest.source || null,
      message: syncMessage(status),
    };
  }
}

function affectedEntityIds(
  task: TaskRow,
  input: DashboardFreshnessInput,
): string[] {
  const target = task.target.trim();
  const taskType = task.task_type.trim().toLowerCase();
  const allDependencies = [
    ...(input.marketId ? [input.marketId] : []),
    ...input.ownedProductIds,
    ...input.competitorProductIds,
  ];
  if (taskType === 'critical_sync') {
    return input.marketId === target ? [target, ...input.ownedProductIds] : [];
  }
  if (taskType === 'dashboard_core_refresh') return allDependencies;
  if (taskType === 'manual_refresh') {
    if (target === 'all') return allDependencies;
    if (target === 'owned-products') return input.ownedProductIds;
    if (target === 'watched-competitors') return input.competitorProductIds;
    return allDependencies.includes(target) ? [target] : [];
  }
  if (taskType === 'market_refresh') {
    if ((target === 'all' || target === '') && input.marketId) return [input.marketId];
    return input.marketId === target ? [target] : [];
  }
  if (taskType === 'owned_sku_refresh') {
    if (target === 'all' || target === '' || target === 'owned-products') {
      return input.ownedProductIds;
    }
    return input.ownedProductIds.includes(target) ? [target] : [];
  }
  if (taskType === 'product_refresh') {
    if (target === 'all' || target === '' || target === 'owned-products') {
      return input.ownedProductIds;
    }
    return [...input.ownedProductIds, ...input.competitorProductIds].includes(target)
      ? [target]
      : [];
  }
  if (taskType === 'competitor_refresh') {
    if (target === 'all' || target === '' || target === 'watched-competitors') {
      return input.competitorProductIds;
    }
    return input.competitorProductIds.includes(target) ? [target] : [];
  }
  if (taskType === 'watchlist_refresh') {
    return allDependencies.includes(target) ? [target] : [];
  }
  return [];
}

function taskTimestamp(task: TaskRow): string {
  return task.completed_at ?? task.started_at ?? task.created_at;
}

function syncMessage(status: SystemSyncStatus['status']): string {
  const messages: Record<SystemSyncStatus['status'], string> = {
    idle: '尚无同步任务。',
    running: '同步任务正在执行。',
    partial: '最近一次同步仅部分完成。',
    failed: '最近一次同步失败。',
    success: '最近一次同步已完成。',
  };
  return messages[status];
}

function missingClock(entityId: string): { entityId: string; missing: true } {
  return { entityId, missing: true };
}

function isMissingClock(
  clock: SnapshotClock | { entityId: string; missing: true },
): clock is { entityId: string; missing: true } {
  return 'missing' in clock;
}

function isSnapshotClock(
  clock: SnapshotClock | { entityId: string; missing: true },
): clock is SnapshotClock {
  return !isMissingClock(clock);
}

function groupOldestTimestamp(
  clocks: Array<SnapshotClock | { entityId: string; missing: true }>,
): string | null {
  return clocks.length && clocks.every(isSnapshotClock)
    ? oldestTimestamp(clocks.map((clock) => clock.collectedAt))
    : null;
}

function oldestTimestamp(values: string[]): string | null {
  if (!values.length) return null;
  return [...values].sort((left, right) => Date.parse(left) - Date.parse(right))[0] ?? null;
}

function newestTimestamp(values: string[]): string | null {
  if (!values.length) return null;
  return [...values].sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;
}

function timestampSkew(values: string[]): number {
  const timestamps = values.map(Date.parse).filter(Number.isFinite);
  return timestamps.length < 2 ? 0 : Math.max(...timestamps) - Math.min(...timestamps);
}
