import type { AppDatabase } from '../database/database.js';
import { marketDataMaturity } from './market-data-maturity.js';
import { LocalObservationResolver } from './local-observation-resolver.js';

export const SUFFICIENCY_VERSION = 'market-data-sufficiency.v1';
export const LIMITED_MARKET_MISSING_FIELDS = [
  'monthly_sales', 'monthly_revenue', 'avg_price', 'median_reviews',
  'top10_sales_share', 'top20_sales_share', 'market_growth_baseline',
] as const;
type Row = Record<string, string | number | null>;
export interface SufficiencyProof {
  version: string;
  runId: string;
  marketId: string;
  ruleVersion: string;
  missingFields: string[];
  facts: Row[];
  reusedLineage: Row[];
}

/** Call only after the acquisition contract has passed. Never promotes an acquisition/run. */
export function marketSufficiencyProof(
  db: AppDatabase, runId: string, marketplace: string, marketId: string,
  ruleVersion: string, missingFields: string[],
): SufficiencyProof | null {
  const missing = [...new Set(missingFields)].sort();
  if (!missing.length || missing.some(field => !(LIMITED_MARKET_MISSING_FIELDS as readonly string[]).includes(field))
    || marketDataMaturity(db, marketplace, marketId).status !== 'LIMITED') return null;
  if (!db.prepare(`SELECT 1 FROM data_tasks t JOIN data_coverage_runs c ON c.id=t.id
    WHERE t.id=? AND t.sync_run_id=t.id AND t.status='success' AND t.failed=0
      AND t.success=t.total AND t.task_type='critical_sync' AND t.marketplace=?
      AND c.is_complete=1`).get(runId, marketplace)
    || db.prepare(`SELECT 1 FROM data_tasks WHERE sync_run_id=? AND status IN ('failed','partial')`).get(runId)
    || db.prepare(`SELECT 1 FROM mcp_call_logs WHERE sync_run_id=? AND (status<>'success' OR error_code IS NOT NULL)`).get(runId)) return null;
  const facts = db.prepare(`SELECT DISTINCT f.id, f.metric_name, f.numeric_value, f.observation_date,
      f.collected_at, f.source, f.source_type, f.confidence, f.is_estimated, f.sync_run_id AS original_run_id,
      s.id AS snapshot_id, s.sync_run_id AS snapshot_run_id, s.collected_at AS snapshot_collected_at,
      sl.disposition AS snapshot_disposition
    FROM metric_facts f JOIN mcp_sync_observation_links fl ON fl.snapshot_id=f.id AND fl.snapshot_kind='fact'
      AND fl.entity_id=f.entity_id AND fl.sync_run_id=?
    JOIN market_snapshots s ON s.market_node_id=f.entity_id
      AND COALESCE(s.observation_date,s.date)=f.observation_date AND s.sync_run_id=f.sync_run_id
    JOIN mcp_sync_observation_links sl ON sl.snapshot_id=s.id AND sl.snapshot_kind='market'
      AND sl.entity_id=s.market_node_id AND sl.sync_run_id=fl.sync_run_id
    WHERE f.entity_type='market' AND f.entity_id=? AND f.marketplace=?
      AND f.source_type='mcp' AND f.source_id='source-sellersprite-mcp' AND f.source='SellerSprite MCP'
      AND s.source_type='mcp' AND s.source='SellerSprite MCP'
      AND f.numeric_value IS NOT NULL
      AND julianday(f.observation_date)<=julianday('now')
      AND (fl.disposition='reused' OR f.sync_run_id=fl.sync_run_id)
      AND (sl.disposition='reused' OR s.sync_run_id=sl.sync_run_id)
    ORDER BY f.observation_date,f.metric_name,f.id,s.id`).all(runId,marketId,marketplace) as Row[];
  if (!facts.length || facts.some(f => typeof f.numeric_value !== 'number' || !Number.isFinite(f.numeric_value))) return null;
  const resolver = new LocalObservationResolver(db);
  for (const fact of facts) {
    if (fact.snapshot_run_id !== runId && !resolver.hasMarketReuse(runId,marketId,String(fact.observation_date))) return null;
  }
  const newest = facts.map(f => String(f.observation_date)).sort().at(-1);
  const metricNames: Record<string,string> = {top10_sales_share:'top10_share',top20_sales_share:'top20_share'};
  if (missing.some(field => facts.some(f => f.observation_date===newest && f.metric_name===(metricNames[field] ?? field)))) return null;
  const reusedLineage=db.prepare(`SELECT r.snapshot_id,r.lineage_json FROM mcp_market_reuse_lineage r
    JOIN market_snapshots s ON s.id=r.snapshot_id WHERE r.sync_run_id=? AND s.market_node_id=? ORDER BY r.snapshot_id`)
    .all(runId,marketId) as Row[];
  return {version:SUFFICIENCY_VERSION,runId,marketId,ruleVersion,missingFields:missing,facts,reusedLineage};
}

