import type {
  DecisionRecord,
  MetricProvenance,
  NormalizedField,
  PerformanceLevel,
  ProductSnapshot,
  ReviewInsight,
  ResearchJobDetail,
  ResearchStepType,
  RuleProfile,
  WorkflowEvidence,
} from '../../shared/types.js';
import { ManualInputAdapter } from '../adapters/manual-input-adapter.js';
import { transaction, type AppDatabase } from '../database/database.js';
import { deriveSnapshotGrowth, type SnapshotGrowthPair } from '../domain/snapshot-growth.js';
import { assessReverseReview } from '../domain/reverse-review-engine.js';
import { executeProductRules, type ProductRuleResult } from '../domain/workflow-rule-engine.js';
import { IntelligenceRepository } from '../repository/intelligence-repository.js';
import { WorkflowRepository } from '../repository/workflow-repository.js';
import { MetricAuthorityResolver, type MetricFact } from './metric-authority-resolver.js';
import { isLiveObservationReadable } from './live-observation-readability.js';

export interface RetryResearchJobRequest {
  resolvedData: Record<string, unknown>;
  resolvedBy: string;
}

export interface DecideResearchJobRequest {
  decision: 'approved' | 'watch' | 'needs_data' | 'rejected';
  reason: string;
  decidedBy: string;
}

const EXISTING_MARKET_CURRENT_EVIDENCE_FIELDS = [
  'monthly_sales', 'monthly_revenue', 'product_count', 'seller_count', 'brand_count',
  'avg_price', 'median_price', 'avg_rating', 'median_reviews', 'top10_sales_share',
  'top20_sales_share', 'new_product_share', 'market_growth_30d', 'market_growth_elapsed_days',
] as const;

const EXISTING_MARKET_CHANGE_EVIDENCE_FIELDS = [
  'monthly_revenue_change_30d_pct', 'product_count_change_30d_pct',
  'seller_count_change_30d_pct', 'brand_count_change_30d_pct',
  'avg_price_change_30d_pct', 'median_price_change_30d_pct',
  'median_reviews_change_30d_pct', 'avg_rating_change_30d',
  'top10_sales_share_change_30d_pp', 'top20_sales_share_change_30d_pp',
  'new_product_share_change_30d_pp', 'price_bands_change_30d',
  'concentration_change_30d',
] as const;

const EXISTING_MARKET_EVIDENCE_FIELDS = [
  ...EXISTING_MARKET_CURRENT_EVIDENCE_FIELDS,
  ...EXISTING_MARKET_CHANGE_EVIDENCE_FIELDS,
] as const;

const OWNED_PRODUCT_DIAGNOSTIC_GAPS = [
  ['sessions', '缺少流量 Sessions，当前只能识别相对表现，不能判断流量侧原因。'],
  ['conversion_rate', '缺少转化率，当前不能判断详情页、价格或评价是否影响转化。'],
  ['ad_spend', '缺少广告花费，当前不能判断广告投入变化对销量的影响。'],
  ['return_rate', '缺少退货率，当前不能判断产品体验或质量问题。'],
] as const;

export class WorkflowOrchestrator {
  readonly repository: WorkflowRepository;
  private readonly intelligence: IntelligenceRepository;
  private readonly authority: MetricAuthorityResolver;
  private readonly manualInput = new ManualInputAdapter();

  constructor(private readonly database: AppDatabase) {
    this.repository = new WorkflowRepository(database);
    this.intelligence = new IntelligenceRepository(database);
    this.authority = new MetricAuthorityResolver(database);
  }

  run(jobId: string, inputPatch: Record<string, unknown> = {}): ResearchJobDetail {
    let job = this.requireJob(jobId);
    if (Object.keys(inputPatch).length > 0) {
      if (job.status !== 'draft' && job.status !== 'planned') {
        throw new Error('只有 draft 或 planned 状态可以补充运行输入；needs_data 请使用 retry。');
      }
      job = this.repository.updateResearchInput(job.id, inputPatch);
    }
    if (['waiting_approval', 'approved', 'watch', 'rejected', 'monitoring'].includes(job.status)) {
      return job;
    }
    if (job.status === 'needs_data') return job;
    if (job.status === 'failed') throw new Error('失败任务请使用 retry。');

    try {
      return this.execute(job);
    } catch (error) {
      this.recordFailure(job.id, error);
      throw error;
    }
  }

  retry(jobId: string, request: RetryResearchJobRequest): ResearchJobDetail {
    let job = this.requireJob(jobId);
    if (job.status !== 'needs_data' && job.status !== 'failed') {
      throw new Error('只有 needs_data 或 failed 状态可以重试。');
    }
    if (!request.resolvedBy.trim()) throw new Error('resolvedBy 不能为空。');
    const resolved = this.prepareResolvedData(job, request.resolvedData);
    if (job.status === 'needs_data') {
      transaction(this.database, () => {
        if (Object.keys(resolved.input).length > 0) {
          job = this.repository.updateResearchInput(job.id, deepMerge(job.input, resolved.input));
        }
        if (Object.keys(resolved.taskBook).length > 0) {
          job = this.repository.updateResearchTaskBook(job.id, deepMerge(job.taskBook, resolved.taskBook));
        }
        this.repository.resolveMissingData(job.id, resolved.flat, request.resolvedBy.trim());
        this.repository.resetAnalysisStepsForRetry(job.id);
      });
    } else {
      if (Object.keys(request.resolvedData).length > 0) {
        throw new Error('failed 重试不接受未登记的补数；请先修复失败原因。');
      }
      this.repository.resetRetryableSteps(job.id);
    }
    job = this.repository.transition(job.id, 'planned');
    try {
      return this.execute(job);
    } catch (error) {
      this.recordFailure(job.id, error);
      throw error;
    }
  }

  decide(jobId: string, request: DecideResearchJobRequest): ResearchJobDetail {
    const job = this.requireJob(jobId);
    if (job.status !== 'waiting_approval') {
      throw new Error(`当前状态 ${job.status} 尚未进入人工 Approval Gate。`);
    }
    const approval = job.approval;
    if (!approval || approval.status !== 'pending') throw new Error('没有待处理的人工 Approval。');

    if (request.decision === 'approved') {
      const blocking = this.repository.getMissingData(job.id)
        .filter((item) => item.status === 'open' && item.requiredForDecision);
      if (blocking.length > 0) throw new Error('仍有阻断决策的缺失数据，不能批准。');
      if (job.latestRuleExecution?.hardGateStatus !== 'pass') {
        throw new Error('Hard Gate 未通过，不能批准。');
      }
      if (!job.reverseReview || !['proceed', 'proceed_with_caution'].includes(job.reverseReview.verdict)) {
        throw new Error('Reverse Review 未完成或结论不允许批准。');
      }
      const evidenceIds = job.latestInsight?.evidenceIds ?? [];
      if (evidenceIds.length === 0) throw new Error('当前 Insight 没有 Evidence，不能批准。');
      this.repository.assertEvidenceIds(job.id, evidenceIds);
    }

    const approvalStatus = request.decision === 'rejected' ? 'rejected' : request.decision;
    const decision: DecisionRecord['decision'] = request.decision === 'rejected' ? 'reject' : request.decision;
    return transaction(this.database, () => {
      const decidedApproval = this.repository.decideApproval(
        job.id, approvalStatus, request.reason, request.decidedBy,
      );
      this.repository.saveDecision(job, decision, request.reason, request.decidedBy, decidedApproval);
      if (request.decision === 'needs_data') {
        this.repository.upsertMissingData(job.id, [{
          fieldName: 'approval_follow_up',
          reason: request.reason,
          manualValidationRequired: true,
        }]);
      }
      this.repository.transition(job.id, request.decision);
      return this.requireJob(job.id);
    });
  }

  private execute(job: ResearchJobDetail): ResearchJobDetail {
    let current = this.requireJob(job.id);
    if (current.status === 'draft') current = this.plan(current);
    if (current.status === 'planned') current = this.repository.transition(current.id, 'collecting');

    const collected = this.collect(current);
    current = this.repository.updateDataVersion(current.id, {
      values: collected.values,
      taskBook: current.taskBook,
      calculations: collected.calculations,
      sourceRecordIds: Object.fromEntries(Object.entries(collected.sources).map(([field, source]) => (
        [field, source.sourceRecordId]
      ))),
    });
    if (current.status === 'collecting') current = this.repository.transition(current.id, 'normalizing');
    if (current.status === 'normalizing') current = this.normalize(current, collected);
    if (current.status === 'validating') {
      const validation = this.validate(current, collected);
      if (!validation) return this.requireJob(current.id);
      this.repository.completeJobDataTasks(current.id);
      current = this.repository.transition(current.id, 'calculating');
    }
    return this.calculateAndAnalyze(current, collected);
  }

  private plan(job: ResearchJobDetail): ResearchJobDetail {
    this.repository.startStep(job.id, 'plan', {
      jobType: job.type, entityType: job.entityType, entityId: job.entityId,
      ruleProfile: `${job.ruleProfileId}@${job.ruleProfileVersion}`,
    });
    const target = job.entityId ?? job.id;
    const steps = collectionSteps(job);
    const taskIds = steps.map((stepType) => {
      this.repository.ensureStep(job.id, stepType);
      return this.repository.createDataTask(
        job, stepType, target, `${job.name} · ${stepLabel(stepType)}`,
      ).id;
    });
    [
      'normalize', 'validate', 'calculate', 'hard_gate', 'score', 'ai_analysis',
      'review_gap', 'reverse_review', 'approval', 'snapshot', 'report',
    ].forEach((step) => this.repository.ensureStep(job.id, step as ResearchStepType));
    this.repository.finishStep(job.id, 'plan', 'completed', {
      taskIds, collectionSteps: steps,
      lockedRuleProfile: `${job.ruleProfileId}@${job.ruleProfileVersion}`,
      promptVersion: job.promptVersion,
    });
    return this.repository.transition(job.id, 'planned');
  }

  private collect(job: ResearchJobDetail): CollectedWorkflowData {
    const steps = collectionSteps(job);
    this.repository.startJobDataTasks(job.id);
    steps.forEach((step) => this.repository.startStep(job.id, step, {
      entityType: job.entityType, entityId: job.entityId, marketplace: job.marketplace,
    }));
    const collected = job.type === 'existing_market'
      ? this.collectMarket(job)
      : job.type === 'owned_product'
        ? this.collectOwnedProduct(job)
        : this.collectProductResearch(job);
    const availableFields = Object.entries(collected.values)
      .filter(([, value]) => !isMissingValue(value))
      .map(([field]) => field);
    const missingFields = Object.entries(collected.values)
      .filter(([, value]) => isMissingValue(value))
      .map(([field]) => field);
    steps.forEach((step) => this.repository.finishStep(job.id, step, 'completed', {
      fieldsCollected: Object.keys(collected.values).length,
      availableFields,
      missingFields,
      sourceRecordIds: unique(Object.values(collected.sources).map((item) => item.sourceRecordId).filter(Boolean)),
      reviewCount: collected.reviews.length,
    }));
    return collected;
  }

  private normalize(job: ResearchJobDetail, collected: CollectedWorkflowData): ResearchJobDetail {
    this.repository.startStep(job.id, 'normalize', {
      fields: Object.keys(collected.values), dataVersion: job.dataVersion,
    });
    let fields: Record<string, unknown>;
    if (isProductResearch(job)) {
      fields = {
        input: this.manualInput.normalize(job.input, {
          source: job.isDemo ? 'Demo task input' : 'Research task input',
          confidence: job.isDemo ? 0.9 : 0.75,
        }),
        taskBook: this.manualInput.normalize(job.taskBook, {
          source: job.isDemo ? 'Demo task book' : 'Research task book',
          confidence: job.isDemo ? 0.9 : 0.8,
        }),
      };
    } else {
      fields = Object.fromEntries(Object.entries(collected.values).map(([field, value]) => {
        const source = collected.sources[field] ?? unknownSource(job);
        const normalized: NormalizedField = {
          value,
          source: source.source,
          sourceType: source.sourceType,
          collectedAt: source.collectedAt,
          period: source.period,
          originalUnit: source.originalUnit,
          normalizedUnit: source.normalizedUnit,
          isEstimated: source.isEstimated,
          confidence: source.confidence,
        };
        return [field, normalized];
      }));
    }
    const recordId = this.repository.saveNormalizedRecord(job, fields);
    this.repository.finishStep(job.id, 'normalize', 'completed', {
      normalizedRecordId: recordId, fieldCount: Object.keys(collected.values).length,
      missingValuesPreservedAsNull: true,
    });
    return this.repository.transition(job.id, 'validating');
  }

