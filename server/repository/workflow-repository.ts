import { createHash, randomUUID } from 'node:crypto';
import type {
  ApprovalRecord,
  DataTask,
  DecisionRecord,
  DecisionType,
  Insight,
  MissingDataItem,
  ResearchJobDetail,
  ResearchJobStatus,
  ResearchJobSummary,
  ResearchJobType,
  ReviewInsight,
  ResearchStep,
  ResearchStepStatus,
  ResearchStepType,
  ReverseReview,
  RuleExecution,
  RuleProfile,
  ScoreResult,
  WorkflowEvidence,
} from '../../shared/types.js';
import type { AppDatabase } from '../database/database.js';
import { assertResearchJobTransition } from '../domain/research-job-state-machine.js';
import { hashAnalysisInput } from '../services/ai-service.js';
import { IntelligenceRepository } from './intelligence-repository.js';

type DbRow = Record<string, unknown>;

interface WorkflowVersionSnapshot {
  dataVersion: string;
  ruleProfileId: string;
  ruleProfileVersion: number;
  promptVersion: string;
}

export interface CreateResearchJobInput {
  name: string;
  type: ResearchJobType;
  entityType?: string;
  entityId?: string;
  ruleProfileId?: string;
  input?: Record<string, unknown>;
  taskBook?: Record<string, unknown>;
  createdBy: string;
}

export interface WorkflowInsightInput {
  status: string;
  title: string;
  summary: string;
  score?: number;
  facts: string[];
  opportunities: string[];
  risks: string[];
  recommendedActions: string[];
  evidenceIds: string[];
  confidence: number;
  insightType: string;
  possibleCauses?: string[];
  missingData?: string[];
  hardGate?: 'pass' | 'reject' | 'needs_data';
  decision?: 'develop' | 'test' | 'watch' | 'reject' | 'needs_data';
}

export class WorkflowRepository {
  constructor(
    readonly database: AppDatabase,
    private readonly intelligence = new IntelligenceRepository(database),
  ) {}

  getRuleProfiles(): RuleProfile[] {
    const rows = this.database.prepare(`
      SELECT * FROM rule_profiles ORDER BY active DESC, name, version DESC
    `).all() as DbRow[];
    return rows.map(mapRuleProfile);
  }

  getRuleProfile(id: string): RuleProfile | null {
    const row = this.database.prepare('SELECT * FROM rule_profiles WHERE id = ?').get(id) as DbRow | undefined;
    return row ? mapRuleProfile(row) : null;
  }

  getDefaultRuleProfile(type: ResearchJobType): RuleProfile {
    const profile = this.getRuleProfiles().find((item) => item.active && item.jobTypes.includes(type));
    if (!profile) throw new Error(`研究类型 ${type} 没有启用的 RuleProfile。`);
    return profile;
  }