export function sufficiencyContent(proof: SufficiencyProof) {
  return {
    status: 'needs_data', title: '市场数据充分性：LIMITED',
    summary: '数据不足，暂不能判断市场销量、销售额、价格结构、集中度和增长。此结果仅证明系统识别并阻止了无依据的市场结论，不代表市场研究完成。',
    facts: proof.facts.map(f => `${f.observation_date}：${f.metric_name} = ${f.numeric_value}（真实MCP观察）。`),
    opportunities: [] as string[], possibleCauses: [] as string[],
    risks: ['市场分析就绪度 LIMITED；缺失指标保持未知。'],
    recommendedActions: [`补充可追溯数据：${proof.missingFields.join('、')}。`],
    missingData: proof.missingFields, insightType: 'market_data_sufficiency',
    hardGate: 'needs_data' as const, decision: 'needs_data' as const,
  };
}

/** Strict deterministic sufficiency evidence, separate from completed market analysis. */
export function hasLimitedMarketEvidence(db: AppDatabase, runId: string, marketplace: string, marketId: string): boolean {
  const jobs=db.prepare(`SELECT * FROM research_jobs WHERE marketplace=? AND entity_id=?
    AND entity_type IN ('market','market_node') AND job_type='existing_market' AND status='needs_data'
    AND is_demo=0 AND error IS NULL AND prompt_version='market-analysis.v2'`).all(marketplace,marketId);
  for(const job of jobs) {
    const missing=db.prepare(`SELECT field_name FROM missing_data_items WHERE research_job_id=?
      AND status='open' AND required_for_decision=1 ORDER BY field_name`).all(job.id).map(r=>String(r.field_name));
    const proof=marketSufficiencyProof(db,runId,marketplace,marketId,`${job.rule_profile_id}@${job.rule_profile_version}`,missing);
    if(!proof) continue;
    if(db.prepare('SELECT 1 FROM approvals WHERE research_job_id=?').get(job.id)
      ||db.prepare('SELECT 1 FROM decisions WHERE research_job_id=?').get(job.id)) continue;
    const tasks=db.prepare('SELECT * FROM data_tasks WHERE research_job_id=?').all(job.id);
    if(!tasks.length||tasks.some(t=>t.sync_run_id!==runId||t.status!=='success'||!t.completed_at||t.total!==t.success||t.failed!==0)) continue;
    const steps=db.prepare('SELECT step_type,status FROM research_steps WHERE research_job_id=?').all(job.id);
    if(!['validate','hard_gate'].every(s=>steps.some(r=>r.step_type===s&&r.status==='needs_data'))
      ||!['ai_analysis','report'].every(s=>steps.some(r=>r.step_type===s&&r.status==='completed'))
      ||steps.some(r=>r.step_type==='approval'&&r.status!=='pending')) continue;
    const insight=db.prepare(`SELECT * FROM ai_insights WHERE research_job_id=? AND data_version=?
      AND insight_type='market_data_sufficiency' ORDER BY generated_at DESC LIMIT 1`).get(job.id,job.data_version);
    if(!insight||insight.prompt_version!==job.prompt_version||insight.hard_gate!=='needs_data'
      ||insight.decision_recommendation!=='needs_data'||insight.score!==null) continue;
    const content=sufficiencyContent(proof);
    if(insight.status!==content.status||insight.title!==content.title||insight.summary!==content.summary
      ||insight.facts_json!==JSON.stringify(content.facts)||insight.opportunities_json!=='[]'
      ||insight.possible_causes_json!=='[]'||insight.recommendations_json!==JSON.stringify(content.recommendedActions)
      ||insight.risks_json!==JSON.stringify([...content.risks,marketDataMaturity(db,marketplace,marketId).message])
      ||insight.missing_data_json!==JSON.stringify([...proof.missingFields,'market_history_90d'])
      ||insight.model!=='rule-engine-v1') continue;
    try {
      const ids=JSON.parse(String(insight.evidence_ids_json)) as unknown;
      if(!Array.isArray(ids)||ids.length!==proof.facts.length+1||new Set(ids).size!==ids.length) continue;
      const evidence=db.prepare('SELECT * FROM evidence_records WHERE research_job_id=? AND insight_id=? AND data_version=?')
        .all(job.id,insight.id,job.data_version);
      if(evidence.length!==ids.length||evidence.some(e=>!ids.includes(e.id))) continue;
      const real=proof.facts.every(f=>evidence.some(e=>e.source_type==='mcp'&&e.sync_run_id===runId
        &&e.source_record_id===f.id&&e.metric_name===f.metric_name&&e.metric_value_json===JSON.stringify(f.numeric_value)
        &&e.source===f.source&&e.collected_at===f.collected_at));
      const derived=evidence.find(e=>e.metric_name==='market_data_sufficiency'&&e.source_type==='manual'
        &&e.source===SUFFICIENCY_VERSION&&e.source_record_id===null&&e.calculation===JSON.stringify(proof)
        &&e.metric_value_json===JSON.stringify({maturity:'LIMITED',missingFields:proof.missingFields}));
      if(real&&derived) return true;
    }catch { /* malformed evidence never certifies */ }
  }
  return false;
}