  private validate(job: ResearchJobDetail, collected: CollectedWorkflowData): ProductRuleResult | true | null {
    this.repository.startStep(job.id, 'validate', {
      dataVersion: job.dataVersion, ruleProfile: `${job.ruleProfileId}@${job.ruleProfileVersion}`,
    });
    const profile = this.repository.getLockedRuleProfile(job);
    if (isProductResearch(job)) {
      const result = executeProductRules(profile, job.input, job.taskBook);
      const formalTaskBookMissing = result.hardGateStatus === 'reject'
        ? []
        : findTaskBookMissing(job.taskBook);
      const missing = mergeMissing(result.missing, formalTaskBookMissing);
      if (result.hardGateStatus === 'needs_data' || missing.length > 0) {
        const output = { ...result, missing };
        this.repository.saveRuleExecution(job, job.input, output, 'needs_data', null);
        this.repository.upsertMissingData(job.id, missing);
        this.repository.finishStep(job.id, 'validate', 'needs_data', output);
        this.repository.finishStep(job.id, 'hard_gate', 'needs_data', output);
        this.repository.failJobDataTasks(job.id, '研究输入或任务书缺少决策所需字段。');
        this.repository.transition(job.id, 'needs_data');
        return null;
      }
      this.repository.finishStep(job.id, 'validate', 'completed', {
        valid: true, hardGatePrecheck: result.hardGateStatus,
      });
      return result;
    }

    const required = requiredFields(profile);
    if (job.type === 'existing_market') required.push('market_growth_baseline');
    const missing = unique(required).filter((field) => isMissingValue(collected.values[field])).map((fieldName) => ({
      fieldName,
      reason: `规则 ${profile.id}@${profile.version} 需要可追溯的 ${fieldName}。`,
      manualValidationRequired: false,
    }));
    if (missing.length > 0) {
      this.repository.upsertMissingData(job.id, missing);
      const output = { hardGateStatus: 'needs_data', missing };
      this.repository.saveRuleExecution(job, collected.values, output, 'needs_data', null);
      this.repository.finishStep(job.id, 'validate', 'needs_data', output);
      this.repository.failJobDataTasks(job.id, '缺少可比较的历史快照。');
      this.repository.transition(job.id, 'needs_data');
      return null;
    }
    this.repository.finishStep(job.id, 'validate', 'completed', { valid: true, required });
    return true;
  }

  private calculateAndAnalyze(
    job: ResearchJobDetail,
    collected: CollectedWorkflowData,
  ): ResearchJobDetail {
    if (job.status !== 'calculating') {
      throw new Error(`Research Job 当前状态 ${job.status} 不能执行确定性计算。`);
    }
    return isProductResearch(job)
      ? this.calculateProductResearch(job, collected)
      : this.calculateObservedEntity(job, collected);
  }

  private calculateObservedEntity(
    job: ResearchJobDetail,
    collected: CollectedWorkflowData,
  ): ResearchJobDetail {
    const profile = this.repository.getLockedRuleProfile(job);
    this.repository.startStep(job.id, 'calculate', { dataVersion: job.dataVersion });
    this.repository.startStep(job.id, 'hard_gate', { ruleVersion: profile.version });
    this.repository.finishStep(job.id, 'hard_gate', 'completed', { status: 'pass' });
    this.repository.startStep(job.id, 'score', { applicable: false });
    this.repository.finishStep(job.id, 'score', 'skipped', { reason: '该工作流使用确定性相对诊断，不使用新产品评分。' });

    let output: Record<string, unknown>;
    let title: string;
    let summary: string;
    let status: string;
    let performance: PerformanceLevel | undefined;
    let observedChangeFacts: string[] = [];
    if (job.type === 'owned_product') {
      const skuGrowth = requiredCollectedNumber(collected, 'sku_growth_30d');
      const marketGrowth = requiredCollectedNumber(collected, 'market_growth_30d');
      const relativeDelta = round1(skuGrowth - marketGrowth);
      performance = classifyRelativePerformance(relativeDelta, profile);
      output = {
        relative_delta: relativeDelta,
        performance,
        sku_growth_30d: skuGrowth,
        market_growth_30d: marketGrowth,
        direct_competitor_growth_30d: collected.values.direct_competitor_growth_30d ?? null,
        direct_competitor_sample_size: collected.values.direct_competitor_sample_size ?? 0,
        top100_growth_30d: collected.values.top100_growth_30d ?? null,
        top100_sample_size: collected.values.top100_sample_size ?? 0,
      };
      title = ownedPerformanceTitle(performance);
      summary = `SKU 30D 增长 ${formatPercent(skuGrowth)}，市场 ${formatPercent(marketGrowth)}，相对差 ${formatPercent(relativeDelta)}。`;
      status = performance;
    } else {
      const growth = requiredCollectedNumber(collected, 'market_growth_30d');
      const monthlySales = requiredCollectedNumber(collected, 'monthly_sales');
      observedChangeFacts = existingMarketChangeFacts(collected.values);
      output = {
        ...Object.fromEntries(EXISTING_MARKET_EVIDENCE_FIELDS.map((field) => (
          [field, collected.values[field] ?? null]
        ))),
        monthly_sales: monthlySales,
        market_growth_30d: growth,
        diagnostic_coverage: {
          price_band_history: collected.values.price_band_history_available === true,
          top100_history: collected.values.top100_history_available === true,
          submarket_history: collected.values.submarket_history_available === true,
        },
        opportunity: growth >= thresholdNumber(profile, 'growthOpportunityMin', 5),
      };
      title = growth >= thresholdNumber(profile, 'growthOpportunityMin', 5)
        ? '市场增长达到机会阈值'
        : '市场增长低于机会阈值';
      summary = `市场月销量 ${monthlySales}，同一对可比较 Snapshot 计算的 30D 增长为 ${formatPercent(growth)}；可证明 ${existingMarketChangeCount(collected.values)} 项结构变化。`;
      status = growth >= thresholdNumber(profile, 'growthOpportunityMin', 5) ? 'opportunity' : 'stable';
    }
    this.repository.saveRuleExecution(job, collected.values, output, 'pass', null);
    this.repository.finishStep(job.id, 'calculate', 'completed', { output });
    this.repository.startStep(job.id, 'snapshot', { dataVersion: job.dataVersion });
    this.repository.finishStep(job.id, 'snapshot', 'completed', {
      immutableSourceRecordIds: unique(Object.values(collected.sources).map((source) => source.sourceRecordId).filter(Boolean)),
    });

    let current = this.repository.transition(job.id, 'analyzing');
    this.repository.startStep(job.id, 'ai_analysis', {
      promptVersion: current.promptVersion, dataVersion: current.dataVersion,
    });
    const evidenceFields = job.type === 'owned_product'
      ? [
          'sku_growth_30d', 'market_growth_30d',
          ...(typeof collected.values.direct_competitor_growth_30d === 'number'
            ? ['direct_competitor_growth_30d'] : []),
          ...(typeof collected.values.top100_growth_30d === 'number'
            ? ['top100_growth_30d'] : []),
        ]
      : [...EXISTING_MARKET_EVIDENCE_FIELDS];
    const evidence = evidenceFields.filter((field) => !isMissingValue(collected.values[field])).map((field) => this.createFieldEvidence(
      current, collected, field, `${field} 来自当前工作流的可追溯数据与确定性计算。`,
    ));
    if (job.type === 'owned_product') {
      evidence.push(this.createDerivedEvidence(current, collected, evidence, {
        claim: 'SKU 相对市场表现由两个 30D 增长率相减得到。',
        metricName: 'relative_delta',
        metricValue: output.relative_delta,
        calculation: `${collected.calculations.sku_growth_30d}; ${collected.calculations.market_growth_30d}; relative_delta = sku_growth_30d - market_growth_30d`,
      }));
    }
    const ownedDiagnosticGaps = job.type === 'owned_product'
      ? [
          ...OWNED_PRODUCT_DIAGNOSTIC_GAPS,
          ...(Number(output.direct_competitor_sample_size) === 0
            ? [['direct_competitor_history', '缺少直接竞品的可比较历史快照，当前不能判断直接竞争位置。'] as const]
            : []),
          ...(Number(output.top100_sample_size) === 0
            ? [['top100_history', '缺少头部商品的可比较历史快照，当前不能判断 TOP100 竞争位置。'] as const]
            : []),
        ]
      : [];
    const ownedComparisonFacts = job.type === 'owned_product'
      ? [
          ...(typeof output.direct_competitor_growth_30d === 'number'
            ? [`直接竞品 30D 均值 ${formatPercent(output.direct_competitor_growth_30d)}（n=${output.direct_competitor_sample_size}）。`]
            : []),
          ...(typeof output.top100_growth_30d === 'number'
            ? [`TOP100 可比样本 30D 均值 ${formatPercent(output.top100_growth_30d)}（n=${output.top100_sample_size}）。`]
            : []),
        ]
      : [];
    const existingMarketDiagnosticGaps = job.type === 'existing_market'
      ? existingMarketHistoryGaps(collected.values)
      : [];
    this.repository.saveWorkflowInsight(current, {
      status,
      title,
      summary,
      facts: job.type === 'existing_market'
        ? [
            summary,
            `市场结构：产品 ${collected.values.product_count}，卖家 ${collected.values.seller_count}，品牌 ${collected.values.brand_count}。`,
            `价格与集中度：均价 ${collected.values.avg_price}，中位价 ${collected.values.median_price}，TOP10/TOP20 占比 ${collected.values.top10_sales_share}%/${collected.values.top20_sales_share}%，新品占比 ${collected.values.new_product_share}%。`,
            ...observedChangeFacts,
          ]
        : [summary, ...ownedComparisonFacts],
      opportunities: job.type === 'existing_market' && output.opportunity === true
        ? ['市场增速达到规则设定的机会阈值，可继续细分研究。']
        : [],
      risks: job.type === 'owned_product' && performance && performance.includes('underperform')
        ? ['相对跑输说明存在产品或运营差距，但现有证据不足以归因。']
        : [],
      recommendedActions: job.type === 'owned_product'
        ? [
            '补充流量、转化率、广告和退货数据后再定位原因。',
            ...(ownedDiagnosticGaps.some(([field]) => field.endsWith('_history'))
              ? ['补充直接竞品和头部商品的历史快照；当前结论只覆盖 SKU 与市场的相对表现。']
              : []),
          ]
        : [
            '继续追加快照并核验增长是否持续。',
            ...(existingMarketDiagnosticGaps.length > 0
              ? ['补充价格带、TOP100 商品和子市场历史；这些缺口不阻断基础市场趋势判断。']
              : []),
          ],
      evidenceIds: evidence.map((item) => item.id),
      confidence: minimumConfidence(evidence),
      insightType: job.type === 'owned_product' ? 'owned_product_diagnosis' : 'market_diagnosis',
      possibleCauses: job.type === 'owned_product' ? ['流量、转化、价格或评价差异，当前尚未验证。'] : [],
      missingData: [
        ...ownedDiagnosticGaps.map(([fieldName]) => fieldName),
        ...existingMarketDiagnosticGaps.map(([fieldName]) => fieldName),
      ],
      hardGate: 'pass',
      decision: 'watch',
    });
    if (job.type === 'owned_product') {
      this.repository.upsertMissingData(current.id, ownedDiagnosticGaps.map(([fieldName, reason]) => ({
        fieldName,
        reason,
        requiredForDecision: false,
        manualValidationRequired: false,
      })));
    }
    if (job.type === 'existing_market') {
      this.repository.upsertMissingData(current.id, existingMarketDiagnosticGaps.map(([fieldName, reason]) => ({
        fieldName,
        reason,
        requiredForDecision: false,
        manualValidationRequired: false,
      })));
    }
    this.repository.finishStep(job.id, 'ai_analysis', 'completed', {
      evidenceIds: evidence.map((item) => item.id), promptVersion: current.promptVersion,
    });
    for (const step of ['review_gap', 'reverse_review', 'approval'] as const) {
      this.repository.finishStep(job.id, step, 'skipped', { reason: '该步骤仅适用于新产品工作流。' });
    }
    this.repository.startStep(job.id, 'report', { dataVersion: current.dataVersion });
    this.repository.finishStep(job.id, 'report', 'completed', { status, evidenceCount: evidence.length });
    current = this.repository.transition(current.id, 'monitoring');
    return current;
  }