  createRuleProfile(input: Omit<RuleProfile, 'createdAt'> & { createdAt?: string }): RuleProfile {
    const createdAt = input.createdAt ?? new Date().toISOString();
    this.database.prepare(`
      INSERT INTO rule_profiles (
        id, name, version, active, job_types_json, hard_gates_json,
        scoring_json, thresholds_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id, input.name, input.version, input.active ? 1 : 0,
      JSON.stringify(input.jobTypes), JSON.stringify(input.hardGates),
      JSON.stringify(input.scoring), JSON.stringify(input.thresholds), createdAt,
    );
    const created = this.getRuleProfile(input.id);
    if (!created) throw new Error('RuleProfile 创建失败。');
    return created;
  }

  createResearchJob(input: CreateResearchJobInput): ResearchJobDetail {
    const settings = this.intelligence.getSettings();
    assertTaskBookMarketplace(settings.marketplace, input.taskBook ?? {});
    const profile = input.ruleProfileId
      ? this.getRuleProfile(input.ruleProfileId)
      : this.getDefaultRuleProfile(input.type);
    if (!profile || !profile.active || !profile.jobTypes.includes(input.type)) {
      throw new Error('RuleProfile 不存在、未启用或不支持该研究类型。');
    }
    validateJobEntity(
      this.database, settings.marketplace, input.type, input.entityType, input.entityId,
    );
    const id = randomUUID();
    const now = new Date().toISOString();
    const promptVersion = promptVersionFor(input.type);
    const initialInput = input.input ?? {};
    const dataVersion = workflowDataVersion(initialInput, input.taskBook ?? {}, promptVersion);
    const isDemo = researchJobIsDemo(
      this.database, settings.mode, input.entityType, input.entityId,
    );
    if (settings.mode !== 'demo' && isDemo) {
      throw new Error('非 Demo 模式不能为 Mock 实体创建 Research Job。');
    }
    this.database.prepare(`
      INSERT INTO research_jobs (
        id, name, job_type, marketplace, status, entity_type, entity_id,
        rule_profile_id, rule_profile_version, rule_profile_snapshot_json,
        input_json, task_book_json, is_demo, created_by, data_version,
        prompt_version, created_at, updated_at, completed_at, error
      ) VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
    `).run(
      id, input.name, input.type, settings.marketplace,
      input.entityType ?? null, input.entityId ?? null,
      profile.id, profile.version, JSON.stringify(profile),
      JSON.stringify(initialInput), JSON.stringify(input.taskBook ?? {}),
      isDemo ? 1 : 0, input.createdBy, dataVersion,
      promptVersion, now, now,
    );
    this.ensureStep(id, 'plan');
    const created = this.getResearchJob(id);
    if (!created) throw new Error('Research Job 创建失败。');
    return created;
  }

  getResearchJobs(): ResearchJobSummary[] {
    const rows = this.database.prepare(`
      SELECT j.*, (
        SELECT COUNT(*) FROM missing_data_items m
        WHERE m.research_job_id = j.id AND m.status = 'open'
      ) AS missing_data_count
      FROM research_jobs j WHERE marketplace = ? ORDER BY updated_at DESC
    `).all(this.intelligence.getSettings().marketplace) as DbRow[];
    return rows.map(mapResearchJobSummary);
  }

  getCurrentResearchJobForEntity(entityType: string, entityId: string): ResearchJobDetail | null {
    const row = this.database.prepare(`
      SELECT id FROM research_jobs
      WHERE marketplace = ? AND entity_type = ? AND entity_id = ?
      ORDER BY updated_at DESC, created_at DESC, id DESC
      LIMIT 1
    `).get(
      this.intelligence.getSettings().marketplace, entityType, entityId,
    ) as DbRow | undefined;
    return row ? this.getResearchJob(stringValue(row.id)) : null;
  }

  hasWorkflowLineageForEntity(entityType: string, entityId: string): boolean {
    return Boolean(this.database.prepare(`
      SELECT 1
      FROM research_jobs job
      WHERE job.marketplace = ? AND job.entity_type = ? AND job.entity_id = ?
      UNION ALL
      SELECT 1
      FROM decisions decision
      JOIN research_jobs job ON job.id = decision.research_job_id
      WHERE job.marketplace = ? AND decision.entity_type = ? AND decision.entity_id = ?
      LIMIT 1
    `).get(
      this.intelligence.getSettings().marketplace, entityType, entityId,
      this.intelligence.getSettings().marketplace, entityType, entityId,
    ));
  }

  requireApprovedResearchJobForAdvancement(
    entityType: string,
    entityId: string,
    allowedActions: string[],
  ): ResearchJobDetail {
    const job = this.getCurrentResearchJobForEntity(entityType, entityId);
    const approval = job?.approval;
    const decision = job?.decision;
    const execution = job?.latestRuleExecution;
    const insight = job?.latestInsight;
    const review = job?.reverseReview;
    const lineageMatches = Boolean(
      job
      && approval
      && decision
      && execution
      && insight
      && review
      && job.status === 'approved'
      && approval.status === 'approved'
      && allowedActions.includes(approval.action)
      && approval.researchJobId === job.id
      && approval.dataVersion === job.dataVersion
      && approval.ruleProfileId === job.ruleProfileId
      && approval.ruleProfileVersion === job.ruleProfileVersion
      && approval.promptVersion === job.promptVersion
      && approval.reverseReviewId === review.id
      && decision.entityType === 'research_job'
      && decision.entityId === job.id
      && decision.decision === 'approved'
      && decision.researchJobId === job.id
      && decision.reverseReviewId === review.id
      && decision.approvalId === approval.id
      && decision.aiInsightId === insight.id
      && decision.dataVersion === job.dataVersion
      && execution.researchJobId === job.id
      && execution.dataVersion === job.dataVersion
      && execution.ruleProfileId === job.ruleProfileId
      && execution.ruleVersion === job.ruleProfileVersion
      && execution.hardGateStatus === 'pass'
      && insight.researchJobId === job.id
      && insight.dataVersion === job.dataVersion
      && insight.promptVersion === job.promptVersion
      && Boolean(insight.evidenceIds?.length)
      && review.researchJobId === job.id
      && review.dataVersion === job.dataVersion
      && review.ruleProfileId === job.ruleProfileId
      && review.ruleProfileVersion === job.ruleProfileVersion
      && review.promptVersion === job.promptVersion
      && ['proceed', 'proceed_with_caution'].includes(review.verdict)
    );
    if (!job || !lineageMatches) {
      throw new Error('最新 Research Job 没有可用于当前动作的完整批准血缘。');
    }
    this.assertEvidenceIds(job.id, insight?.evidenceIds ?? []);
    return job;
  }

  getResearchJob(id: string): ResearchJobDetail | null {
    const row = this.database.prepare(`
      SELECT j.*, (
        SELECT COUNT(*) FROM missing_data_items m
        WHERE m.research_job_id = j.id AND m.status = 'open'
      ) AS missing_data_count
      FROM research_jobs j WHERE j.id = ? AND j.marketplace = ?
    `).get(id, this.intelligence.getSettings().marketplace) as DbRow | undefined;
    if (!row) return null;
    const summary = mapResearchJobSummary(row);
    const insight = this.getLatestWorkflowInsight(id, summary.dataVersion);
    return {
      ...summary,
      input: jsonObject(row.input_json),
      taskBook: jsonObject(row.task_book_json),
      steps: this.getResearchSteps(id),
      latestRuleExecution: this.getLatestRuleExecution(id) ?? undefined,
      latestScoreResult: this.getLatestScoreResult(id) ?? undefined,
      latestInsight: insight ?? undefined,
      reverseReview: this.getLatestReverseReview(id) ?? undefined,
      approval: this.getLatestApproval(id) ?? undefined,
      decision: this.getLatestDecision(id) ?? undefined,
      reviewInsights: this.getReviewInsights(id),
    };
  }

  getLockedRuleProfile(job: ResearchJobDetail): RuleProfile {
    const row = this.database.prepare(`
      SELECT rule_profile_snapshot_json FROM research_jobs WHERE id = ?
    `).get(job.id) as DbRow | undefined;
    if (!row) throw new Error('Research Job 不存在。');
    try {
      const parsed = JSON.parse(stringValue(row.rule_profile_snapshot_json)) as unknown;
      if (!isRecord(parsed)) throw new Error('not an object');
      return parsed as unknown as RuleProfile;
    } catch {
      throw new Error('RuleProfile 快照无效。');
    }
  }

  transition(id: string, to: ResearchJobStatus, error: string | null = null): ResearchJobDetail {
    const current = this.getResearchJob(id);
    if (!current) throw new Error('Research Job 不存在或不属于当前站点。');
    assertResearchJobTransition(current.status, to);
    if (current.status === to) return current;
    const now = new Date().toISOString();
    const completedAt = ['approved', 'watch', 'rejected'].includes(to) ? now : null;
    this.database.prepare(`
      UPDATE research_jobs SET status = ?, updated_at = ?, completed_at = ?, error = ?
      WHERE id = ? AND marketplace = ?
    `).run(to, now, completedAt, error, id, current.marketplace);
    const updated = this.getResearchJob(id);
    if (!updated) throw new Error('Research Job 状态更新失败。');
    return updated;
  }

  updateResearchInput(id: string, patch: Record<string, unknown>): ResearchJobDetail {
    const current = this.getResearchJob(id);
    if (!current) throw new Error('Research Job 不存在或不属于当前站点。');
    const merged = { ...current.input, ...patch };
    const dataVersion = workflowDataVersion(merged, current.taskBook, current.promptVersion);
    this.database.prepare(`
      UPDATE research_jobs SET input_json = ?, data_version = ?, updated_at = ?, error = NULL WHERE id = ?
    `).run(JSON.stringify(merged), dataVersion, new Date().toISOString(), id);
    const updated = this.getResearchJob(id);
    if (!updated) throw new Error('Research Job 输入更新失败。');
    return updated;
  }

  updateResearchTaskBook(id: string, taskBook: Record<string, unknown>): ResearchJobDetail {
    const current = this.getResearchJob(id);
    if (!current) throw new Error('Research Job 不存在或不属于当前站点。');
    assertTaskBookMarketplace(current.marketplace, taskBook);
    const dataVersion = workflowDataVersion(current.input, taskBook, current.promptVersion);
    this.database.prepare(`
      UPDATE research_jobs SET task_book_json = ?, data_version = ?, updated_at = ?, error = NULL
      WHERE id = ?
    `).run(JSON.stringify(taskBook), dataVersion, new Date().toISOString(), id);
    return this.getResearchJob(id)!;
  }

  updateDataVersion(id: string, collectedInput: unknown): ResearchJobDetail {
    const current = this.getResearchJob(id);
    if (!current) throw new Error('Research Job 不存在或不属于当前站点。');
    const dataVersion = `workflow-${createHash('sha256').update(JSON.stringify({
      collectedInput, promptVersion: current.promptVersion,
      ruleProfileId: current.ruleProfileId, ruleProfileVersion: current.ruleProfileVersion,
    })).digest('hex').slice(0, 16)}`;
    this.database.prepare(`
      UPDATE research_jobs SET data_version = ?, updated_at = ? WHERE id = ?
    `).run(dataVersion, new Date().toISOString(), id);
    return this.getResearchJob(id)!;
  }

  getResearchSteps(jobId: string): ResearchStep[] {
    if (!this.scopedJobExists(jobId)) return [];
    const rows = this.database.prepare(`
      SELECT * FROM research_steps WHERE research_job_id = ? ORDER BY created_at, rowid
    `).all(jobId) as DbRow[];
    return rows.map(mapResearchStep);
  }

  ensureStep(jobId: string, stepType: ResearchStepType): ResearchStep {
    const existing = this.getStep(jobId, stepType);
    if (existing) return existing;
    const id = randomUUID();
    this.database.prepare(`
      INSERT INTO research_steps (
        id, research_job_id, step_type, status, input_json, output_json,
        started_at, completed_at, error, retry_count, created_at
      ) VALUES (?, ?, ?, 'pending', '{}', '{}', NULL, NULL, NULL, 0, ?)
    `).run(id, jobId, stepType, new Date().toISOString());
    const created = this.getStep(jobId, stepType);
    if (!created) throw new Error(`Research Step ${stepType} 创建失败。`);
    return created;
  }

  getStep(jobId: string, stepType: ResearchStepType): ResearchStep | null {
    const row = this.database.prepare(`
      SELECT * FROM research_steps WHERE research_job_id = ? AND step_type = ?
    `).get(jobId, stepType) as DbRow | undefined;
    return row ? mapResearchStep(row) : null;
  }

  startStep(jobId: string, stepType: ResearchStepType, input: Record<string, unknown>): ResearchStep {
    const step = this.ensureStep(jobId, stepType);
    if (step.status === 'completed') return step;
    const retry = ['failed', 'needs_data'].includes(step.status) ? 1 : 0;
    this.database.prepare(`
      UPDATE research_steps SET status = 'running', input_json = ?, output_json = '{}',
        started_at = ?, completed_at = NULL, error = NULL, retry_count = retry_count + ?
      WHERE id = ?
    `).run(JSON.stringify(input), new Date().toISOString(), retry, step.id);
    return this.getStep(jobId, stepType) ?? step;
  }

  finishStep(
    jobId: string,
    stepType: ResearchStepType,
    status: Extract<ResearchStepStatus, 'completed' | 'skipped' | 'failed' | 'needs_data'>,
    output: Record<string, unknown>,
    error: string | null = null,
  ): ResearchStep {
    const step = this.ensureStep(jobId, stepType);
    this.database.prepare(`
      UPDATE research_steps SET status = ?, output_json = ?, completed_at = ?, error = ? WHERE id = ?
    `).run(status, JSON.stringify(output), new Date().toISOString(), error, step.id);
    return this.getStep(jobId, stepType) ?? step;
  }

  resetRetryableSteps(jobId: string): void {
    this.database.prepare(`
      UPDATE research_steps SET status = 'pending', started_at = NULL, completed_at = NULL, error = NULL
      WHERE research_job_id = ? AND status IN ('needs_data', 'failed')
    `).run(jobId);
  }

  resetAnalysisStepsForRetry(jobId: string): void {
    const retryable = [
      'normalize', 'validate', 'calculate', 'hard_gate', 'score', 'review_gap',
      'ai_analysis', 'reverse_review', 'approval', 'snapshot', 'report',
    ];
    const placeholders = retryable.map(() => '?').join(',');
    this.database.prepare(`
      UPDATE research_steps SET status = 'needs_data', output_json = '{}',
        started_at = NULL, completed_at = NULL, error = NULL
      WHERE research_job_id = ? AND step_type IN (${placeholders})
    `).run(jobId, ...retryable);
  }

  createDataTask(job: ResearchJobDetail, taskType: string, target: string, name: string): DataTask {
    const existing = this.database.prepare(`
      SELECT id FROM data_tasks
      WHERE research_job_id = ? AND task_type = ? AND target = ?
      ORDER BY created_at DESC LIMIT 1
    `).get(job.id, taskType, target) as DbRow | undefined;
    if (existing) return this.intelligence.getDataTask(stringValue(existing.id))!;
    const id = randomUUID();
    const now = new Date().toISOString();
    const source = job.isDemo
      ? 'Persisted Demo Data (DEMO)'
      : 'Persisted Snapshot / Manual Input';
    this.database.prepare(`
      INSERT INTO data_tasks (
        id, name, source_id, task_type, target, source, marketplace, status,
        started_at, completed_at, total, success, failed, error_log, created_at,
        research_job_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, 0, 0, 0, NULL, ?, ?)
    `).run(id, name, null, taskType, target, source, job.marketplace, now, job.id);
    return this.intelligence.getDataTask(id)!;
  }

  startJobDataTasks(jobId: string): void {
    const now = new Date().toISOString();
    this.database.prepare(`
      UPDATE data_tasks SET status = 'running', started_at = ?, completed_at = NULL,
        total = 0, success = 0, failed = 0, error_log = NULL
      WHERE research_job_id = ? AND status IN ('pending', 'failed')
    `).run(now, jobId);
  }

  completeJobDataTasks(jobId: string): void {
    const now = new Date().toISOString();
    this.database.prepare(`
      UPDATE data_tasks SET status = 'success', started_at = COALESCE(started_at, ?),
        completed_at = ?, total = 1, success = 1, failed = 0, error_log = NULL
      WHERE research_job_id = ? AND status = 'running'
    `).run(now, now, jobId);
  }

  failJobDataTasks(jobId: string, error: string): void {
    const now = new Date().toISOString();
    this.database.prepare(`
      UPDATE data_tasks SET status = 'failed', started_at = COALESCE(started_at, ?),
        completed_at = ?, total = 1, success = 0, failed = 1, error_log = ?
      WHERE research_job_id = ? AND status IN ('pending', 'running', 'success')
    `).run(now, now, error, jobId);
  }

  saveNormalizedRecord(
    job: ResearchJobDetail,
    fields: Record<string, unknown>,
    recordType = 'research_input',
    sourceRecordId?: string,
  ): string {
    const existing = this.database.prepare(`
      SELECT id FROM normalized_records
      WHERE research_job_id = ? AND record_type = ? AND data_version = ? LIMIT 1
    `).get(job.id, recordType, job.dataVersion) as DbRow | undefined;
    if (existing) return stringValue(existing.id);
    const id = randomUUID();
    this.database.prepare(`
      INSERT INTO normalized_records (
        id, research_job_id, record_type, source_record_id, fields_json, data_version, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, job.id, recordType, sourceRecordId ?? null, JSON.stringify(fields),
      job.dataVersion, new Date().toISOString(),
    );
    return id;
  }

  upsertMissingData(jobId: string, items: Array<{
    fieldName: string;
    reason: string;
    manualValidationRequired: boolean;
    requiredForDecision?: boolean;
  }>): MissingDataItem[] {
    const now = new Date().toISOString();
    const statement = this.database.prepare(`
      INSERT INTO missing_data_items (
        id, research_job_id, field_name, label, missing_reason,
        required_for_decision, manual_validation_required, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)
      ON CONFLICT(research_job_id, field_name) DO UPDATE SET
        label = excluded.label, missing_reason = excluded.missing_reason,
        required_for_decision = excluded.required_for_decision,
        manual_validation_required = excluded.manual_validation_required,
        status = 'open', resolved_value_json = NULL, resolved_by = NULL, resolved_at = NULL
    `);
    for (const item of items) {
      statement.run(
        randomUUID(), jobId, item.fieldName, fieldLabel(item.fieldName), item.reason,
        item.requiredForDecision === false ? 0 : 1,
        item.manualValidationRequired ? 1 : 0, now,
      );
    }
    return this.getMissingData(jobId);
  }

  resolveMissingData(jobId: string, resolved: Record<string, unknown>, resolvedBy: string): void {
    const now = new Date().toISOString();
    const statement = this.database.prepare(`
      UPDATE missing_data_items SET status = 'resolved', resolved_value_json = ?,
        resolved_by = ?, resolved_at = ?
      WHERE research_job_id = ? AND field_name = ? AND status = 'open'
    `);
    for (const [field, value] of Object.entries(resolved)) {
      if (value !== null && value !== undefined && value !== '') {
        statement.run(JSON.stringify(value), resolvedBy, now, jobId, field);
      }
    }
  }

  getMissingData(jobId: string): MissingDataItem[] {
    if (!this.scopedJobExists(jobId)) return [];
    const rows = this.database.prepare(`
      SELECT * FROM missing_data_items WHERE research_job_id = ? ORDER BY created_at, field_name
    `).all(jobId) as DbRow[];
    return rows.map(mapMissingData);
  }

  createEvidence(jobId: string, input: Omit<WorkflowEvidence, 'id' | 'researchJobId'>): WorkflowEvidence {
    const job = this.database.prepare(`
      SELECT data_version, marketplace FROM research_jobs WHERE id = ? AND marketplace = ?
    `).get(jobId, this.intelligence.getSettings().marketplace) as DbRow | undefined;
    if (!job) throw new Error('Research Job 不存在或不属于当前站点。');
    if (input.dataVersion !== stringValue(job.data_version)) {
      throw new Error('Evidence 必须写入 Research Job 的当前数据版本。');
    }
    const syncRunId = this.sourceSyncRunId(
      input.sourceType, input.sourceRecordId, stringValue(job.marketplace),
    );
    if (input.syncRunId !== undefined && input.syncRunId !== syncRunId) {
      throw new Error('Evidence 同步批次必须匹配来源记录的实际同步批次。');
    }
    if (syncRunId) this.assertJobTaskRunCompatible(jobId, syncRunId);
    const existing = this.database.prepare(`
      SELECT * FROM evidence_records
      WHERE research_job_id = ? AND claim = ? AND metric_name = ?
        AND metric_value_json = ? AND source_record_id IS ? AND data_version = ?
      LIMIT 1
    `).get(
      jobId, input.claim, input.metricName, JSON.stringify(input.metricValue),
      input.sourceRecordId ?? null, input.dataVersion,
    ) as DbRow | undefined;
    if (existing && nullableString(existing.sync_run_id) === syncRunId) {
      if (syncRunId) this.bindJobTasksToRun(jobId, syncRunId);
      return mapEvidence(existing);
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO evidence_records (
        id, research_job_id, insight_id, claim, metric_name, metric_value_json,
        source, source_type, source_record_id, collected_at, period, is_estimated,
        calculation, confidence, data_version, created_at, sync_run_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, jobId, input.insightId ?? null, input.claim, input.metricName,
      JSON.stringify(input.metricValue), input.source, input.sourceType,
      input.sourceRecordId ?? null, input.collectedAt, input.period,
      input.isEstimated ? 1 : 0, input.calculation, input.confidence, input.dataVersion, now, syncRunId,
    );
    if (syncRunId) this.bindJobTasksToRun(jobId, syncRunId);
    return this.getEvidence(jobId).find((item) => item.id === id)!;
  }

  private assertJobTaskRunCompatible(jobId: string, syncRunId: string): void {
    const conflict = this.database.prepare(`
      SELECT 1 FROM data_tasks
      WHERE research_job_id = ? AND sync_run_id IS NOT NULL AND sync_run_id <> ?
      LIMIT 1
    `).get(jobId, syncRunId);
    if (conflict) throw new Error('同一 Research Job 的 DataTask 和 Evidence 必须关联同一个 sync run。');
  }

  private bindJobTasksToRun(jobId: string, syncRunId: string): void {
    this.database.prepare(`
      UPDATE data_tasks SET sync_run_id = ?
      WHERE research_job_id = ? AND sync_run_id IS NULL
    `).run(syncRunId, jobId);
  }

  private sourceSyncRunId(
    sourceType: WorkflowEvidence['sourceType'], sourceRecordId: string | undefined, marketplace: string,
  ): string | null {
    if (sourceType !== 'mcp') return null;
    if (!sourceRecordId) throw new Error('Evidence MCP 来源必须指定可追溯记录。');
    const rows = this.database.prepare(`
      SELECT source_type, sync_run_id, marketplace, entity_id, 'fact' AS record_kind
      FROM metric_facts WHERE id = ?
      UNION ALL
      SELECT snapshot.source_type, snapshot.sync_run_id, market.marketplace,
        snapshot.market_node_id AS entity_id,
        'market' AS record_kind
      FROM market_snapshots snapshot
      JOIN market_nodes market ON market.id = snapshot.market_node_id
      WHERE snapshot.id = ?
      UNION ALL
      SELECT snapshot.source_type, snapshot.sync_run_id, product.marketplace,
        snapshot.product_id AS entity_id,
        'product' AS record_kind
      FROM product_snapshots snapshot
      JOIN products product ON product.id = snapshot.product_id
      WHERE snapshot.id = ?
    `).all(sourceRecordId, sourceRecordId, sourceRecordId) as DbRow[];
    if (rows.length > 1) throw new Error('Evidence 来源记录 ID 在事实与快照中不唯一。');
    const source = rows[0];
    if (!source) throw new Error('Evidence MCP 来源记录不存在。');
    if (stringValue(source.source_type) !== 'mcp' || stringValue(source.marketplace) !== marketplace) {
      throw new Error('Evidence MCP 来源记录的类型或站点不匹配。');
    }
    const verifiedReuse = this.database.prepare(`
      SELECT link.sync_run_id AS syncRunId
      FROM mcp_sync_observation_links link
      JOIN data_coverage_runs coverage ON coverage.id = link.sync_run_id
        AND coverage.marketplace = ? AND coverage.run_type = 'critical_sync'
        AND coverage.is_complete = 1
      JOIN data_tasks task ON task.id = link.sync_run_id
        AND task.sync_run_id = link.sync_run_id AND task.marketplace = coverage.marketplace
        AND task.source_id = 'source-sellersprite-mcp'
        AND task.task_type = 'critical_sync' AND task.status = 'success'
        AND task.success = task.total AND task.failed = 0
      WHERE link.snapshot_kind = ? AND link.snapshot_id = ?
        AND link.entity_id = ?
      ORDER BY coverage.created_at DESC, link.sync_run_id DESC
      LIMIT 1
    `).get(marketplace, stringValue(source.record_kind), sourceRecordId,
      stringValue(source.entity_id)) as DbRow | undefined;
    if (verifiedReuse) return stringValue(verifiedReuse.syncRunId);
    const directRunId = nullableString(source.sync_run_id);
    if (!directRunId) {
      throw new Error('Evidence MCP 来源记录尚未关联成功完成的同步运行。');
    }
    const validDirectRun = this.database.prepare(`
      SELECT 1 FROM data_tasks task
      WHERE task.id = ? AND task.sync_run_id = task.id
        AND task.marketplace = ? AND task.source_id = 'source-sellersprite-mcp'
        AND task.status = 'success' AND task.failed = 0 AND task.success = task.total
        AND (task.task_type <> 'critical_sync' OR EXISTS (
          SELECT 1 FROM data_coverage_runs coverage
          WHERE coverage.id = task.id AND coverage.marketplace = task.marketplace
            AND coverage.run_type = 'critical_sync' AND coverage.is_complete = 1
        ))
      LIMIT 1
    `).get(directRunId, marketplace);
    if (!validDirectRun) {
      throw new Error('Evidence MCP 来源记录尚未由成功完成的同步运行验证。');
    }
    return directRunId;
  }

  getEvidence(jobId: string): WorkflowEvidence[] {
    if (!this.scopedJobExists(jobId)) return [];
    const rows = this.database.prepare(`
      SELECT evidence.* FROM evidence_records evidence
      JOIN research_jobs job ON job.id = evidence.research_job_id
      WHERE evidence.research_job_id = ? AND evidence.data_version = job.data_version
      ORDER BY evidence.created_at, evidence.rowid
    `).all(jobId) as DbRow[];
    return rows.map(mapEvidence);
  }

  assertEvidenceIds(jobId: string, evidenceIds: string[]): void {
    if (evidenceIds.length === 0) return;
    const job = this.database.prepare(`
      SELECT data_version FROM research_jobs WHERE id = ? AND marketplace = ?
    `).get(jobId, this.intelligence.getSettings().marketplace) as DbRow | undefined;
    if (!job) throw new Error('Research Job 不存在或不属于当前站点。');
    const dataVersion = stringValue(job.data_version);
    const placeholders = evidenceIds.map(() => '?').join(',');
    const rows = this.database.prepare(`
      SELECT id FROM evidence_records
      WHERE research_job_id = ? AND data_version = ? AND id IN (${placeholders})
    `).all(jobId, dataVersion, ...evidenceIds) as DbRow[];
    const found = new Set(rows.map((row) => stringValue(row.id)));
    const missing = evidenceIds.filter((id) => !found.has(id));
    if (missing.length > 0) {
      throw new Error(`结论引用了不存在、跨任务或跨数据版本的 Evidence：${missing.join(', ')}`);
    }
  }

  saveWorkflowInsight(job: ResearchJobDetail, input: WorkflowInsightInput): Insight {
    this.assertEvidenceIds(job.id, input.evidenceIds);
    const cacheInput = {
      jobId: job.id, dataVersion: job.dataVersion, promptVersion: job.promptVersion,
      ruleProfileId: job.ruleProfileId, ruleProfileVersion: job.ruleProfileVersion, input,
    };
    const inputHash = hashAnalysisInput(cacheInput);
    const cached = this.intelligence.getInsightByCacheKey('research_job', job.id, input.insightType, inputHash);
    if (cached && cached.dataVersion === job.dataVersion) return cached;
    const id = randomUUID();
    const generatedAt = new Date().toISOString();
    const workflowEvidence = this.getEvidence(job.id).filter((item) => input.evidenceIds.includes(item.id));
    const legacyEvidence = workflowEvidence.map((item) => ({
      id: item.id,
      claim: item.claim,
      metrics: [{ name: item.metricName, label: item.metricName, value: scalarEvidenceValue(item.metricValue) }],
      provenance: [{
        source: item.source,
        sourceType: item.sourceType,
        collectedAt: item.collectedAt,
        period: item.period,
        isEstimated: item.isEstimated,
        confidence: item.confidence,
      }],
    }));
    this.database.prepare(`
      INSERT INTO ai_insights (
        id, entity_type, entity_id, insight_type, status, title, summary, score,
        facts_json, opportunities_json, risks_json, recommendations_json, evidence_json,
        confidence, model, data_version, input_hash, generated_at,
        research_job_id, prompt_version, evidence_ids_json, missing_data_json,
        possible_causes_json, hard_gate, decision_recommendation
      ) VALUES (?, 'research_job', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        'rule-engine-v1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, job.id, input.insightType, input.status, input.title, input.summary,
      input.score ?? null, JSON.stringify(input.facts), JSON.stringify(input.opportunities),
      JSON.stringify(input.risks), JSON.stringify(input.recommendedActions),
      JSON.stringify(legacyEvidence), input.confidence, job.dataVersion, inputHash,
      generatedAt, job.id, job.promptVersion, JSON.stringify(input.evidenceIds),
      JSON.stringify(input.missingData ?? []), JSON.stringify(input.possibleCauses ?? []),
      input.hardGate ?? null, input.decision ?? null,
    );
    if (input.evidenceIds.length > 0) {
      this.database.prepare(`
        UPDATE evidence_records SET insight_id = COALESCE(insight_id, ?)
        WHERE research_job_id = ? AND id IN (${input.evidenceIds.map(() => '?').join(',')})
      `).run(id, job.id, ...input.evidenceIds);
    }
    const saved = this.getLatestWorkflowInsight(job.id, job.dataVersion);
    if (!saved) throw new Error('工作流 Insight 保存失败。');
    return saved;
  }

  getLatestWorkflowInsight(jobId: string, dataVersion?: string): Insight | null {
    if (!this.scopedJobExists(jobId)) return null;
    const expectedVersion = dataVersion ?? stringValue((this.database.prepare(`
      SELECT data_version FROM research_jobs WHERE id = ?
    `).get(jobId) as DbRow | undefined)?.data_version);
    return this.intelligence.getInsights('research_job', jobId)
      .find((insight) => insight.dataVersion === expectedVersion) ?? null;
  }

  saveReviews(job: ResearchJobDetail, input: unknown[]): Array<{
    id: string;
    productId: string;
    text: string;
    source: string;
    sourceRecordId: string;
    collectedAt: string;
  }> {
    const saved: Array<{
      id: string;
      productId: string;
      text: string;
      source: string;
      sourceRecordId: string;
      collectedAt: string;
    }> = [];
    input.forEach((item, index) => {
      if (!isRecord(item)) throw new Error(`评论 ${index + 1} 格式无效。`);
      const productId = requiredText(item.productId, `评论 ${index + 1} productId`);
      const text = requiredText(item.text, `评论 ${index + 1} text`);
      const source = typeof item.source === 'string' && item.source ? item.source : job.isDemo ? 'Mock Review (DEMO)' : 'Manual Review Input';
      const sourceRecordId = typeof item.sourceRecordId === 'string' && item.sourceRecordId
        ? item.sourceRecordId
        : typeof item.reviewId === 'string' && item.reviewId ? item.reviewId
        : typeof item.id === 'string' && item.id ? item.id : `${job.id}-review-${index + 1}`;
      const existing = this.database.prepare(`
        SELECT id, collected_at FROM reviews
        WHERE research_job_id = ? AND source_record_id = ? LIMIT 1
      `).get(job.id, sourceRecordId) as DbRow | undefined;
      const id = existing ? stringValue(existing.id) : randomUUID();
      const collectedAt = existing
        ? stringValue(existing.collected_at)
        : typeof item.collectedAt === 'string' && item.collectedAt
          ? item.collectedAt
          : new Date().toISOString();
      if (!existing) {
        const localProduct = this.database.prepare(`
          SELECT id FROM products WHERE id = ? AND marketplace = ?
        `).get(productId, job.marketplace);
        this.database.prepare(`
          INSERT INTO reviews (
            id, research_job_id, product_id, external_review_id, review_text, rating,
            review_date, source, source_record_id, collected_at, normalized_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id, job.id, localProduct ? productId : null, sourceRecordId, text,
          numericOrNull(item.rating), typeof item.date === 'string' ? item.date : null,
          source, sourceRecordId, collectedAt, JSON.stringify({ productId }),
        );
      }
      saved.push({ id, productId, text, source, sourceRecordId, collectedAt });
    });
    return saved;
  }