  private calculateProductResearch(
    job: ResearchJobDetail,
    collected: CollectedWorkflowData,
  ): ResearchJobDetail {
    const profile = this.repository.getLockedRuleProfile(job);
    const result = executeProductRules(profile, job.input, job.taskBook);
    this.repository.startStep(job.id, 'calculate', { dataVersion: job.dataVersion });
    this.repository.startStep(job.id, 'hard_gate', { ruleVersion: profile.version });
    const executionInput = { ...job.input, taskBook: job.taskBook };
    const execution = this.repository.saveRuleExecution(
      job, executionInput, { ...result }, result.hardGateStatus, result.score,
    );
    this.repository.finishStep(job.id, 'hard_gate', 'completed', {
      status: result.hardGateStatus, reasons: result.rejectionReasons,
      calculation: result.calculation,
    });
    this.repository.startStep(job.id, 'score', { ruleExecutionId: execution.id });
    if (result.score !== null && result.breakdown) {
      this.repository.saveScoreResult(job.id, execution.id, result.score, result.breakdown, result.calculation);
      this.repository.finishStep(job.id, 'score', 'completed', {
        total: result.score, breakdown: result.breakdown, calculation: result.calculation,
      });
    } else {
      this.repository.finishStep(job.id, 'score', 'skipped', {
        reason: result.hardGateStatus === 'reject' ? 'Hard Gate 已拒绝，评分不得抵消。' : '没有可计算评分。',
        calculation: result.calculation,
      });
    }
    this.repository.finishStep(job.id, 'calculate', 'completed', {
      hardGateStatus: result.hardGateStatus, score: result.score,
      suggestedDecision: result.suggestedDecision,
    });
    this.repository.startStep(job.id, 'snapshot', { dataVersion: job.dataVersion });
    this.repository.finishStep(job.id, 'snapshot', 'completed', {
      normalizedInputOnly: true, dataVersion: job.dataVersion,
    });

    let current = this.repository.transition(job.id, 'analyzing');
    const evidence = this.createProductEvidence(current, result, collected);
    this.repository.startStep(job.id, 'ai_analysis', {
      promptVersion: current.promptVersion, ruleVersion: current.ruleProfileVersion,
    });
    if (result.hardGateStatus === 'reject' || result.suggestedDecision === 'reject') {
      this.repository.saveWorkflowInsight(current, {
        status: 'rejected',
        title: result.hardGateStatus === 'reject' ? 'Hard Gate 未通过' : '评分低于观察阈值',
        summary: result.rejectionReasons.join('；') || `规则评分 ${result.score ?? 0} 低于最低观察阈值。`,
        score: result.score ?? undefined,
        facts: result.rejectionReasons,
        opportunities: [],
        risks: result.rejectionReasons.length > 0 ? result.rejectionReasons : ['当前规则评分不足以支持进入验证阶段。'],
        recommendedActions: ['停止当前方案，修正硬性条件或重新建立研究任务。'],
        evidenceIds: evidence.map((item) => item.id),
        confidence: minimumConfidence(evidence),
        insightType: 'new_product_research',
        possibleCauses: [],
        missingData: [],
        hardGate: result.hardGateStatus,
        decision: 'reject',
      });
      this.repository.finishStep(job.id, 'ai_analysis', 'completed', {
        promptVersion: current.promptVersion, evidenceIds: evidence.map((item) => item.id),
      });
      for (const step of ['review_gap', 'reverse_review', 'approval'] as const) {
        this.repository.finishStep(job.id, step, 'skipped', { reason: '规则已拒绝，后续 Gate 不执行。' });
      }
      this.repository.startStep(job.id, 'report', { dataVersion: current.dataVersion });
      this.repository.finishStep(job.id, 'report', 'completed', { decision: 'reject' });
      return this.repository.transition(current.id, 'rejected');
    }

    const reviewGap = this.runReviewGap(current, collected.reviews);
    const reviewInsights = reviewGap.insights;
    if (reviewGap.missingData.length > 0) {
      this.repository.upsertMissingData(current.id, reviewGap.missingData);
    }
    const reviewEvidenceIds = unique(reviewInsights.flatMap((item) => item.evidenceIds));
    const allEvidenceIds = unique([...evidence.map((item) => item.id), ...reviewEvidenceIds]);
    this.repository.saveWorkflowInsight(current, {
      status: 'pending_approval',
      title: `规则建议：${result.suggestedDecision}`,
      summary: `Hard Gate 已通过，确定性评分为 ${result.score}；该结果只建议下一阶段动作，须经过 Reverse Review 和人工 Approval。`,
      score: result.score ?? undefined,
      facts: [`规则版本 ${current.ruleProfileId}@${current.ruleProfileVersion}`, `数据版本 ${current.dataVersion}`],
      opportunities: reviewInsights.filter((item) => item.opportunityLevel === 'high').map((item) => `${item.issue} 为高优先级评论缺口。`),
      risks: reviewInsights.filter((item) => item.opportunityLevel !== 'high').map((item) => `${item.issue} 尚需更多证据或成本验证。`),
      recommendedActions: ['由负责人复核 Reverse Review 后决定是否进入开发或测试。'],
      evidenceIds: allEvidenceIds,
      confidence: minimumConfidence(this.repository.getEvidence(current.id).filter((item) => allEvidenceIds.includes(item.id))),
      insightType: 'new_product_research',
      possibleCauses: reviewInsights.map((item) => item.issue),
      missingData: reviewGap.missingData.map((item) => item.fieldName),
      hardGate: 'pass',
      decision: result.suggestedDecision,
    });
    this.repository.finishStep(job.id, 'ai_analysis', 'completed', {
      promptVersion: current.promptVersion, evidenceIds: allEvidenceIds,
    });
    current = this.repository.transition(current.id, 'reverse_review');
    this.runReverseReview(current, result, evidence, reviewInsights);
    this.repository.startStep(job.id, 'report', { dataVersion: current.dataVersion });
    this.repository.finishStep(job.id, 'report', 'completed', {
      score: result.score, suggestedDecision: result.suggestedDecision,
    });
    current = this.repository.transition(current.id, 'waiting_approval');
    this.repository.startStep(job.id, 'approval', { requestedAction: result.suggestedDecision });
    const approval = this.repository.createPendingApproval(current, result.suggestedDecision);
    this.repository.finishStep(job.id, 'approval', 'completed', {
      approvalId: approval.id, status: approval.status,
    });
    return this.requireJob(job.id);
  }

  private createFieldEvidence(
    job: ResearchJobDetail,
    collected: CollectedWorkflowData,
    field: string,
    claim: string,
  ): WorkflowEvidence {
    const source = collected.sources[field] ?? unknownSource(job);
    return this.repository.createEvidence(job.id, {
      claim,
      metricName: field,
      metricValue: collected.values[field] ?? null,
      source: source.source,
      sourceType: source.sourceType,
      sourceRecordId: source.sourceRecordId,
      collectedAt: source.collectedAt,
      period: source.period,
      isEstimated: source.isEstimated,
      calculation: collected.calculations[field] ?? `normalized(${field})`,
      confidence: source.confidence,
      dataVersion: job.dataVersion,
    });
  }

  private createDerivedEvidence(
    job: ResearchJobDetail,
    collected: CollectedWorkflowData,
    components: WorkflowEvidence[],
    input: Pick<WorkflowEvidence, 'claim' | 'metricName' | 'metricValue' | 'calculation'>,
  ): WorkflowEvidence {
    const sources = [collected.sources.sku_growth_30d, collected.sources.market_growth_30d]
      .filter((source): source is FieldSource => Boolean(source));
    const componentEvidence = components.filter((item) => (
      item.metricName === 'sku_growth_30d' || item.metricName === 'market_growth_30d'
    ));
    return this.repository.createEvidence(job.id, {
      ...input,
      source: 'Deterministic calculation from component Evidence',
      sourceType: 'manual',
      collectedAt: sources.map((source) => source.collectedAt).sort().at(-1) ?? new Date().toISOString(),
      period: '30D',
      isEstimated: sources.some((source) => source.isEstimated),
      calculation: `${input.calculation}; component sources: ${componentEvidence.map((item) => (
        `${item.metricName}=${item.sourceType}:${item.sourceRecordId ?? 'unrecorded'}`
          + `${item.syncRunId ? ` (run ${item.syncRunId})` : ''}`
      )).join(', ')}`,
      confidence: sources.length > 0 ? Math.min(...sources.map((source) => source.confidence)) : 0,
      dataVersion: job.dataVersion,
    });
  }

  private createProductEvidence(
    job: ResearchJobDetail,
    result: ProductRuleResult,
    collected: CollectedWorkflowData,
  ): WorkflowEvidence[] {
    void collected;
    const fields = [
      'ip_risk', 'certification_required', 'certification_available',
      'estimated_contribution_profit_rate', 'moq_cost', 'weight', 'dimensions',
      'supply_chain_validation', 'monthly_sales', 'growth_30d', 'top10_sales_share',
      'median_reviews', 'supply_chain_fit_score', 'risk_control_score',
    ].filter((field) => !isMissingValue(job.input[field]));
    const evidence = fields.map((field) => this.repository.createEvidence(job.id, {
      claim: `${field} 是本轮规则执行使用的已提供事实。`,
      metricName: field,
      metricValue: job.input[field],
      source: job.isDemo ? 'Demo task input (DEMO)' : 'Manual input',
      sourceType: job.isDemo ? 'mock' : 'manual',
      collectedAt: new Date().toISOString(),
      period: 'point_in_time',
      isEstimated: field.startsWith('estimated_'),
      calculation: `validated input.${field}`,
      confidence: job.isDemo ? 0.9 : 0.75,
      dataVersion: job.dataVersion,
    }));
    if (result.score !== null) {
      evidence.push(this.repository.createEvidence(job.id, {
        claim: '总分由不可变 RuleProfile 快照中的五个类别得分相加得到。',
        metricName: 'opportunity_score',
        metricValue: result.score,
        source: `${job.ruleProfileId}@${job.ruleProfileVersion}`,
        sourceType: 'manual',
        collectedAt: new Date().toISOString(),
        period: 'research_run',
        isEstimated: false,
        calculation: JSON.stringify(result.calculation),
        confidence: 1,
        dataVersion: job.dataVersion,
      }));
    }
    return evidence;
  }

  private runReviewGap(job: ResearchJobDetail, reviews: unknown[]): ReviewGapAnalysisResult {
    this.repository.startStep(job.id, 'review_gap', { reviewCount: reviews.length });
    if (reviews.length === 0) {
      this.repository.finishStep(job.id, 'review_gap', 'skipped', {
        reason: '未提供评论样本；本轮不输出评论缺口强结论。',
      });
      return { insights: [], missingData: [] };
    }
    const saved = this.repository.saveReviews(job, reviews);
    const totalSourceRecordIds = unique(saved.map((review) => review.sourceRecordId));
    const buckets = new Map<ReviewIssue, typeof saved>();
    for (const review of saved) {
      for (const issue of classifyReviewIssues(review.text)) {
        const current = buckets.get(issue) ?? [];
        current.push(review);
        buckets.set(issue, current);
      }
    }
    const insights: ReviewInsight[] = [];
    const missingData: ReviewGapAnalysisResult['missingData'] = [];
    for (const [issue, issueReviews] of buckets) {
      const issueSourceRecordIds = unique(issueReviews.map((review) => review.sourceRecordId));
      const affectedProductIds = unique(issueReviews.map((review) => review.productId));
      const competitorsAffected = affectedProductIds.length;
      const frequency = round3(issueSourceRecordIds.length / totalSourceRecordIds.length);
      const evidenceIds = issueReviews.map((review) => this.repository.createEvidence(job.id, {
        claim: `评论样本出现 ${issue} 问题。`,
        metricName: `review_gap.${issue}`,
        metricValue: 1,
        source: review.source,
        sourceType: job.isDemo ? 'mock' : reviewSourceType(review.source),
        sourceRecordId: review.sourceRecordId,
        collectedAt: review.collectedAt,
        period: 'review_sample',
        isEstimated: false,
        calculation: [
          `taxonomy(${issue}) matched original source record ${review.sourceRecordId}`,
          `frequency=${issueSourceRecordIds.length}/${totalSourceRecordIds.length}=${frequency}`,
          `competitorsAffected=unique(${affectedProductIds.join(',')})=${competitorsAffected}`,
          `persistedReview=${review.id}`,
        ].join('; '),
        confidence: 0.8,
        dataVersion: job.dataVersion,
      }).id);
      const support = validatedReviewGapSupport(job.input, issue);
      if (support) {
        evidenceIds.push(
          this.repository.createEvidence(job.id, {
            claim: `经验证的供应商记录已对 ${issue} 的产品级可解决性作出明确判断。`,
            metricName: `review_gap.${issue}.supply_chain_solvable`,
            metricValue: support.supplier.solvable,
            source: support.supplier.source,
            sourceType: 'manual',
            sourceRecordId: support.supplier.sourceRecordId,
            collectedAt: support.supplier.collectedAt,
            period: 'point_in_time',
            isEstimated: false,
            calculation: `validated input.review_gap_support.${issue}.supplier; capability scope is issue-specific`,
            confidence: 0.75,
            dataVersion: job.dataVersion,
          }).id,
          this.repository.createEvidence(job.id, {
            claim: `经验证的成本记录已对 ${issue} 的解决成本影响作出明确判断。`,
            metricName: `review_gap.${issue}.cost_impact`,
            metricValue: support.cost.impact,
            source: support.cost.source,
            sourceType: 'manual',
            sourceRecordId: support.cost.sourceRecordId,
            collectedAt: support.cost.collectedAt,
            period: 'point_in_time',
            isEstimated: false,
            calculation: `validated input.review_gap_support.${issue}.cost; explicit issue-specific cost evidence`,
            confidence: 0.75,
            dataVersion: job.dataVersion,
          }).id,
        );
      } else {
        missingData.push({
          fieldName: `review_gap_support.${issue}`,
          reason: `评论只能证明 ${issue} 的频率和受影响商品数；缺少 issue 级、已验证且可追溯的供应商可解决性与成本依据。`,
          requiredForDecision: false,
          manualValidationRequired: true,
        });
      }
      const opportunityLevel = reviewOpportunityLevel(
        saved.length, competitorsAffected, frequency, support,
      );
      insights.push(this.repository.saveReviewInsight(job.id, {
        issue,
        frequency,
        competitorsAffected,
        isCrossMarketIssue: false,
        supplyChainSolvable: support?.supplier.solvable ?? null,
        costImpact: support?.cost.impact ?? null,
        opportunityLevel,
        evidenceIds,
      }));
    }
    this.repository.finishStep(job.id, 'review_gap', 'completed', {
      persistedReviewCount: saved.length,
      issues: insights.map((item) => ({
        issue: item.issue,
        frequency: item.frequency,
        competitorsAffected: item.competitorsAffected,
        supplyChainSolvable: item.supplyChainSolvable,
        costImpact: item.costImpact,
        opportunityLevel: item.opportunityLevel,
      })),
      missingSupportFields: missingData.map((item) => item.fieldName),
      evidenceIds: unique(insights.flatMap((item) => item.evidenceIds)),
    });
    return { insights, missingData };
  }

  private runReverseReview(
    job: ResearchJobDetail,
    result: ProductRuleResult,
    evidence: WorkflowEvidence[],
    reviewInsights: ReviewInsight[],
  ): void {
    this.repository.startStep(job.id, 'reverse_review', {
      score: result.score, suggestedDecision: result.suggestedDecision,
    });
    const assessment = assessReverseReview({
      jobInput: job.input,
      taskBook: job.taskBook,
      suggestedDecision: result.suggestedDecision,
      evidence,
      reviewInsights,
    });
    this.repository.saveReverseReview(job.id, {
      verdict: assessment.verdict,
      topFailureModes: assessment.topFailureModes,
      unknowns: assessment.unknowns,
      recommendation: assessment.recommendation,
    });
    this.repository.finishStep(job.id, 'reverse_review', 'completed', {
      verdict: assessment.verdict,
      topFailureModes: assessment.topFailureModes,
      checklist: assessment.checklist,
      ruleVersion: job.ruleProfileVersion,
      promptVersion: job.promptVersion,
    });
  }

  private collectMarket(job: ResearchJobDetail): CollectedWorkflowData & { growthPair?: SnapshotGrowthPair } {
    const marketId = requiredEntityId(job);
    const allRows = this.database.prepare(`
      SELECT snapshot.* FROM market_snapshots snapshot
      JOIN market_nodes node ON node.id = snapshot.market_node_id
      WHERE snapshot.market_node_id = ? AND node.marketplace = ?
        AND (? = 1 OR snapshot.source_type <> 'mock')
      ORDER BY COALESCE(snapshot.observation_date, snapshot.date) DESC, snapshot.collected_at DESC
    `).all(marketId, job.marketplace, job.isDemo ? 1 : 0) as SnapshotRow[];
    const rows = job.isDemo ? allRows : allRows.filter((row) => isLiveObservationReadable(
      this.database, 'market', text(row.id), text(row.source_type),
      row.sync_run_id === null ? null : text(row.sync_run_id),
    ));
    if (rows.length === 0) return emptyCollected();
    const dates = unique(rows.map((row) => text(row.observation_date) || text(row.date)));
    const resolve = (date: string, metric: string): MetricFact | null => {
      const resolution = this.authority.resolveMetric({
        entityType: 'market', entityId: marketId, observationDate: date, metric,
      });
      return [resolution.selected, ...resolution.alternatives].find((fact) => (
        fact !== null && (job.isDemo || fact.sourceType !== 'mock')
      )) ?? null;
    };
    const representative = (date: string, fact: MetricFact | null): SnapshotRow => {
      const candidates = rows.filter((row) => (text(row.observation_date) || text(row.date)) === date);
      return candidates.find((row) => text(row.id) === fact?.id)
        ?? candidates.find((row) => row.source_type === fact?.sourceType && row.source === fact.source)
        ?? candidates[0];
    };
    const metricSource = (date: string, fact: MetricFact): FieldSource => (
      sourceFromMetricFact(fact, text(representative(date, fact).period))
    );
    const salesHistory = dates.map((date) => {
      const fact = resolve(date, 'monthly_sales');
      return { id: fact?.id ?? `missing:${date}`, date, value: fact?.value ?? null,
        source: fact ? metricSource(date, fact) : null };
    });
    const rawGrowth = comparableSnapshotGrowth(salesHistory);
    const growthSources = rawGrowth ? [rawGrowth.latest, rawGrowth.baseline].map((point) => (
      salesHistory.find((item) => item.id === point.id)?.source ?? null
    )) : [];
    const growth = rawGrowth && this.hasOneCompleteMcpRun(growthSources, job.marketplace)
      ? rawGrowth : null;
    const latestDate = dates[0];
    const currentSales = salesHistory[0];
    const baselineSales = growth ? salesHistory.find((point) => point.date === growth.baseline.date) : undefined;
    const latest = representative(latestDate, resolve(latestDate, 'monthly_sales'));
    const baseline = baselineSales ? representative(baselineSales.date, resolve(baselineSales.date, 'monthly_sales')) : undefined;
    const source = currentSales.source ?? sourceFromSnapshot(latest);
    const currentPriceBands = marketPriceBands(latest.price_bands_json);
    const baselinePriceBands = marketPriceBands(baseline?.price_bands_json);
    const currentConcentration = marketConcentration(latest.concentration_json);
    const baselineConcentration = marketConcentration(baseline?.concentration_json);
    const marketFields = [
      ['monthly_sales', 'monthly_sales'], ['monthly_revenue', 'monthly_revenue'],
      ['product_count', 'product_count'], ['seller_count', 'seller_count'],
      ['brand_count', 'brand_count'], ['avg_price', 'avg_price'],
      ['median_price', 'median_price'], ['avg_rating', 'avg_rating'],
      ['median_reviews', 'median_reviews'], ['top10_sales_share', 'top10_share'],
      ['top20_sales_share', 'top20_share'], ['new_product_share', 'new_product_share'],
    ] as const;
    const currentFacts = Object.fromEntries(marketFields.map(([field, metric]) => [field, resolve(latestDate, metric)])) as
      Record<typeof marketFields[number][0], MetricFact | null>;
    const values: Record<string, unknown> = {
      ...Object.fromEntries(marketFields.map(([field]) => [field, currentFacts[field]?.value ?? null])),
      market_growth_30d: growth?.growth ?? null,
      market_growth_baseline: growth ? true : null,
      market_growth_elapsed_days: growth?.elapsedDays ?? null,
    };
    const calculations: Record<string, string> = {};
    if (growth && baseline) {
      const percentChanges = [
        ['monthly_revenue_change_30d_pct', 'monthly_revenue', 'Market revenue'],
        ['product_count_change_30d_pct', 'product_count', 'Product count'],
        ['seller_count_change_30d_pct', 'seller_count', 'Seller count'],
        ['brand_count_change_30d_pct', 'brand_count', 'Brand count'],
        ['avg_price_change_30d_pct', 'avg_price', 'Average price'],
        ['median_price_change_30d_pct', 'median_price', 'Median price'],
        ['median_reviews_change_30d_pct', 'median_reviews', 'Median reviews'],
      ] as const;
      for (const [outputField, snapshotField, label] of percentChanges) {
        const currentFact = resolve(latestDate, snapshotField);
        const baselineFact = resolve(baselineSales!.date, snapshotField);
        const currentValue = currentFact?.value;
        const baselineValue = baselineFact?.value;
        values[outputField] = currentValue != null && baselineValue != null
          && comparableSources(metricSource(latestDate, currentFact!), metricSource(baselineSales!.date, baselineFact!))
          && this.hasOneCompleteMcpRun([
            ...growthSources,
            metricSource(latestDate, currentFact!), metricSource(baselineSales!.date, baselineFact!),
          ], job.marketplace)
          ? percentageChange(currentValue, baselineValue) : null;
        if (values[outputField] !== null) calculations[outputField] = percentageChangeCalculation(
          label, currentFact!.id, currentValue!, baselineFact!.id, baselineValue!,
          growth.elapsedDays, values[outputField],
        );
      }
      const absoluteChanges = [
        ['avg_rating_change_30d', 'avg_rating', 'Average rating', 'absolute'],
        ['top10_sales_share_change_30d_pp', 'top10_share', 'TOP10 sales share', 'pp'],
        ['top20_sales_share_change_30d_pp', 'top20_share', 'TOP20 sales share', 'pp'],
        ['new_product_share_change_30d_pp', 'new_product_share', 'New-product share', 'pp'],
      ] as const;
      for (const [outputField, snapshotField, label, unit] of absoluteChanges) {
        const currentFact = resolve(latestDate, snapshotField);
        const baselineFact = resolve(baselineSales!.date, snapshotField);
        const currentValue = currentFact?.value;
        const baselineValue = baselineFact?.value;
        values[outputField] = currentValue != null && baselineValue != null
          && comparableSources(metricSource(latestDate, currentFact!), metricSource(baselineSales!.date, baselineFact!))
          && this.hasOneCompleteMcpRun([
            ...growthSources,
            metricSource(latestDate, currentFact!), metricSource(baselineSales!.date, baselineFact!),
          ], job.marketplace)
          ? round3(currentValue - baselineValue) : null;
        if (values[outputField] !== null) calculations[outputField] = absoluteChangeCalculation(
          label, currentFact!.id, currentValue!, baselineFact!.id, baselineValue!,
          growth.elapsedDays, values[outputField], unit,
        );
      }
      if (currentPriceBands.length > 0 && baselinePriceBands.length > 0
        && this.hasOneCompleteMcpRun([
          ...growthSources, sourceFromSnapshot(latest), sourceFromSnapshot(baseline),
        ], job.marketplace)) {
        values.price_bands_change_30d = comparePriceBands(
          currentPriceBands, baselinePriceBands, growth,
        );
        calculations.price_bands_change_30d = `Price bands: match label and compare fields from current ${growth.latest.id} with baseline ${growth.baseline.id} over ${growth.elapsedDays} days; percentage deltas keep null when a baseline is zero.`;
      } else {
        values.price_bands_change_30d = null;
      }
      if (currentConcentration.length > 0 && baselineConcentration.length > 0
        && this.hasOneCompleteMcpRun([
          ...growthSources, sourceFromSnapshot(latest), sourceFromSnapshot(baseline),
        ], job.marketplace)) {
        values.concentration_change_30d = compareConcentration(
          currentConcentration, baselineConcentration, growth,
        );
        calculations.concentration_change_30d = `Concentration: match tier and compare fields from current ${growth.latest.id} with baseline ${growth.baseline.id} over ${growth.elapsedDays} days; share is an absolute pp delta.`;
      } else {
        values.concentration_change_30d = null;
      }
    }
    values.price_band_history_available = values.price_bands_change_30d !== null
      && values.price_bands_change_30d !== undefined;
    values.top100_history_available = job.type === 'existing_market'
      ? this.hasTop100History(marketId, job.marketplace, job.isDemo)
      : false;
    values.submarket_history_available = job.type === 'existing_market'
      ? this.hasSubmarketHistory(marketId, job.marketplace, job.isDemo)
      : false;
    const sources = Object.fromEntries(Object.keys(values).map((field) => {
      const metric = field.replace(/(?:_change_30d_pct|_change_30d_pp|_change_30d)$/, '');
      const currentFact = currentFacts[metric as keyof typeof currentFacts];
      const currentMetricSource = currentFact ? metricSource(latestDate, currentFact) : source;
      const rawMetric = marketFields.find(([outputField]) => outputField === metric)?.[1];
      const baselineFact = field.includes('_change_30d') && baselineSales && rawMetric
        ? resolve(baselineSales.date, rawMetric) : null;
      const comparisonSource = baselineFact ? metricSource(baselineSales!.date, baselineFact) : null;
      const selectedSource = comparisonSource ? { ...currentMetricSource,
        source: unique([currentMetricSource.source, comparisonSource.source]).join(' + '),
        isEstimated: currentMetricSource.isEstimated || comparisonSource.isEstimated,
        confidence: Math.min(currentMetricSource.confidence, comparisonSource.confidence) } : currentMetricSource;
      return [field, {
        ...selectedSource,
        sourceRecordId: growth && field.startsWith('market_growth') ? growth.latest.id : selectedSource.sourceRecordId,
        period: field.startsWith('market_growth') || field.includes('_change_30d') ? '30D' : selectedSource.period,
      }];
    })) as Record<string, FieldSource>;
    if (growth) {
      calculations.market_growth_30d = growthCalculation('Market sales', growth);
      calculations.market_growth_elapsed_days = `Snapshot dates ${growth.latest.date} and ${growth.baseline.date}: ${growth.elapsedDays} elapsed days.`;
    }
    return { values, sources, calculations, reviews: [], growthPair: growth ?? undefined };
  }