  saveReviewInsight(
    jobId: string,
    input: Omit<ReviewInsight, 'id' | 'researchJobId' | 'dataVersion' | 'createdAt'>,
  ): ReviewInsight {
    this.assertEvidenceIds(jobId, input.evidenceIds);
    const job = this.database.prepare('SELECT data_version FROM research_jobs WHERE id = ?')
      .get(jobId) as DbRow | undefined;
    if (!job) throw new Error('Research Job 不存在。');
    const dataVersion = stringValue(job.data_version);
    const existing = this.database.prepare(`
      SELECT * FROM review_insights
      WHERE research_job_id = ? AND issue = ? AND data_version = ? LIMIT 1
    `).get(jobId, input.issue, dataVersion) as DbRow | undefined;
    if (existing) return mapReviewInsight(existing);
    const id = randomUUID();
    this.database.prepare(`
      INSERT INTO review_insights (
        id, research_job_id, issue, frequency, competitors_affected,
        is_cross_market_issue, supply_chain_solvable, cost_impact,
        opportunity_level, evidence_ids_json, data_version, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, jobId, input.issue, input.frequency, input.competitorsAffected,
      input.isCrossMarketIssue ? 1 : 0,
      input.supplyChainSolvable === null ? null : input.supplyChainSolvable ? 1 : 0,
      input.costImpact, input.opportunityLevel, JSON.stringify(input.evidenceIds), dataVersion,
      new Date().toISOString(),
    );
    return this.getReviewInsights(jobId).find((item) => item.id === id)!;
  }

  getReviewInsights(jobId: string): ReviewInsight[] {
    if (!this.scopedJobExists(jobId)) return [];
    const rows = this.database.prepare(`
      SELECT insight.* FROM review_insights insight
      JOIN research_jobs job ON job.id = insight.research_job_id
      WHERE insight.research_job_id = ? AND insight.data_version = job.data_version
      ORDER BY insight.frequency DESC, insight.issue
    `).all(jobId) as DbRow[];
    return rows.map(mapReviewInsight);
  }

  saveRuleExecution(
    job: ResearchJobDetail,
    input: Record<string, unknown>,
    output: Record<string, unknown>,
    hardGateStatus: RuleExecution['hardGateStatus'],
    score: number | null,
  ): RuleExecution {
    const existing = this.database.prepare(`
      SELECT * FROM rule_executions
      WHERE research_job_id = ? AND data_version = ? AND input_json = ? AND output_json = ? LIMIT 1
    `).get(job.id, job.dataVersion, JSON.stringify(input), JSON.stringify(output)) as DbRow | undefined;
    if (existing) return mapRuleExecution(existing);
    const id = randomUUID();
    this.database.prepare(`
      INSERT INTO rule_executions (
        id, research_job_id, rule_profile_id, rule_version, input_json,
        output_json, hard_gate_status, score, data_version, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, job.id, job.ruleProfileId, job.ruleProfileVersion, JSON.stringify(input),
      JSON.stringify(output), hardGateStatus, score, job.dataVersion, new Date().toISOString(),
    );
    return this.getLatestRuleExecution(job.id)!;
  }

  saveScoreResult(
    jobId: string,
    executionId: string,
    total: number,
    breakdown: ScoreResult['breakdown'],
    calculation: Record<string, unknown>,
  ): ScoreResult {
    const existing = this.database.prepare(`
      SELECT * FROM score_results WHERE research_job_id = ? AND rule_execution_id = ? LIMIT 1
    `).get(jobId, executionId) as DbRow | undefined;
    if (existing) return mapScoreResult(existing);
    const id = randomUUID();
    this.database.prepare(`
      INSERT INTO score_results (
        id, research_job_id, rule_execution_id, total, breakdown_json, calculation_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, jobId, executionId, total, JSON.stringify(breakdown), JSON.stringify(calculation), new Date().toISOString());
    return this.getLatestScoreResult(jobId)!;
  }

  getLatestRuleExecution(jobId: string): RuleExecution | null {
    const row = this.database.prepare(`
      SELECT execution.* FROM rule_executions execution
      JOIN research_jobs job ON job.id = execution.research_job_id
      WHERE execution.research_job_id = ? AND execution.data_version = job.data_version
      ORDER BY execution.created_at DESC, execution.rowid DESC LIMIT 1
    `).get(jobId) as DbRow | undefined;
    return row ? mapRuleExecution(row) : null;
  }

  getLatestScoreResult(jobId: string): ScoreResult | null {
    const row = this.database.prepare(`
      SELECT score.* FROM score_results score
      JOIN rule_executions execution ON execution.id = score.rule_execution_id
      JOIN research_jobs job ON job.id = score.research_job_id
      WHERE score.research_job_id = ? AND execution.data_version = job.data_version
      ORDER BY score.created_at DESC, score.rowid DESC LIMIT 1
    `).get(jobId) as DbRow | undefined;
    return row ? mapScoreResult(row) : null;
  }

  saveReverseReview(
    jobId: string,
    input: Omit<
      ReverseReview,
      | 'id'
      | 'researchJobId'
      | 'dataVersion'
      | 'ruleProfileId'
      | 'ruleProfileVersion'
      | 'promptVersion'
      | 'createdAt'
    >,
  ): ReverseReview {
    const version = this.getCurrentVersionSnapshot(jobId);
    if (!version) throw new Error('Research Job 不存在或不属于当前站点。');
    for (const mode of input.topFailureModes) this.assertEvidenceIds(jobId, mode.evidenceIds);
    const id = randomUUID();
    this.database.prepare(`
      INSERT INTO reverse_reviews (
        id, research_job_id, data_version, rule_profile_id, rule_profile_version,
        prompt_version, verdict, top_failure_modes_json, unknowns_json,
        recommendation, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, jobId, version.dataVersion, version.ruleProfileId, version.ruleProfileVersion,
      version.promptVersion, input.verdict, JSON.stringify(input.topFailureModes),
      JSON.stringify(input.unknowns), input.recommendation, new Date().toISOString(),
    );
    return this.getLatestReverseReview(jobId)!;
  }

  getLatestReverseReview(jobId: string): ReverseReview | null {
    const row = this.database.prepare(`
      SELECT review.* FROM reverse_reviews review
      JOIN research_jobs job ON job.id = review.research_job_id
      WHERE review.research_job_id = ? AND job.marketplace = ?
        AND review.data_version = job.data_version
        AND review.rule_profile_id = job.rule_profile_id
        AND review.rule_profile_version = job.rule_profile_version
        AND review.prompt_version = job.prompt_version
      ORDER BY review.created_at DESC, review.rowid DESC LIMIT 1
    `).get(jobId, this.intelligence.getSettings().marketplace) as DbRow | undefined;
    return row ? mapReverseReview(row) : null;
  }

  createPendingApproval(job: ResearchJobDetail, action: string): ApprovalRecord {
    const version = this.getCurrentVersionSnapshot(job.id);
    if (!version) throw new Error('Research Job 不存在或不属于当前站点。');
    assertMatchingWorkflowVersion(version, job, 'Research Job');
    const review = this.getLatestReverseReview(job.id);
    if (!review) throw new Error('当前工作流版本没有可批准的 Reverse Review。');
    assertMatchingWorkflowVersion(version, review, 'Reverse Review');
    const existing = this.getLatestApproval(job.id);
    if (existing?.status === 'pending') {
      assertMatchingWorkflowVersion(version, existing, 'Approval');
      if (existing.reverseReviewId !== review.id) {
        throw new Error('待处理 Approval 关联的 Reverse Review 已过期。');
      }
      return existing;
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO approvals (
        id, research_job_id, data_version, rule_profile_id, rule_profile_version,
        prompt_version, reverse_review_id, action, status, requested_by, requested_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(
      id, job.id, version.dataVersion, version.ruleProfileId, version.ruleProfileVersion,
      version.promptVersion, review.id, action, job.createdBy, now,
    );
    return this.getLatestApproval(job.id)!;
  }

  decideApproval(
    jobId: string,
    status: Exclude<ApprovalRecord['status'], 'pending'>,
    reason: string,
    decidedBy: string,
  ): ApprovalRecord {
    const version = this.getCurrentVersionSnapshot(jobId);
    if (!version) throw new Error('Research Job 不存在或不属于当前站点。');
    const review = this.getLatestReverseReview(jobId);
    if (!review) throw new Error('当前工作流版本没有可批准的 Reverse Review。');
    const approval = this.getLatestApproval(jobId);
    if (!approval || approval.status !== 'pending') throw new Error('没有待处理的 Approval。');
    assertMatchingWorkflowVersion(version, review, 'Reverse Review');
    assertMatchingWorkflowVersion(version, approval, 'Approval');
    if (approval.reverseReviewId !== review.id) {
      throw new Error('待处理 Approval 关联的 Reverse Review 已过期。');
    }
    const result = this.database.prepare(`
      UPDATE approvals SET status = ?, decided_by = ?, reason = ?, decided_at = ?
      WHERE id = ? AND status = 'pending' AND data_version = ?
        AND rule_profile_id = ? AND rule_profile_version = ?
        AND prompt_version = ? AND reverse_review_id = ?
    `).run(
      status, decidedBy, reason, new Date().toISOString(), approval.id,
      version.dataVersion, version.ruleProfileId, version.ruleProfileVersion,
      version.promptVersion, review.id,
    );
    if (Number(result.changes) !== 1) throw new Error('Approval 已变化，请刷新后重试。');
    const decided = this.getLatestApproval(jobId);
    if (!decided) throw new Error('Approval 决策写入失败。');
    return decided;
  }

  getLatestApproval(jobId: string): ApprovalRecord | null {
    const row = this.database.prepare(`
      SELECT approval.* FROM approvals approval
      JOIN research_jobs job ON job.id = approval.research_job_id
      JOIN reverse_reviews review ON review.id = approval.reverse_review_id
      WHERE approval.research_job_id = ? AND job.marketplace = ?
        AND approval.data_version = job.data_version
        AND approval.rule_profile_id = job.rule_profile_id
        AND approval.rule_profile_version = job.rule_profile_version
        AND approval.prompt_version = job.prompt_version
        AND review.research_job_id = job.id
        AND review.data_version = job.data_version
        AND review.rule_profile_id = job.rule_profile_id
        AND review.rule_profile_version = job.rule_profile_version
        AND review.prompt_version = job.prompt_version
      ORDER BY approval.requested_at DESC, approval.rowid DESC LIMIT 1
    `).get(jobId, this.intelligence.getSettings().marketplace) as DbRow | undefined;
    return row ? mapApproval(row) : null;
  }

  saveDecision(
    job: ResearchJobDetail,
    decision: DecisionRecord['decision'],
    reason: string,
    decidedBy: string,
    approval: ApprovalRecord,
  ): DecisionRecord {
    const existing = this.database.prepare(`
      SELECT * FROM decisions
      WHERE research_job_id = ? AND approval_id = ?
        AND entity_type = 'research_job' AND entity_id = ?
      LIMIT 1
    `).get(job.id, approval.id, job.id) as DbRow | undefined;
    if (existing) return mapDecision(existing);
    const insight = job.latestInsight?.dataVersion === job.dataVersion
      ? job.latestInsight
      : this.getLatestWorkflowInsight(job.id, job.dataVersion);
    if (!insight) throw new Error('当前 Research Job 没有可引用的 AI Insight。');
    const review = this.getLatestReverseReview(job.id);
    const id = randomUUID();
    this.database.prepare(`
      INSERT INTO decisions (
        id, entity_type, entity_id, decision, reason, ai_insight_id, data_version,
        decided_by, decided_at, research_job_id, reverse_review_id, approval_id
      ) VALUES (?, 'research_job', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, job.id, decision, reason, insight.id, job.dataVersion, decidedBy,
      new Date().toISOString(), job.id, review?.id ?? null, approval.id,
    );
    return this.getLatestDecision(job.id)!;
  }

  saveAdvancementDecision(
    approvedJob: ResearchJobDetail,
    targetEntityType: 'development_project',
    targetEntityId: string,
    action: DecisionType,
    reason: string,
    decidedBy: string,
  ): DecisionRecord {
    const sourceEntityType = approvedJob.entityType;
    const sourceEntityId = approvedJob.entityId;
    if (!sourceEntityType || !sourceEntityId) {
      throw new Error('Research Job 没有关联可推进的业务对象。');
    }
    const current = this.requireApprovedResearchJobForAdvancement(
      sourceEntityType, sourceEntityId, [action],
    );
    if (current.id !== approvedJob.id) {
      throw new Error('批准来源已不是该对象的最新 Research Job。');
    }
    const approval = current.approval!;
    const review = current.reverseReview!;
    const insight = current.latestInsight!;
    const target = this.database.prepare(`
      SELECT marketplace, source_opportunity_id FROM development_projects WHERE id = ?
    `).get(targetEntityId) as DbRow | undefined;
    const isDirectProjectDecision = sourceEntityType === 'development_project'
      && sourceEntityId === targetEntityId;
    const isOpportunityPromotion = sourceEntityType === 'opportunity'
      && stringValue(target?.source_opportunity_id) === sourceEntityId;
    if (
      !target
      || stringValue(target.marketplace) !== current.marketplace
      || (!isDirectProjectDecision && !isOpportunityPromotion)
    ) {
      throw new Error('推进目标与批准的 Research Job 不匹配。');
    }
    const existing = this.database.prepare(`
      SELECT * FROM decisions
      WHERE entity_type = ? AND entity_id = ? AND decision = ?
        AND research_job_id = ? AND approval_id = ?
      ORDER BY decided_at DESC, rowid DESC LIMIT 1
    `).get(
      targetEntityType, targetEntityId, action, current.id, approval.id,
    ) as DbRow | undefined;
    if (existing) return mapDecision(existing);

    const id = randomUUID();
    this.database.prepare(`
      INSERT INTO decisions (
        id, entity_type, entity_id, decision, reason, ai_insight_id, data_version,
        decided_by, decided_at, research_job_id, reverse_review_id, approval_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, targetEntityType, targetEntityId, action, reason, insight.id,
      current.dataVersion, decidedBy, new Date().toISOString(), current.id,
      review.id, approval.id,
    );
    const saved = this.database.prepare('SELECT * FROM decisions WHERE id = ?').get(id) as DbRow | undefined;
    if (!saved) throw new Error('推进决策保存失败。');
    return mapDecision(saved);
  }

  getLatestDecision(jobId: string): DecisionRecord | null {
    const row = this.database.prepare(`
      SELECT decision.* FROM decisions decision
      JOIN research_jobs job ON job.id = decision.research_job_id
      JOIN ai_insights insight ON insight.id = decision.ai_insight_id
      JOIN approvals approval ON approval.id = decision.approval_id
      JOIN reverse_reviews review ON review.id = decision.reverse_review_id
      WHERE decision.research_job_id = ? AND job.marketplace = ?
        AND decision.entity_type = 'research_job' AND decision.entity_id = job.id
        AND decision.data_version = job.data_version
        AND insight.research_job_id = job.id
        AND insight.data_version = job.data_version
        AND insight.prompt_version = job.prompt_version
        AND approval.research_job_id = job.id
        AND approval.data_version = job.data_version
        AND approval.rule_profile_id = job.rule_profile_id
        AND approval.rule_profile_version = job.rule_profile_version
        AND approval.prompt_version = job.prompt_version
        AND approval.reverse_review_id = review.id
        AND review.research_job_id = job.id
        AND review.data_version = job.data_version
        AND review.rule_profile_id = job.rule_profile_id
        AND review.rule_profile_version = job.rule_profile_version
        AND review.prompt_version = job.prompt_version
      ORDER BY decision.decided_at DESC, decision.rowid DESC LIMIT 1
    `).get(jobId, this.intelligence.getSettings().marketplace) as DbRow | undefined;
    return row ? mapDecision(row) : null;
  }

  private scopedJobExists(jobId: string): boolean {
    return Boolean(this.database.prepare(`
      SELECT 1 FROM research_jobs WHERE id = ? AND marketplace = ?
    `).get(jobId, this.intelligence.getSettings().marketplace));
  }

  private getCurrentVersionSnapshot(jobId: string): WorkflowVersionSnapshot | null {
    const row = this.database.prepare(`
      SELECT data_version, rule_profile_id, rule_profile_version, prompt_version
      FROM research_jobs WHERE id = ? AND marketplace = ?
    `).get(jobId, this.intelligence.getSettings().marketplace) as DbRow | undefined;
    return row ? {
      dataVersion: stringValue(row.data_version),
      ruleProfileId: stringValue(row.rule_profile_id),
      ruleProfileVersion: numberValue(row.rule_profile_version),
      promptVersion: stringValue(row.prompt_version),
    } : null;
  }
}

function assertMatchingWorkflowVersion(
  current: WorkflowVersionSnapshot,
  artifact: WorkflowVersionSnapshot,
  artifactName: string,
): void {
  if (
    artifact.dataVersion !== current.dataVersion
    || artifact.ruleProfileId !== current.ruleProfileId
    || artifact.ruleProfileVersion !== current.ruleProfileVersion
    || artifact.promptVersion !== current.promptVersion
  ) {
    throw new Error(`${artifactName} 与当前工作流版本不一致。`);
  }
}

function mapResearchJobSummary(row: DbRow): ResearchJobSummary {
  return {
    id: stringValue(row.id), name: stringValue(row.name),
    type: stringValue(row.job_type) as ResearchJobType,
    marketplace: stringValue(row.marketplace),
    status: stringValue(row.status) as ResearchJobStatus,
    entityType: nullableString(row.entity_type), entityId: nullableString(row.entity_id),
    ruleProfileId: stringValue(row.rule_profile_id),
    ruleProfileVersion: numberValue(row.rule_profile_version),
    isDemo: numberValue(row.is_demo) === 1, createdBy: stringValue(row.created_by),
    dataVersion: stringValue(row.data_version), promptVersion: stringValue(row.prompt_version),
    missingDataCount: numberValue(row.missing_data_count),
    createdAt: stringValue(row.created_at), updatedAt: stringValue(row.updated_at),
    completedAt: nullableString(row.completed_at) ?? null, error: nullableString(row.error) ?? null,
  };
}

function mapResearchStep(row: DbRow): ResearchStep {
  return {
    id: stringValue(row.id), researchJobId: stringValue(row.research_job_id),
    stepType: stringValue(row.step_type) as ResearchStepType,
    status: stringValue(row.status) as ResearchStepStatus,
    input: jsonObject(row.input_json), output: jsonObject(row.output_json),
    startedAt: nullableString(row.started_at) ?? null,
    completedAt: nullableString(row.completed_at) ?? null,
    error: nullableString(row.error) ?? null, retryCount: numberValue(row.retry_count),
  };
}

function mapRuleProfile(row: DbRow): RuleProfile {
  return {
    id: stringValue(row.id), name: stringValue(row.name), version: numberValue(row.version),
    active: numberValue(row.active) === 1,
    jobTypes: jsonValue(row.job_types_json, []), hardGates: jsonObject(row.hard_gates_json),
    scoring: jsonObject(row.scoring_json), thresholds: jsonObject(row.thresholds_json),
    createdAt: stringValue(row.created_at),
  };
}

function mapMissingData(row: DbRow): MissingDataItem {
  const resolved = row.resolved_value_json === null || row.resolved_value_json === undefined
    ? undefined
    : jsonValue(row.resolved_value_json, null);
  return {
    id: stringValue(row.id), researchJobId: stringValue(row.research_job_id),
    fieldName: stringValue(row.field_name), label: stringValue(row.label),
    missingReason: stringValue(row.missing_reason),
    requiredForDecision: numberValue(row.required_for_decision) === 1,
    manualValidationRequired: numberValue(row.manual_validation_required) === 1,
    status: stringValue(row.status) as MissingDataItem['status'],
    resolvedValue: resolved, resolvedBy: nullableString(row.resolved_by),
    resolvedAt: nullableString(row.resolved_at), createdAt: stringValue(row.created_at),
  };
}

function mapEvidence(row: DbRow): WorkflowEvidence {
  return {
    id: stringValue(row.id), researchJobId: stringValue(row.research_job_id),
    insightId: nullableString(row.insight_id), claim: stringValue(row.claim),
    metricName: stringValue(row.metric_name), metricValue: jsonValue(row.metric_value_json, null),
    source: stringValue(row.source),
    sourceType: stringValue(row.source_type, 'manual') as WorkflowEvidence['sourceType'],
    sourceRecordId: nullableString(row.source_record_id),
    syncRunId: nullableString(row.sync_run_id) ?? null,
    collectedAt: stringValue(row.collected_at), period: stringValue(row.period, 'point_in_time'),
    isEstimated: numberValue(row.is_estimated) === 1,
    calculation: stringValue(row.calculation), confidence: numberValue(row.confidence),
    dataVersion: stringValue(row.data_version, 'legacy-v1'),
  };
}

function mapRuleExecution(row: DbRow): RuleExecution {
  return {
    id: stringValue(row.id), researchJobId: stringValue(row.research_job_id),
    ruleProfileId: stringValue(row.rule_profile_id), ruleVersion: numberValue(row.rule_version),
    input: jsonObject(row.input_json), output: jsonObject(row.output_json),
    hardGateStatus: stringValue(row.hard_gate_status) as RuleExecution['hardGateStatus'],
    score: row.score === null || row.score === undefined ? null : numberValue(row.score),
    dataVersion: stringValue(row.data_version, 'legacy-v1'),
    createdAt: stringValue(row.created_at),
  };
}

function mapScoreResult(row: DbRow): ScoreResult {
  return {
    id: stringValue(row.id), researchJobId: stringValue(row.research_job_id),
    ruleExecutionId: stringValue(row.rule_execution_id), total: numberValue(row.total),
    breakdown: jsonValue(row.breakdown_json, {
      demandQuality: 0, competitiveEntry: 0, profitAndCashEfficiency: 0,
      supplyChainFit: 0, riskControl: 0,
    }),
    calculation: jsonObject(row.calculation_json), createdAt: stringValue(row.created_at),
  };
}

function mapReverseReview(row: DbRow): ReverseReview {
  return {
    id: stringValue(row.id), researchJobId: stringValue(row.research_job_id),
    dataVersion: stringValue(row.data_version), ruleProfileId: stringValue(row.rule_profile_id),
    ruleProfileVersion: numberValue(row.rule_profile_version),
    promptVersion: stringValue(row.prompt_version),
    verdict: stringValue(row.verdict) as ReverseReview['verdict'],
    topFailureModes: jsonValue(row.top_failure_modes_json, []),
    unknowns: jsonValue(row.unknowns_json, []), recommendation: stringValue(row.recommendation),
    createdAt: stringValue(row.created_at),
  };
}

function mapApproval(row: DbRow): ApprovalRecord {
  return {
    id: stringValue(row.id), researchJobId: stringValue(row.research_job_id),
    dataVersion: stringValue(row.data_version), ruleProfileId: stringValue(row.rule_profile_id),
    ruleProfileVersion: numberValue(row.rule_profile_version),
    promptVersion: stringValue(row.prompt_version),
    reverseReviewId: stringValue(row.reverse_review_id),
    action: stringValue(row.action), status: stringValue(row.status) as ApprovalRecord['status'],
    requestedBy: stringValue(row.requested_by), requestedAt: stringValue(row.requested_at),
    decidedBy: nullableString(row.decided_by), reason: nullableString(row.reason),
    decidedAt: nullableString(row.decided_at),
  };
}

function mapReviewInsight(row: DbRow): ReviewInsight {
  return {
    id: stringValue(row.id), researchJobId: stringValue(row.research_job_id),
    issue: stringValue(row.issue), frequency: numberValue(row.frequency),
    competitorsAffected: numberValue(row.competitors_affected),
    isCrossMarketIssue: numberValue(row.is_cross_market_issue) === 1,
    supplyChainSolvable: row.supply_chain_solvable === null || row.supply_chain_solvable === undefined
      ? null
      : numberValue(row.supply_chain_solvable) === 1,
    costImpact: nullableString(row.cost_impact) ?? null,
    opportunityLevel: stringValue(row.opportunity_level) as ReviewInsight['opportunityLevel'],
    evidenceIds: jsonValue(row.evidence_ids_json, []),
    dataVersion: stringValue(row.data_version, 'legacy-v1'),
    createdAt: stringValue(row.created_at),
  };
}

function mapDecision(row: DbRow): DecisionRecord {
  return {
    id: stringValue(row.id), entityType: stringValue(row.entity_type),
    entityId: stringValue(row.entity_id), decision: stringValue(row.decision) as DecisionRecord['decision'],
    reason: stringValue(row.reason), aiInsightId: stringValue(row.ai_insight_id),
    dataVersion: stringValue(row.data_version), decidedBy: stringValue(row.decided_by),
    decidedAt: stringValue(row.decided_at), researchJobId: nullableString(row.research_job_id),
    reverseReviewId: nullableString(row.reverse_review_id), approvalId: nullableString(row.approval_id),
  };
}

function validateJobEntity(
  database: AppDatabase,
  marketplace: string,
  jobType: ResearchJobType,
  entityType?: string,
  entityId?: string,
): void {
  const allowed: Record<ResearchJobType, string[]> = {
    existing_market: ['market_node', 'market'],
    owned_product: ['owned_product'],
    adjacent_product: ['development_project'],
    new_opportunity: ['opportunity'],
  };
  if (!entityType && !entityId && jobType === 'new_opportunity') return;
  if (!entityType || !entityId) throw new Error('该 Research Job 类型需要关联实体类型和 ID。');
  if (!allowed[jobType].includes(entityType)) {
    throw new Error(`研究类型 ${jobType} 不能关联实体类型 ${entityType}。`);
  }
  let found: unknown;
  if (entityType === 'market' || entityType === 'market_node') {
    found = database.prepare('SELECT 1 FROM market_nodes WHERE id = ? AND marketplace = ?').get(entityId, marketplace);
  } else if (entityType === 'owned_product') {
    found = database.prepare(`
      SELECT 1 FROM products WHERE id = ? AND marketplace = ? AND is_owned = 1
    `).get(entityId, marketplace);
  } else if (entityType === 'development_project') {
    found = database.prepare('SELECT 1 FROM development_projects WHERE id = ? AND marketplace = ?').get(entityId, marketplace);
  } else if (entityType === 'opportunity') {
    found = database.prepare('SELECT 1 FROM opportunities WHERE id = ? AND marketplace = ?').get(entityId, marketplace);
  } else {
    throw new Error(`不支持的实体类型：${entityType}`);
  }
  if (!found) throw new Error('关联实体不存在或不属于当前站点。');
}

function researchJobIsDemo(
  database: AppDatabase,
  mode: 'empty' | 'demo' | 'live',
  entityType?: string,
  entityId?: string,
): boolean {
  if (entityId && (entityType === 'market' || entityType === 'market_node')) {
    const row = database.prepare(`
      SELECT source_type AS sourceType FROM market_nodes WHERE id = ?
    `).get(entityId) as { sourceType: string } | undefined;
    if (row) return row.sourceType === 'mock';
  }
  if (entityId && entityType === 'owned_product') {
    const row = database.prepare(`
      SELECT source_type AS sourceType FROM products WHERE id = ? AND is_owned = 1
    `).get(entityId) as { sourceType: string } | undefined;
    if (row) return row.sourceType === 'mock';
  }
  return mode === 'demo';
}

function assertTaskBookMarketplace(marketplace: string, taskBook: Record<string, unknown>): void {
  const declared = taskBook.marketplace;
  if (typeof declared === 'string' && declared.trim() && declared.trim() !== marketplace) {
    throw new Error(`Research Task Book 站点 ${declared.trim()} 与当前工作区站点 ${marketplace} 不一致。`);
  }
}

function promptVersionFor(type: ResearchJobType): string {
  if (type === 'existing_market') return 'market-analysis.v1';
  if (type === 'owned_product') return 'owned-sku-analysis.v1';
  return 'product-research.v1+reverse-review.v1';
}

function workflowDataVersion(
  input: Record<string, unknown>,
  taskBook: Record<string, unknown>,
  promptVersion: string,
): string {
  return `workflow-${createHash('sha256').update(JSON.stringify({ input, taskBook, promptVersion })).digest('hex').slice(0, 16)}`;
}

function fieldLabel(field: string): string {
  return field.split('_').map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`).join(' ');
}

function scalarEvidenceValue(value: unknown): number | string {
  if (typeof value === 'number' || typeof value === 'string') return value;
  return JSON.stringify(value);
}

function numericOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function requiredText(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${name} 不能为空。`);
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, fallback = ''): string {
  return value === null || value === undefined ? fallback : String(value);
}

function nullableString(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

function numberValue(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function jsonValue<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function jsonObject(value: unknown): Record<string, unknown> {
  const parsed = jsonValue<unknown>(value, {});
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}