  private hasTop100History(marketId: string, marketplace: string, allowMock: boolean): boolean {
    const productIds = this.top100ProductIds(marketId, marketplace, allowMock);
    return productIds.length === 100
      && productIds.every((productId) => this.getProductGrowth(productId, marketplace) !== null);
  }

  private top100ProductIds(
    marketId: string, marketplace: string, allowMock: boolean, excludedProductId?: string,
  ): string[] {
    const rows = this.database.prepare(`
      SELECT candidate.id AS productId, snapshot.id AS snapshotId, snapshot.bsr,
        snapshot.source_type AS sourceType, snapshot.sync_run_id AS syncRunId
      FROM products candidate
      JOIN product_snapshots snapshot ON snapshot.product_id = candidate.id
      WHERE candidate.market_node_id = ? AND candidate.marketplace = ?
        AND candidate.is_owned = 0 AND candidate.status = 'active'
        AND candidate.is_parent = 0
        AND (? = 1 OR candidate.source_type <> 'mock')
        AND (? IS NULL OR candidate.id <> ?)
      ORDER BY candidate.id, snapshot.date DESC, snapshot.collected_at DESC, snapshot.id DESC
    `).all(
      marketId, marketplace, allowMock ? 1 : 0,
      excludedProductId ?? null, excludedProductId ?? null,
    ) as Array<{
      productId: string; snapshotId: string; bsr: number | null;
      sourceType: string; syncRunId: string | null;
    }>;
    const latest = new Map<string, number | null>();
    for (const row of rows) {
      if (latest.has(row.productId)) continue;
      if (!allowMock && !isLiveObservationReadable(
        this.database, 'product', row.snapshotId, row.sourceType, row.syncRunId,
      )) continue;
      latest.set(row.productId, strictNumber(row.bsr, Number.MIN_VALUE));
    }
    return [...latest.entries()]
      .filter((entry): entry is [string, number] => entry[1] !== null)
      .sort((left, right) => left[1] - right[1] || left[0].localeCompare(right[0]))
      .slice(0, 100)
      .map(([productId]) => productId);
  }

  private hasSubmarketHistory(marketId: string, marketplace: string, allowMock: boolean): boolean {
    const children = this.database.prepare(`
      SELECT id FROM market_nodes WHERE parent_id = ? AND marketplace = ?
    `).all(marketId, marketplace) as Array<{ id: string }>;
    if (children.length === 0) return false;
    return children.every(({ id }) => {
      const allSnapshots = this.database.prepare(`
        SELECT id, date, observation_date, source, source_type,
          period, sync_run_id FROM market_snapshots WHERE market_node_id = ?
          AND (? = 1 OR source_type <> 'mock')
      `).all(id, allowMock ? 1 : 0) as SnapshotRow[];
      const snapshots = allowMock ? allSnapshots : allSnapshots.filter((snapshot) => (
        isLiveObservationReadable(this.database, 'market', text(snapshot.id),
          text(snapshot.source_type), snapshot.sync_run_id === null ? null : text(snapshot.sync_run_id))
      ));
      const dates = unique(snapshots.map((snapshot) => text(snapshot.observation_date) || text(snapshot.date)));
      return comparableSnapshotGrowth(dates.map((date) => {
        const resolution = this.authority.resolveMetric({
          entityType: 'market', entityId: id, metric: 'monthly_sales', observationDate: date,
        });
        const fact = [resolution.selected, ...resolution.alternatives].find((candidate) => (
          candidate !== null && (allowMock || candidate.sourceType !== 'mock')
        )) ?? null;
        const matchingSnapshot = snapshots.find((snapshot) => (
          (text(snapshot.observation_date) || text(snapshot.date)) === date
          && (text(snapshot.id) === fact?.id
            || (snapshot.source_type === fact?.sourceType && snapshot.source === fact.source))
        ));
        return {
          id: fact?.id ?? `missing:${date}`, date, value: fact?.value ?? null,
          source: fact ? sourceFromMetricFact(fact, text(matchingSnapshot?.period)) : null,
        };
      })) !== null;
    });
  }

  private collectOwnedProduct(job: ResearchJobDetail): CollectedWorkflowData {
    const productId = requiredEntityId(job);
    const owned = this.intelligence.getOwnedProduct(productId);
    if (!owned || owned.marketplace !== job.marketplace) throw new Error('自有产品不存在或不属于当前站点。');
    const productRows = this.intelligence.getProductSnapshots(productId);
    const productSalesHistory = productRows.map((row) => ({
      id: row.metricProvenance?.estimated_sales?.sourceRecordId ?? row.id,
      date: row.date, value: row.estimatedSales,
      source: row.metricProvenance?.estimated_sales
        ? this.productMetricSource(row, 'estimated_sales')
        : null,
    }));
    const rawSkuGrowth = comparableSnapshotGrowth(productSalesHistory);
    const skuGrowth = rawSkuGrowth && this.hasOneCompleteMcpRun([
      productSalesHistory.find((point) => point.id === rawSkuGrowth.latest.id)?.source ?? null,
      productSalesHistory.find((point) => point.id === rawSkuGrowth.baseline.id)?.source ?? null,
    ], job.marketplace) ? rawSkuGrowth : null;
    const market = this.collectMarket({ ...job, entityId: owned.marketNodeId });
    const skuGrowthSource = skuGrowth
      ? productSalesHistory.find((point) => point.id === skuGrowth.latest.id)?.source ?? null : null;
    const coreGrowthSources = [skuGrowthSource, market.sources.market_growth_30d ?? null];
    const comparableSkuGrowth = skuGrowth && market.growthPair
      && sameGrowthMonths(skuGrowth, market.growthPair)
      && this.sharesCompleteMcpRun(coreGrowthSources, job.marketplace) ? skuGrowth : null;
    const competitorRows = this.database.prepare(`
      SELECT relation.competitor_product_id AS product_id
      FROM competitor_relations relation
      JOIN products competitor ON competitor.id = relation.competitor_product_id
      WHERE relation.owned_product_id = ? AND relation.relation_type = 'direct'
        AND competitor.marketplace = ? AND competitor.is_owned = 0
        AND competitor.is_parent = 0
        AND competitor.status = 'active' AND (? = 1 OR competitor.source_type <> 'mock')
    `).all(productId, job.marketplace, job.isDemo ? 1 : 0) as Array<{ product_id: string }>;
    const competitorGrowths = competitorRows.map(({ product_id: competitorId }) => ({
      competitorId,
      pair: this.getProductGrowth(competitorId, job.marketplace),
    })).filter((item): item is { competitorId: string; pair: SourcedGrowthPair } => (
      item.pair !== null && comparableSkuGrowth !== null
        && sameGrowthMonths(item.pair, comparableSkuGrowth)
        && this.sharesCompleteMcpRun([
          ...coreGrowthSources, item.pair.latestSource, item.pair.baselineSource,
        ], job.marketplace)
    ));
    const top100Growths = this.top100ProductIds(
      owned.marketNodeId, job.marketplace, job.isDemo, productId,
    ).map((candidateId) => ({
      productId: candidateId,
      pair: this.getProductGrowth(candidateId, job.marketplace),
    })).filter((item): item is { productId: string; pair: SourcedGrowthPair } => (
      item.pair !== null && comparableSkuGrowth !== null
        && sameGrowthMonths(item.pair, comparableSkuGrowth)
        && this.sharesCompleteMcpRun([
          ...coreGrowthSources, item.pair.latestSource, item.pair.baselineSource,
        ], job.marketplace)
    ));
    const comparableCompetitorGrowths = this.hasOneCompleteMcpRun(competitorGrowths.flatMap((item) => (
      [item.pair.latestSource, item.pair.baselineSource]
    )), job.marketplace) ? competitorGrowths : [];
    const comparableTop100Growths = this.hasOneCompleteMcpRun(top100Growths.flatMap((item) => (
      [item.pair.latestSource, item.pair.baselineSource]
    )), job.marketplace) ? top100Growths : [];
    const latest = productRows.at(-1);
    const skuSource = latest ? this.productMetricSource(latest, 'estimated_sales') : unknownSource(job);
    const values: Record<string, unknown> = {
      sku_growth_30d: comparableSkuGrowth?.growth ?? null,
      market_growth_30d: market.values.market_growth_30d ?? null,
      market_growth_baseline: market.values.market_growth_baseline ?? null,
      direct_competitor_growth_30d: comparableCompetitorGrowths.length > 0
        ? round1(comparableCompetitorGrowths.reduce((sum, item) => sum + item.pair.growth, 0) / comparableCompetitorGrowths.length)
        : null,
      direct_competitor_sample_size: comparableCompetitorGrowths.length,
      top100_growth_30d: comparableTop100Growths.length > 0
        ? round1(comparableTop100Growths.reduce((sum, item) => sum + item.pair.growth, 0) / comparableTop100Growths.length)
        : null,
      top100_sample_size: comparableTop100Growths.length,
      current_sales: latest?.estimatedSales ?? null,
      current_price: latest?.price ?? null,
      current_rating: latest?.rating ?? null,
      current_review_count: latest?.reviewCount ?? null,
      current_bsr: latest?.bsr ?? null,
    };
    const sources: Record<string, FieldSource> = {
      sku_growth_30d: { ...skuSource, sourceRecordId: comparableSkuGrowth?.latest.id ?? skuSource.sourceRecordId, period: '30D' },
      market_growth_30d: market.sources.market_growth_30d ?? unknownSource(job),
      market_growth_baseline: market.sources.market_growth_baseline ?? unknownSource(job),
      direct_competitor_growth_30d: comparableCompetitorGrowths[0]
        ? { ...comparableCompetitorGrowths[0].pair.latestSource, period: '30D' }
        : unknownSource(job),
      top100_growth_30d: comparableTop100Growths[0]
        ? { ...comparableTop100Growths[0].pair.latestSource, period: '30D' }
        : unknownSource(job),
    };
    for (const field of ['direct_competitor_sample_size', 'top100_sample_size', 'current_sales']) sources[field] = skuSource;
    for (const [field, metric] of [
      ['current_price', 'price'], ['current_rating', 'rating'],
      ['current_review_count', 'review_count'], ['current_bsr', 'bsr'],
    ] as const) sources[field] = latest ? this.productMetricSource(latest, metric) : unknownSource(job);
    const calculations: Record<string, string> = { ...market.calculations };
    if (comparableSkuGrowth) calculations.sku_growth_30d = growthCalculation('SKU estimated sales', comparableSkuGrowth);
    if (comparableCompetitorGrowths.length > 0) {
      calculations.direct_competitor_growth_30d = `mean(${comparableCompetitorGrowths.map((item) => (
        `${item.competitorId}:${item.pair.latest.id}/${item.pair.baseline.id}=${item.pair.growth}%`
      )).join(', ')})`;
    }
    if (comparableTop100Growths.length > 0) {
      calculations.top100_growth_30d = `mean(${comparableTop100Growths.map((item) => (
        `${item.productId}:${item.pair.latest.id}/${item.pair.baseline.id}=${item.pair.growth}%`
      )).join(', ')})`;
    }
    return { values, sources, calculations, reviews: [] };
  }

  private collectProductResearch(job: ResearchJobDetail): CollectedWorkflowData {
    const source = unknownSource(job, job.isDemo ? 'Demo task input (DEMO)' : 'Manual input');
    const imported = (this.database.prepare(`
      SELECT id, product_id, review_text, rating, review_date, source, source_record_id,
        collected_at, normalized_json
      FROM reviews WHERE research_job_id = ? ORDER BY collected_at, rowid
    `).all(job.id) as SnapshotRow[]).map(importedReviewInput);
    const inline = Array.isArray(job.input.reviews) ? job.input.reviews : [];
    const seen = new Set<string>();
    const reviews = [...imported, ...inline].filter((item, index) => {
      const record = isRecord(item) ? item : {};
      const sourceRecordId = text(record.sourceRecordId) || text(record.reviewId) || text(record.id) || `inline-${index}`;
      if (seen.has(sourceRecordId)) return false;
      seen.add(sourceRecordId);
      return true;
    });
    const values = { ...job.input, reviews };
    const sources = Object.fromEntries(Object.keys(values).map((field) => [field, source])) as Record<string, FieldSource>;
    return {
      values,
      sources,
      calculations: {},
      reviews,
    };
  }

  private getProductGrowth(productId: string, marketplace: string): SourcedGrowthPair | null {
    const product = this.database.prepare(`SELECT marketplace FROM products WHERE id = ?`)
      .get(productId) as { marketplace: string } | undefined;
    if (product?.marketplace !== marketplace) return null;
    const points = this.intelligence.getProductSnapshots(productId).map((row) => ({
      id: row.metricProvenance?.estimated_sales?.sourceRecordId ?? row.id,
      date: row.date, value: row.estimatedSales,
      source: row.metricProvenance?.estimated_sales
        ? this.productMetricSource(row, 'estimated_sales') : null,
    }));
    const pair = comparableSnapshotGrowth(points);
    const latestSource = points.find((point) => point.id === pair?.latest.id)?.source;
    const baselineSource = points.find((point) => point.id === pair?.baseline.id)?.source;
    return pair && latestSource && baselineSource
      && this.hasOneCompleteMcpRun([latestSource, baselineSource], marketplace)
      ? { ...pair, latestSource, baselineSource } : null;
  }

  private hasOneCompleteMcpRun(sources: Array<FieldSource | null>, marketplace: string): boolean {
    if (!sources.some((source) => source?.sourceType === 'mcp')) return true;
    const runs = sources.map((source) => source?.sourceType === 'mcp' && source.sourceRecordId
      ? this.completeMcpRunForRecord(source.sourceRecordId, marketplace) : null);
    return runs.length > 0 && runs[0] !== null && runs.every((run) => run === runs[0]);
  }

  private sharesCompleteMcpRun(sources: Array<FieldSource | null>, marketplace: string): boolean {
    const mcpSources = sources.filter((source): source is FieldSource => source?.sourceType === 'mcp');
    if (mcpSources.length === 0) return true;
    const runs = mcpSources.map((source) => source.sourceRecordId
      ? this.completeMcpRunForRecord(source.sourceRecordId, marketplace) : null);
    return runs[0] !== null && runs.every((run) => run === runs[0]);
  }

  private completeMcpRunForRecord(recordId: string, marketplace: string): string | null {
    const records = this.database.prepare(`
      SELECT id, entity_id AS entityId, sync_run_id AS directRunId, 'fact' AS kind
      FROM metric_facts WHERE id = ? AND marketplace = ? AND source_type = 'mcp'
      UNION ALL
      SELECT snapshot.id, snapshot.market_node_id, snapshot.sync_run_id, 'market'
      FROM market_snapshots snapshot
      JOIN market_nodes market ON market.id = snapshot.market_node_id
      WHERE snapshot.id = ? AND market.marketplace = ? AND snapshot.source_type = 'mcp'
      UNION ALL
      SELECT snapshot.id, snapshot.product_id, snapshot.sync_run_id, 'product'
      FROM product_snapshots snapshot
      JOIN products product ON product.id = snapshot.product_id
      WHERE snapshot.id = ? AND product.marketplace = ? AND snapshot.source_type = 'mcp'
    `).all(recordId, marketplace, recordId, marketplace, recordId, marketplace) as Array<{
      id: string; entityId: string; directRunId: string | null; kind: string;
    }>;
    if (records.length !== 1) return null;
    const record = records[0];
    const link = this.database.prepare(`
      SELECT link.sync_run_id AS runId
      FROM mcp_sync_observation_links link
      JOIN data_coverage_runs coverage ON coverage.id = link.sync_run_id
        AND coverage.marketplace = ? AND coverage.run_type = 'critical_sync'
        AND coverage.is_complete = 1
      JOIN data_tasks task ON task.id = link.sync_run_id
        AND task.sync_run_id = link.sync_run_id AND task.marketplace = coverage.marketplace
        AND task.source_id = 'source-sellersprite-mcp' AND task.task_type = 'critical_sync'
        AND task.status = 'success' AND task.success = task.total AND task.failed = 0
      WHERE link.snapshot_kind = ? AND link.snapshot_id = ? AND link.entity_id = ?
      ORDER BY coverage.created_at DESC, link.sync_run_id DESC LIMIT 1
    `).get(marketplace, record.kind, recordId, record.entityId) as { runId: string } | undefined;
    if (link) return link.runId;
    const direct = this.database.prepare(`
      SELECT task.id AS runId FROM data_tasks task
      JOIN data_coverage_runs coverage ON coverage.id = task.id
        AND coverage.marketplace = task.marketplace AND coverage.run_type = 'critical_sync'
        AND coverage.is_complete = 1
      WHERE task.id = ? AND task.sync_run_id = task.id AND task.marketplace = ?
        AND task.source_id = 'source-sellersprite-mcp' AND task.task_type = 'critical_sync'
        AND task.status = 'success' AND task.success = task.total AND task.failed = 0
    `).get(record.directRunId, marketplace) as { runId: string } | undefined;
    return direct?.runId ?? null;
  }

  private productMetricSource(snapshot: ProductSnapshot, metric: string): FieldSource {
    const provenance = snapshot.metricProvenance?.[metric];
    if (!provenance || provenance.period) return sourceFromProductMetric(snapshot, metric);
    const matching = this.database.prepare(`
      SELECT DISTINCT period FROM product_snapshots
      WHERE product_id = ? AND COALESCE(observation_date, date) = ?
        AND source = ? AND source_type = ? AND period IS NOT NULL
    `).all(snapshot.productId, snapshot.date, provenance.source, provenance.sourceType) as Array<{ period: string }>;
    return sourceFromProductMetric(snapshot, metric, matching.length === 1 ? matching[0].period : '');
  }

  private prepareResolvedData(
    job: ResearchJobDetail,
    supplied: Record<string, unknown>,
  ): { input: Record<string, unknown>; taskBook: Record<string, unknown>; flat: Record<string, unknown> } {
    const open = this.repository.getMissingData(job.id).filter((item) => item.status === 'open');
    const allowed = new Set(open.map((item) => item.fieldName));
    const unknown = Object.keys(supplied).filter((field) => !allowed.has(field));
    if (unknown.length > 0) throw new Error(`补数包含未开放字段：${unknown.join(', ')}`);
    if (open.length > 0 && Object.keys(supplied).length === 0) throw new Error('请至少补充一个开放的缺失字段。');

    const input: Record<string, unknown> = {};
    const taskBook: Record<string, unknown> = {};
    const flat: Record<string, unknown> = {};
    for (const [path, raw] of Object.entries(supplied)) {
      const target = isTaskBookPath(path) ? taskBook : input;
      const value = coerceResolvedValue(path, raw);
      flat[path] = value;
      setPath(target, path.replace(/^taskBook\./, ''), value);
    }
    return { input, taskBook, flat };
  }

  private recordFailure(jobId: string, error: unknown): void {
    const message = error instanceof Error ? error.message : 'Research Job 执行失败。';
    const running = this.repository.getResearchSteps(jobId).find((step) => step.status === 'running');
    if (running) this.repository.finishStep(jobId, running.stepType, 'failed', {}, message);
    this.repository.failJobDataTasks(jobId, message);
    const current = this.repository.getResearchJob(jobId);
    if (current && !['failed', 'approved', 'watch', 'rejected', 'monitoring'].includes(current.status)) {
      this.repository.transition(jobId, 'failed', message);
    }
  }

  private requireJob(id: string): ResearchJobDetail {
    const job = this.repository.getResearchJob(id);
    if (!job) throw new Error('Research Job 不存在或不属于当前站点。');
    return job;
  }
}

const TASK_BOOK_FIELDS = new Set([
  'marketplace', 'category_scope', 'product_idea', 'price_range', 'total_budget',
  'per_product_budget', 'min_profit_rate', 'max_weight', 'max_dimension',
  'allowed_materials', 'supply_chain_capability', 'prohibited_product_types',
  'compliance_tolerance', 'seasonality_tolerance', 'target_customer', 'buyer_need', 'notes',
]);

const NUMERIC_FIELDS = new Set([
  'estimated_contribution_profit_rate', 'moq_cost', 'weight', 'monthly_sales',
  'growth_30d', 'top10_sales_share', 'median_reviews', 'supply_chain_fit_score',
  'risk_control_score', 'total_budget', 'per_product_budget', 'min_profit_rate',
  'max_weight', 'dimensions.length', 'dimensions.width', 'dimensions.height',
  'max_dimension.length', 'max_dimension.width', 'max_dimension.height',
  'price_range.min', 'price_range.max',
]);

const LIST_FIELDS = new Set([
  'allowed_materials', 'supply_chain_capability', 'prohibited_product_types',
]);

interface FieldSource {
  source: string;
  sourceType: WorkflowEvidence['sourceType'];
  sourceRecordId?: string;
  collectedAt: string;
  period: string;
  isEstimated: boolean;
  confidence: number;
  originalUnit: string;
  normalizedUnit: string;
}

interface SourcedGrowthPair extends SnapshotGrowthPair {
  latestSource: FieldSource;
  baselineSource: FieldSource;
}

interface CollectedWorkflowData {
  values: Record<string, unknown>;
  sources: Record<string, FieldSource>;
  calculations: Record<string, string>;
  reviews: unknown[];
}

interface ReviewGapAnalysisResult {
  insights: ReviewInsight[];
  missingData: Array<{
    fieldName: string;
    reason: string;
    requiredForDecision: false;
    manualValidationRequired: true;
  }>;
}

interface ValidatedReviewGapSupport {
  supplier: {
    solvable: boolean;
    source: string;
    sourceRecordId: string;
    collectedAt: string;
  };
  cost: {
    impact: string;
    source: string;
    sourceRecordId: string;
    collectedAt: string;
  };
}

type SnapshotRow = Record<string, string | number | bigint | null>;

interface MarketPriceBand {
  label: string;
  productCount: number;
  monthlySales: number;
  revenue: number;
  avgReviews: number;
  newProducts: number;
  growth: number;
}

interface MarketConcentration {
  tier: string;
  share: number;
  avgPrice: number;
  avgSales: number;
}

type ReviewIssue =
  | 'too_firm'
  | 'too_soft'
  | 'odor'
  | 'neck_pressure'
  | 'height_discomfort'
  | 'center_depression'
  | 'cover'
  | 'size'
  | 'temperature'
  | 'cleaning'
  | 'packaging'
  | 'expectation_gap'
  | 'other';

const REVIEW_PATTERNS: Array<[ReviewIssue, RegExp]> = [
  ['too_firm', /too\s+(firm|hard)|very\s+firm|太硬|偏硬/i],
  ['too_soft', /too\s+soft|not\s+firm\s+enough|太软|偏软/i],
  ['odor', /odor|odour|smell|chemical|off[- ]?gass|气味|异味|味道/i],
  ['neck_pressure', /neck.{0,24}(press|pain|narrow|hurt)|press.{0,24}neck|颈部|脖子/i],
  ['height_discomfort', /too\s+(high|low)|height|loft|高度|高低不合适/i],
  ['center_depression', /center.{0,20}(sink|dip|depress)|middle.{0,20}(sink|dip)|中央凹陷|中间塌/i],
  ['cover', /cover|zipper|pillowcase|枕套|拉链/i],
  ['size', /too\s+(small|large)|size|narrow|尺寸|太小|太大/i],
  ['temperature', /hot|warm|cooling|temperature|闷热|温度|散热/i],
  ['cleaning', /clean|wash|stain|清洗|清洁|污渍/i],
  ['packaging', /package|packaging|compress|shipping|包装|压缩/i],
  ['expectation_gap', /not\s+as|different\s+from|expected|description|预期|描述不符/i],
];

const REVIEW_COST_IMPACTS = new Set([
  'low', 'low_to_medium', 'medium', 'medium_to_high', 'high',
]);

function collectionSteps(job: ResearchJobDetail): ResearchStepType[] {
  return isProductResearch(job)
    ? ['collect_market', 'collect_products', 'collect_keywords', 'collect_reviews']
    : ['collect_market', 'collect_products', 'collect_keywords'];
}

function stepLabel(step: ResearchStepType): string {
  const labels: Partial<Record<ResearchStepType, string>> = {
    collect_market: '市场数据采集',
    collect_products: '产品数据采集',
    collect_keywords: '关键词数据采集',
    collect_reviews: '评论数据采集',
  };
  return labels[step] ?? step;
}

function isProductResearch(job: ResearchJobDetail): boolean {
  return job.type === 'adjacent_product' || job.type === 'new_opportunity';
}

function requiredEntityId(job: ResearchJobDetail): string {
  if (!job.entityId) throw new Error(`${job.type} Research Job 缺少关联实体 ID。`);
  return job.entityId;
}

function requiredFields(profile: RuleProfile): string[] {
  const required = profile.hardGates.required;
  return Array.isArray(required)
    ? required.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : [];
}

function findTaskBookMissing(taskBook: Record<string, unknown>): ProductRuleResult['missing'] {
  const requiredRoots = [
    'marketplace', 'category_scope', 'product_idea', 'price_range', 'total_budget',
    'per_product_budget', 'min_profit_rate', 'max_weight', 'max_dimension',
    'allowed_materials', 'supply_chain_capability', 'prohibited_product_types',
    'compliance_tolerance', 'seasonality_tolerance', 'target_customer', 'buyer_need', 'notes',
  ];
  const missing: ProductRuleResult['missing'] = [];
  for (const fieldName of requiredRoots) {
    const value = taskBook[fieldName];
    const absent = isMissingValue(value)
      || (Array.isArray(value) && value.length === 0)
      || (isRecord(value) && Object.keys(value).length === 0);
    if (absent) {
      missing.push({
        fieldName,
        reason: `Research Task Book 缺少必填字段 ${fieldName}。`,
        manualValidationRequired: ['supply_chain_capability', 'compliance_tolerance'].includes(fieldName),
      });
    }
  }
  return missing;
}

function mergeMissing(
  ...groups: Array<ProductRuleResult['missing']>
): ProductRuleResult['missing'] {
  const byField = new Map<string, ProductRuleResult['missing'][number]>();
  groups.flat().forEach((item) => {
    const previous = byField.get(item.fieldName);
    byField.set(item.fieldName, previous
      ? { ...previous, manualValidationRequired: previous.manualValidationRequired || item.manualValidationRequired }
      : item);
  });
  return [...byField.values()];
}

function requiredCollectedNumber(collected: CollectedWorkflowData, field: string): number {
  const value = collected.values[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`确定性计算缺少有限数字 ${field}。`);
  }
  return value;
}

function classifyRelativePerformance(delta: number, profile: RuleProfile): PerformanceLevel {
  if (delta >= thresholdNumber(profile, 'strongOutperformMin', 10)) return 'strong_outperform';
  if (delta >= thresholdNumber(profile, 'outperformMin', 3)) return 'outperform';
  if (delta <= thresholdNumber(profile, 'strongUnderperformMax', -10)) return 'strong_underperform';
  if (delta <= thresholdNumber(profile, 'underperformMax', -3)) return 'underperform';
  return 'in_line';
}

function thresholdNumber(profile: RuleProfile, field: string, fallback: number): number {
  const value = profile.thresholds[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function ownedPerformanceTitle(performance: PerformanceLevel): string {
  const titles: Record<PerformanceLevel, string> = {
    insufficient_data: 'SKU 数据不足，无法判断相对表现',
    strong_outperform: 'SKU 明显跑赢所属市场',
    outperform: 'SKU 跑赢所属市场',
    in_line: 'SKU 与所属市场基本同步',
    underperform: 'SKU 跑输所属市场',
    strong_underperform: 'SKU 明显跑输所属市场',
  };
  return titles[performance];
}

function minimumConfidence(evidence: WorkflowEvidence[]): number {
  if (evidence.length === 0) return 0;
  return round3(Math.min(...evidence.map((item) => item.confidence)));
}

function sourceFromSnapshot(row: SnapshotRow): FieldSource {
  const sourceType = text(row.source_type, 'import');
  return {
    source: text(row.source, 'Imported snapshot'),
    sourceType: ['mock', 'import', 'mcp', 'amazon', 'manual'].includes(sourceType)
      ? sourceType as FieldSource['sourceType']
      : 'import',
    sourceRecordId: text(row.id) || undefined,
    collectedAt: text(row.collected_at),
    period: text(row.period, 'point_in_time'),
    isEstimated: numericValue(row.is_estimated) === 1,
    confidence: numericValue(row.confidence),
    originalUnit: 'as_recorded',
    normalizedUnit: 'as_recorded',
  };
}

function sourceFromMetricFact(fact: MetricFact, snapshotPeriod = ''): FieldSource {
  return {
    source: fact.source,
    sourceType: fact.sourceType as FieldSource['sourceType'],
    sourceRecordId: fact.id,
    collectedAt: fact.collectedAt,
    period: fact.period || snapshotPeriod,
    isEstimated: fact.isEstimated,
    confidence: fact.confidence,
    originalUnit: 'as_recorded',
    normalizedUnit: 'as_recorded',
  };
}

function sourceFromMetricProvenance(provenance: MetricProvenance): FieldSource {
  return {
    ...provenance,
    originalUnit: 'as_recorded',
    normalizedUnit: 'as_recorded',
  };
}

function sourceFromProductMetric(
  snapshot: ProductSnapshot, metric: string, fallbackPeriod = snapshot.provenance.period,
): FieldSource {
  const provenance = snapshot.metricProvenance?.[metric];
  if (provenance) return {
    ...sourceFromMetricProvenance(provenance),
    period: provenance.period || fallbackPeriod,
  };
  return {
    ...snapshot.provenance,
    sourceRecordId: snapshot.id,
    originalUnit: 'as_recorded',
    normalizedUnit: 'as_recorded',
  };
}

function comparableSources(left: FieldSource | null, right: FieldSource | null): boolean {
  if (!left || !right || left.sourceType !== right.sourceType) return false;
  if (left.period && right.period && left.period !== right.period
    && !(monthlyReportWindow(left.period) && monthlyReportWindow(right.period))) return false;
  if (left.sourceType === 'amazon') {
    return /\bapi\b/i.test(left.source) === /\bapi\b/i.test(right.source);
  }
  return true;
}

function monthlyReportWindow(period: string): boolean {
  const range = /^(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})$/.exec(period);
  if (!range) return false;
  const start = Date.parse(`${range[1]}T00:00:00Z`);
  const end = Date.parse(`${range[2]}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)
    || new Date(start).toISOString().slice(0, 10) !== range[1]
    || new Date(end).toISOString().slice(0, 10) !== range[2]) return false;
  const inclusiveDays = (end - start) / 86_400_000 + 1;
  return inclusiveDays >= 28 && inclusiveDays <= 31;
}

function comparableSnapshotGrowth(
  points: Array<{ id: string; date: string; value: number | null; source: FieldSource | null }>,
): SnapshotGrowthPair | null {
  const latest = [...points].sort((left, right) => right.date.localeCompare(left.date))[0];
  if (!latest || !latest.source) return null;
  return deriveSnapshotGrowth(points.map((point) => ({
    id: point.id, date: point.date,
    value: comparableSources(latest.source, point.source) ? point.value : null,
  })));
}

function sameGrowthMonths(left: SnapshotGrowthPair, right: SnapshotGrowthPair): boolean {
  return left.latest.date.slice(0, 7) === right.latest.date.slice(0, 7)
    && left.baseline.date.slice(0, 7) === right.baseline.date.slice(0, 7);
}

function unknownSource(job: ResearchJobDetail, source = 'Missing source record'): FieldSource {
  return {
    source,
    sourceType: job.isDemo ? 'mock' : 'manual',
    sourceRecordId: `${job.id}:input`,
    collectedAt: new Date().toISOString(),
    period: 'point_in_time',
    isEstimated: false,
    confidence: job.isDemo ? 0.9 : 0.75,
    originalUnit: 'unitless',
    normalizedUnit: 'unitless',
  };
}

function growthCalculation(label: string, pair: SnapshotGrowthPair): string {
  return `${label}: (latest ${pair.latest.id} ${pair.latest.value} / baseline ${pair.baseline.id} ${pair.baseline.value} - 1) * 100 over ${pair.elapsedDays} days = ${pair.growth}%`;
}

function percentageChange(current: number, baseline: number): number | null {
  return baseline === 0 ? null : round1(((current / baseline) - 1) * 100);
}

function percentageChangeCalculation(
  label: string,
  currentId: string,
  current: number,
  baselineId: string,
  baseline: number,
  elapsedDays: number,
  result: unknown,
): string {
  if (typeof result !== 'number') {
    return `${label}: current ${currentId} ${current}; baseline ${baselineId} ${baseline}; percentage change is undefined because the baseline is zero, so the result remains null.`;
  }
  return `${label}: (current ${currentId} ${current} / baseline ${baselineId} ${baseline} - 1) * 100 over ${elapsedDays} days = ${result}%`;
}

function absoluteChangeCalculation(
  label: string,
  currentId: string,
  current: number,
  baselineId: string,
  baseline: number,
  elapsedDays: number,
  result: unknown,
  unit: string,
): string {
  return `${label}: current ${currentId} ${current} - baseline ${baselineId} ${baseline} over ${elapsedDays} days = ${String(result)} ${unit}`;
}

function marketPriceBands(value: unknown): MarketPriceBand[] {
  return jsonRecords(value).flatMap((record) => {
    const label = record.label;
    const productCount = strictNumber(record.productCount, 0);
    const monthlySales = strictNumber(record.monthlySales, 0);
    const revenue = strictNumber(record.revenue, 0);
    const avgReviews = strictNumber(record.avgReviews, 0);
    const newProducts = strictNumber(record.newProducts, 0);
    const growth = strictNumber(record.growth);
    return typeof label === 'string' && label.trim()
      && productCount !== null && monthlySales !== null && revenue !== null
      && avgReviews !== null && newProducts !== null && growth !== null
      ? [{
          label: label.trim(), productCount, monthlySales, revenue,
          avgReviews, newProducts, growth,
        }]
      : [];
  });
}

function marketConcentration(value: unknown): MarketConcentration[] {
  return jsonRecords(value).flatMap((record) => {
    const tier = record.tier;
    const share = strictNumber(record.share, 0, 100);
    const avgPrice = strictNumber(record.avgPrice, 0);
    const avgSales = strictNumber(record.avgSales, 0);
    return typeof tier === 'string' && tier.trim()
      && share !== null && avgPrice !== null && avgSales !== null
      ? [{ tier: tier.trim(), share, avgPrice, avgSales }]
      : [];
  });
}

function jsonRecords(value: unknown): Array<Record<string, unknown>> {
  if (typeof value !== 'string' || value.trim() === '') return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter(isRecord)
      : [];
  } catch {
    return [];
  }
}

function strictNumber(
  value: unknown,
  minimum = Number.NEGATIVE_INFINITY,
  maximum = Number.POSITIVE_INFINITY,
): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
    ? value
    : null;
}

function comparePriceBands(
  current: MarketPriceBand[],
  baseline: MarketPriceBand[],
  pair: SnapshotGrowthPair,
): Record<string, unknown> {
  const baselineByLabel = new Map(baseline.map((band) => [band.label, band]));
  const currentLabels = new Set(current.map((band) => band.label));
  return {
    currentSnapshotId: pair.latest.id,
    baselineSnapshotId: pair.baseline.id,
    elapsedDays: pair.elapsedDays,
    current,
    baseline,
    matchedChanges: current.flatMap((band) => {
      const prior = baselineByLabel.get(band.label);
      return prior ? [{
        label: band.label,
        productCountPct: percentageChange(band.productCount, prior.productCount),
        monthlySalesPct: percentageChange(band.monthlySales, prior.monthlySales),
        revenuePct: percentageChange(band.revenue, prior.revenue),
        avgReviewsPct: percentageChange(band.avgReviews, prior.avgReviews),
        newProductsPct: percentageChange(band.newProducts, prior.newProducts),
        growthPp: round3(band.growth - prior.growth),
      }] : [];
    }),
    currentOnlyLabels: current.filter((band) => !baselineByLabel.has(band.label)).map((band) => band.label),
    baselineOnlyLabels: baseline.filter((band) => !currentLabels.has(band.label)).map((band) => band.label),
  };
}

function compareConcentration(
  current: MarketConcentration[],
  baseline: MarketConcentration[],
  pair: SnapshotGrowthPair,
): Record<string, unknown> {
  const baselineByTier = new Map(baseline.map((item) => [item.tier, item]));
  const currentTiers = new Set(current.map((item) => item.tier));
  return {
    currentSnapshotId: pair.latest.id,
    baselineSnapshotId: pair.baseline.id,
    elapsedDays: pair.elapsedDays,
    current,
    baseline,
    matchedChanges: current.flatMap((item) => {
      const prior = baselineByTier.get(item.tier);
      return prior ? [{
        tier: item.tier,
        sharePp: round3(item.share - prior.share),
        avgPricePct: percentageChange(item.avgPrice, prior.avgPrice),
        avgSalesPct: percentageChange(item.avgSales, prior.avgSales),
      }] : [];
    }),
    currentOnlyTiers: current.filter((item) => !baselineByTier.has(item.tier)).map((item) => item.tier),
    baselineOnlyTiers: baseline.filter((item) => !currentTiers.has(item.tier)).map((item) => item.tier),
  };
}

function existingMarketChangeCount(values: Record<string, unknown>): number {
  return ['market_growth_30d', ...EXISTING_MARKET_CHANGE_EVIDENCE_FIELDS]
    .filter((field) => !isMissingValue(values[field])).length;
}

function existingMarketChangeFacts(values: Record<string, unknown>): string[] {
  const facts: string[] = [];
  const demandChanges = compactMetricChanges(values, [
    ['monthly_revenue_change_30d_pct', '月销售额', '%'],
    ['product_count_change_30d_pct', '产品数', '%'],
    ['seller_count_change_30d_pct', '卖家数', '%'],
    ['brand_count_change_30d_pct', '品牌数', '%'],
  ]);
  const priceChanges = compactMetricChanges(values, [
    ['avg_price_change_30d_pct', '均价', '%'],
    ['median_price_change_30d_pct', '中位价', '%'],
    ['median_reviews_change_30d_pct', '评论中位数', '%'],
  ]);
  const structureChanges = compactMetricChanges(values, [
    ['avg_rating_change_30d', '平均评分', ''],
    ['top10_sales_share_change_30d_pp', 'TOP10 占比', 'pp'],
    ['top20_sales_share_change_30d_pp', 'TOP20 占比', 'pp'],
    ['new_product_share_change_30d_pp', '新品占比', 'pp'],
  ]);
  if (demandChanges.length > 0) facts.push(`同基线需求变化：${demandChanges.join('，')}。`);
  if (priceChanges.length > 0) facts.push(`同基线价格与评论变化：${priceChanges.join('，')}。`);
  if (structureChanges.length > 0) facts.push(`同基线结构差值：${structureChanges.join('，')}。`);
  if (isRecord(values.price_bands_change_30d)) facts.push('价格带 current/baseline 已按相同标签生成结构化变化。');
  if (isRecord(values.concentration_change_30d)) facts.push('集中度 current/baseline 已按相同层级生成结构化变化。');
  return facts;
}

function compactMetricChanges(
  values: Record<string, unknown>,
  metrics: ReadonlyArray<readonly [string, string, string]>,
): string[] {
  return metrics.flatMap(([field, label, unit]) => {
    const value = values[field];
    return typeof value === 'number' && Number.isFinite(value)
      ? [`${label} ${value >= 0 ? '+' : ''}${value}${unit}`]
      : [];
  });
}

function existingMarketHistoryGaps(
  values: Record<string, unknown>,
): Array<readonly [string, string]> {
  const gaps: Array<readonly [string, string]> = [];
  if (values.price_band_history_available !== true) {
    gaps.push(['price_band_history', '当前与同基线 Snapshot 未同时提供有效 PriceBands，无法证明价格带迁移。']);
  }
  if (values.top100_history_available !== true) {
    gaps.push(['top100_history', '不足 100 个头部商品拥有同口径可比较历史，无法证明 TOP100 结构变化。']);
  }
  if (values.submarket_history_available !== true) {
    gaps.push(['submarket_history', '缺少全部直属子市场的可比较历史 Snapshot，无法证明子市场分化。']);
  }
  return gaps;
}

function emptyCollected(): CollectedWorkflowData {
  return { values: {}, sources: {}, calculations: {}, reviews: [] };
}

function importedReviewInput(row: SnapshotRow): Record<string, unknown> {
  let normalized: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(text(row.normalized_json, '{}')) as unknown;
    if (isRecord(parsed)) normalized = parsed;
  } catch {
    normalized = {};
  }
  return {
    id: text(row.id),
    reviewId: text(row.source_record_id) || text(row.id),
    sourceRecordId: text(row.source_record_id) || text(row.id),
    productId: text(normalized.productId) || text(row.product_id) || 'unknown-product',
    text: text(row.review_text),
    source: text(row.source, 'Imported review'),
    rating: row.rating === null ? null : numericValue(row.rating),
    date: row.review_date === null ? null : text(row.review_date),
    collectedAt: text(row.collected_at),
  };
}

function classifyReviewIssues(value: string): ReviewIssue[] {
  const matches = REVIEW_PATTERNS
    .filter(([, pattern]) => pattern.test(value))
    .map(([issue]) => issue);
  return matches.length > 0 ? unique(matches) : ['other'];
}

function validatedReviewGapSupport(
  input: Record<string, unknown>,
  issue: ReviewIssue,
): ValidatedReviewGapSupport | null {
  if (!isRecord(input.review_gap_support)) return null;
  const issueSupport = input.review_gap_support[issue];
  if (!isRecord(issueSupport) || !isRecord(issueSupport.supplier) || !isRecord(issueSupport.cost)) {
    return null;
  }
  const supplier = issueSupport.supplier;
  const cost = issueSupport.cost;
  const supplierSource = nonEmptyText(supplier.source);
  const supplierSourceRecordId = nonEmptyText(supplier.source_record_id);
  const costSource = nonEmptyText(cost.source);
  const costSourceRecordId = nonEmptyText(cost.source_record_id);
  const costImpact = nonEmptyText(cost.impact);
  if (
    supplier.verified !== true
    || typeof supplier.solvable !== 'boolean'
    || !supplierSource
    || !supplierSourceRecordId
    || cost.verified !== true
    || !costImpact
    || !REVIEW_COST_IMPACTS.has(costImpact)
    || !costSource
    || !costSourceRecordId
  ) {
    return null;
  }
  return {
    supplier: {
      solvable: supplier.solvable,
      source: supplierSource,
      sourceRecordId: supplierSourceRecordId,
      collectedAt: evidenceCollectedAt(supplier.collected_at),
    },
    cost: {
      impact: costImpact,
      source: costSource,
      sourceRecordId: costSourceRecordId,
      collectedAt: evidenceCollectedAt(cost.collected_at),
    },
  };
}

function reviewOpportunityLevel(
  totalReviewCount: number,
  competitorsAffected: number,
  frequency: number,
  support: ValidatedReviewGapSupport | null,
): ReviewInsight['opportunityLevel'] {
  if (!support || totalReviewCount < 3) return 'insufficient_evidence';
  if (!support.supplier.solvable) return 'low';
  const repeatedAcrossProducts = competitorsAffected >= 2 && frequency >= 0.2;
  if (!repeatedAcrossProducts) return 'low';
  return ['low', 'low_to_medium'].includes(support.cost.impact) ? 'high' : 'medium';
}

function evidenceCollectedAt(value: unknown): string {
  if (typeof value === 'string' && value.trim() && Number.isFinite(Date.parse(value))) {
    return value.trim();
  }
  return new Date().toISOString();
}

function nonEmptyText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function reviewSourceType(source: string): WorkflowEvidence['sourceType'] {
  if (/^Amazon Report Import:/i.test(source)) return 'amazon';
  if (/^SellerSprite Import:/i.test(source)) return 'import';
  return 'manual';
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function isMissingValue(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === 'string' && value.trim().length === 0);
}

function text(value: unknown, fallback = ''): string {
  return value === null || value === undefined ? fallback : String(value);
}

function numericValue(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatPercent(value: number): string {
  return `${value >= 0 ? '+' : ''}${round1(value)}%`;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function round3(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function isTaskBookPath(path: string): boolean {
  const normalized = path.replace(/^taskBook\./, '');
  return TASK_BOOK_FIELDS.has(normalized.split('.')[0]);
}

function coerceResolvedValue(path: string, value: unknown): unknown {
  const normalized = path.replace(/^taskBook\./, '');
  if (NUMERIC_FIELDS.has(normalized)) {
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(parsed)) throw new Error(`${path} 必须是有效数字。`);
    return parsed;
  }
  if (['certification_required', 'certification_available', 'supply_chain_validation'].includes(normalized)) {
    if (value === true || value === false) return value;
    if (value === 'true' || value === 'false') return value === 'true';
    throw new Error(`${path} 必须是 true 或 false。`);
  }
  if (LIST_FIELDS.has(normalized)) {
    if (Array.isArray(value) && value.every((item) => typeof item === 'string' && item.trim().length > 0)) {
      return value.map((item) => item.trim());
    }
    if (typeof value === 'string') {
      const parsed = value.split(/[,，]/).map((item) => item.trim()).filter(Boolean);
      if (parsed.length > 0) return parsed;
    }
    throw new Error(`${path} 必须包含至少一个非空文本项。`);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) throw new Error(`${path} 不能为空。`);
    if ((normalized === 'dimensions' || normalized === 'max_dimension' || normalized === 'price_range') && trimmed.startsWith('{')) {
      return JSON.parse(trimmed) as unknown;
    }
    return trimmed;
  }
  return value;
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let current = target;
  parts.forEach((part, index) => {
    if (index === parts.length - 1) {
      current[part] = value;
      return;
    }
    const next = current[part];
    if (typeof next !== 'object' || next === null || Array.isArray(next)) current[part] = {};
    current = current[part] as Record<string, unknown>;
  });
}

function deepMerge(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const existing = result[key];
    result[key] = isRecord(existing) && isRecord(value) ? deepMerge(existing, value) : value;
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
