import {createHash} from 'node:crypto';
import type {AppDatabase} from '../database/database.js';
import {mcpCallToolResultSchema,sellerSpriteEnvelope,sellerSpriteAsinTrendSchema} from '../adapters/sellersprite-mcp-schemas.js';
import {deriveSnapshotGrowth,monthlyPeriodState} from '../domain/snapshot-growth.js';
import {entityMarketMaturity} from './market-data-maturity.js';
import {requestKey} from '../adapters/mcp-policy.js';

export const OWNED_SUFFICIENCY_VERSION='owned-data-sufficiency.v1';
export const OWNED_MISSING_ALLOWLIST=['market_growth_30d','market_growth_baseline','sku_growth_30d'] as const;
type Row=Record<string,string|number|null>;
export interface OwnedSufficiencyProof {
 version:string; runId:string; productId:string; asin:string; ruleVersion:string;
 missingFields:string[]; callId:string; rawHash:string; schemaHash:string;
 facts:Row[]; observations:Array<{date:string;periodState:'closed_month'|'current_mtd';sales:number|null;childSalesState:'absent'|'null'|'available';snapshotId:string}>;
 closedMonthGrowth:ReturnType<typeof deriveSnapshotGrowth>;
}
export class OwnedEvidenceError extends Error {
 constructor(code:string){super(`Owned evidence integrity failure: ${code}`);}
}
function numeric(value:unknown):number|null {
 if(value===null||value===undefined)return null;
 if(typeof value!=='number'||!Number.isFinite(value))throw new OwnedEvidenceError('INVALID_NUMERIC_SCHEMA');
 return value;
}
function dateOf(value:unknown):string {
 if(typeof value!=='string')throw new OwnedEvidenceError('INVALID_DATE');
 const month=/^(\d{4})-?(\d{2})$/.exec(value);
 const date=month&&Number(month[2])>=1&&Number(month[2])<=12
  ?new Date(Date.UTC(Number(month[1]),Number(month[2]),0)).toISOString().slice(0,10):value;
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date)
  throw new OwnedEvidenceError('INVALID_DATE');
 return date;
}

/** Reconcile the retained fresh raw response against every persisted metric, including nulls.
 * This is validation, never a repair. Corrupted audit data cannot qualify as a business gap.
 */
export function ownedSufficiencyProof(db:AppDatabase,runId:string,marketplace:string,productId:string,
 ruleVersion:string,missingFields:string[]):OwnedSufficiencyProof|null {
 const missing=[...new Set(missingFields)].sort();
 if(!missing.length||missing.some(f=>!(OWNED_MISSING_ALLOWLIST as readonly string[]).includes(f)))return null;
 if(!db.prepare(`SELECT 1 FROM data_tasks t JOIN data_coverage_runs c ON c.id=t.id WHERE t.id=?
  AND t.sync_run_id=t.id AND t.status='success' AND t.failed=0 AND t.success=t.total AND t.total>0
  AND t.task_type='critical_sync' AND t.marketplace=? AND c.is_complete=1`).get(runId,marketplace))return null;
 if(db.prepare("SELECT 1 FROM data_tasks WHERE sync_run_id=? AND status IN ('failed','partial')").get(runId)
  ||db.prepare("SELECT 1 FROM mcp_call_logs WHERE sync_run_id=? AND (status<>'success' OR error_code IS NOT NULL)").get(runId))
  throw new OwnedEvidenceError('ACQUISITION_ERROR');
 const p=db.prepare("SELECT * FROM products WHERE id=? AND marketplace=? AND is_owned=1 AND is_parent=0 AND source_type<>'mock'").get(productId,marketplace);
 if(!p)throw new OwnedEvidenceError('IDENTITY_OR_MOCK');
 const call=db.prepare(`SELECT l.*,c.response_json,c.created_at AS raw_collected_at FROM mcp_call_logs l
  JOIN mcp_response_cache c ON c.cache_key=l.request_hash AND c.provider_id=l.provider_id
  WHERE l.sync_run_id=? AND l.provider_id='sellersprite' AND l.capability='ASIN_SALES_TREND'
   AND l.entity_type='product' AND l.entity_id=? AND l.status='success' AND l.error_code IS NULL AND l.cache_hit=0
  ORDER BY l.completed_at DESC LIMIT 1`).get(runId,p.asin);
 if(!call||!Number.isFinite(Date.parse(String(call.completed_at)))||!Number.isFinite(Date.parse(String(call.raw_collected_at)))
  ||Math.abs(Date.parse(String(call.raw_collected_at))-Date.parse(String(call.completed_at)))>5000)
  throw new OwnedEvidenceError('RAW_NOT_AUDITABLE');
 let raw:ReturnType<typeof sellerSpriteAsinTrendSchema.parse>;
 try {raw=sellerSpriteAsinTrendSchema.parse(sellerSpriteEnvelope(mcpCallToolResultSchema.parse(JSON.parse(String(call.response_json)))));}
 catch {throw new OwnedEvidenceError('RAW_SCHEMA_OR_REDACTION');}
 if(raw.asin.asin!==p.asin||(raw.asin.dataAsin!=null&&raw.asin.dataAsin!==p.asin)||raw.asin.marketplace!==marketplace||!raw.salesTrendPoints.length
  ||raw.salesTrendPoints.length!==call.result_count)throw new OwnedEvidenceError('RAW_IDENTITY_OR_COUNT');
 const cap=db.prepare("SELECT capabilities_json FROM provider_capability_snapshots WHERE provider_id='sellersprite' AND sync_run_id=? ORDER BY collected_at DESC LIMIT 1").get(runId);
 let schemaHash:string;
 try {const c=JSON.parse(String(cap?.capabilities_json));schemaHash=c.capabilitySchemaHashes.ASIN_SALES_TREND;
  if(typeof schemaHash!=='string'||!schemaHash||c.capabilities.ASIN_SALES_TREND!==call.actual_tool)throw new Error();}
 catch{throw new OwnedEvidenceError('CAPABILITY_SCHEMA');}
 const normalized=db.prepare(`SELECT payload_json FROM mcp_local_observations WHERE capability='ASIN_SALES_TREND'
  AND scope_key=? AND schema_hash=? AND ABS(julianday(collected_at)-julianday(?))<5.0/86400 ORDER BY collected_at DESC LIMIT 1`)
  .get(requestKey([marketplace,p.asin,null]),schemaHash,call.raw_collected_at);
 try{
  const data=sellerSpriteAsinTrendSchema.parse(JSON.parse(String(normalized?.payload_json)));
  if(requestKey(data)!==requestKey(raw))throw new Error();
 }catch{throw new OwnedEvidenceError('NORMALIZATION_AUDIT_MISMATCH');}
 const observations:OwnedSufficiencyProof['observations']=[],facts:Row[]=[];
 for(const point of raw.salesTrendPoints){
  if((point.asin!=null&&point.asin!==p.asin)||(point.marketplace!=null&&point.marketplace!==marketplace))throw new OwnedEvidenceError('POINT_IDENTITY');
  const date=dateOf(point.month);
  if(observations.some(o=>o.date===date))throw new OwnedEvidenceError('DUPLICATE_PERIOD');
  const childSales=numeric(point.childUnitSales),isParent=raw.asin.parent===p.asin;
  const metrics={price:numeric(point.price),rating:numeric(point.rating),review_count:numeric(point.ratings),
   bsr:numeric(point.bsr??point.bsrRank),estimated_sales:childSales??(isParent?numeric(point.parentUnitSales):null),
   estimated_revenue:numeric(point.childSalesRevenue)??(isParent?numeric(point.parentSalesRevenue):null),seller_count:numeric(point.sellers)};
  const snapshots=db.prepare(`SELECT s.* FROM product_snapshots s JOIN mcp_sync_observation_links l
   ON l.snapshot_id=s.id AND l.snapshot_kind='product' AND l.entity_id=s.product_id AND l.sync_run_id=?
   WHERE s.product_id=? AND COALESCE(s.observation_date,s.date)=? AND s.source_type='mcp' AND s.source='SellerSprite MCP'
   AND (s.sync_run_id=l.sync_run_id OR l.disposition='reused')`).all(runId,productId,date);
  const snapshot=snapshots.find(s=>Object.entries(metrics).every(([key,value])=>s[key]===value));
  if(!snapshot)throw new OwnedEvidenceError('SNAPSHOT_MAPPING_OR_PERSISTENCE');
  for(const [metric,value] of Object.entries(metrics)){
   const f=db.prepare(`SELECT f.* FROM metric_facts f JOIN mcp_sync_observation_links l
    ON l.snapshot_id=f.id AND l.snapshot_kind='fact' AND l.entity_id=f.entity_id AND l.sync_run_id=?
    WHERE f.entity_type='product' AND f.entity_id=? AND f.marketplace=? AND f.observation_date=? AND f.metric_name=?
     AND f.source_type='mcp' AND f.source='SellerSprite MCP' AND f.source_id='source-sellersprite-mcp'
     AND f.sync_run_id=? AND (f.sync_run_id=l.sync_run_id OR l.disposition='reused')
    ORDER BY f.collected_at DESC LIMIT 1`).get(runId,productId,marketplace,date,metric,snapshot.sync_run_id);
   if(!f||f.numeric_value!==value)throw new OwnedEvidenceError('FACT_MAPPING_OR_LINEAGE');
   if(value!==null)facts.push({...f,snapshot_id:String(snapshot.id)} as Row);
  }
  observations.push({date,sales:metrics.estimated_sales,snapshotId:String(snapshot.id),
   periodState:monthlyPeriodState(date,String(snapshot.collected_at)),
   childSalesState:point.childUnitSales===undefined?'absent':point.childUnitSales===null?'null':'available'});
 }
 if(!facts.length)throw new OwnedEvidenceError('NO_REAL_NUMERIC_FACT');
 observations.sort((a,b)=>a.date.localeCompare(b.date));facts.sort((a,b)=>String(a.id).localeCompare(String(b.id)));
 const closedMonthGrowth=deriveSnapshotGrowth(observations.map(o=>({id:o.snapshotId,date:o.date,value:o.sales,periodState:o.periodState})));
 // A missing relative field may be caused by absent market baseline despite a valid independent SKU pair.
 // Otherwise only explicit child-data gaps qualify; an unexplained lost calculation never does.
 if(missing.includes('sku_growth_30d')&&!((closedMonthGrowth&&missing.includes('market_growth_baseline'))
  ||observations.filter(o=>o.periodState==='closed_month').some(o=>o.sales===null&&o.childSalesState!=='available')))
  throw new OwnedEvidenceError('UNEXPLAINED_GROWTH_GAP');
 return {version:OWNED_SUFFICIENCY_VERSION,runId,productId,asin:String(p.asin),ruleVersion,missingFields:missing,
  callId:String(call.id),schemaHash,rawHash:createHash('sha256').update(String(call.response_json)).digest('hex'),facts,observations,closedMonthGrowth};
}

export function ownedSufficiencyContent(proof:OwnedSufficiencyProof){
 return {status:'needs_data',title:'自有产品数据充分性：LIMITED',
  summary:proof.missingFields.includes('market_growth_baseline')
   ?'没有合法全市场销量基线，因此不能判断相对市场表现。'
   :'缺少可比较的自有产品销量基线，因此不能判断相对市场表现。',
  facts:[...proof.facts.map(f=>`${f.observation_date}：${f.metric_name} = ${f.numeric_value}（真实MCP观察；${monthlyPeriodState(String(f.observation_date),String(f.collected_at))}）。`),
   ...(proof.closedMonthGrowth?[`自身 closed-month 销量变化：${proof.closedMonthGrowth.baseline.date} → ${proof.closedMonthGrowth.latest.date}，${proof.closedMonthGrowth.growth}%；不代表相对市场表现。`]:[])],
  opportunities:[] as string[],possibleCauses:[] as string[],risks:['自有产品分析就绪度 LIMITED；不形成业务决策。'],
  recommendedActions:[`补充可审计的缺失数据：${proof.missingFields.join('、')}。`],missingData:proof.missingFields,
  insightType:'owned_product_data_sufficiency',hardGate:'needs_data' as const,decision:'needs_data' as const};
}

/** Rebuild proof, then compare deterministic content and all evidence. No permissive label-only check. */
export function hasLimitedOwnedEvidence(db:AppDatabase,runId:string,marketplace:string,productId:string):boolean {
 const jobs=db.prepare(`SELECT * FROM research_jobs WHERE entity_id=? AND marketplace=? AND job_type='owned_product'
  AND entity_type IN ('owned_product','product') AND status='needs_data' AND is_demo=0 AND error IS NULL
  AND prompt_version='owned-sku-analysis.v2'`).all(productId,marketplace);
 for(const job of jobs)try{
  const missing=db.prepare("SELECT field_name FROM missing_data_items WHERE research_job_id=? AND status='open' AND required_for_decision=1 ORDER BY field_name")
   .all(job.id).map(r=>String(r.field_name));
  const proof=ownedSufficiencyProof(db,runId,marketplace,productId,`${job.rule_profile_id}@${job.rule_profile_version}`,missing);
  if(!proof||db.prepare('SELECT 1 FROM approvals WHERE research_job_id=?').get(job.id)
   ||db.prepare('SELECT 1 FROM decisions WHERE research_job_id=?').get(job.id))continue;
  const tasks=db.prepare('SELECT * FROM data_tasks WHERE research_job_id=?').all(job.id);
  if(!tasks.length||tasks.some(t=>t.sync_run_id!==runId||t.status!=='success'||!t.completed_at||t.total!==t.success||t.failed!==0))continue;
  const steps=db.prepare('SELECT step_type,status FROM research_steps WHERE research_job_id=?').all(job.id);
  if(!['validate','hard_gate'].every(s=>steps.some(r=>r.step_type===s&&r.status==='needs_data'))
   ||!['ai_analysis','report'].every(s=>steps.some(r=>r.step_type===s&&r.status==='completed'))
   ||steps.some(r=>r.step_type==='approval'&&r.status!=='pending'))continue;
  const i=db.prepare("SELECT * FROM ai_insights WHERE research_job_id=? AND data_version=? AND insight_type='owned_product_data_sufficiency' ORDER BY generated_at DESC LIMIT 1").get(job.id,job.data_version);
  if(!i||i.prompt_version!==job.prompt_version||i.hard_gate!=='needs_data'||i.decision_recommendation!=='needs_data'||i.score!==null||i.model!=='rule-engine-v1')continue;
  const content=ownedSufficiencyContent(proof),maturity=entityMarketMaturity(db,'research_job',String(job.id));
  const risks=maturity?.status==='LIMITED'?[...content.risks,maturity.message]:content.risks;
  const fields=maturity?.status==='LIMITED'?[...proof.missingFields,'market_history_90d']:proof.missingFields;
  if(i.status!==content.status||i.title!==content.title||i.summary!==content.summary||i.facts_json!==JSON.stringify(content.facts)
   ||i.opportunities_json!=='[]'||i.possible_causes_json!=='[]'||i.risks_json!==JSON.stringify(risks)
   ||i.recommendations_json!==JSON.stringify(content.recommendedActions)||i.missing_data_json!==JSON.stringify(fields))continue;
  const ids=JSON.parse(String(i.evidence_ids_json));
  const evidence=db.prepare('SELECT * FROM evidence_records WHERE research_job_id=? AND insight_id=? AND data_version=?').all(job.id,i.id,job.data_version);
  if(!Array.isArray(ids)||ids.length!==proof.facts.length+1||new Set(ids).size!==ids.length||evidence.length!==ids.length||evidence.some(e=>!ids.includes(e.id)))continue;
  if(!proof.facts.every(f=>evidence.some(e=>e.source_type==='mcp'&&e.sync_run_id===runId&&e.source_record_id===f.id
   &&e.metric_name===f.metric_name&&e.metric_value_json===JSON.stringify(f.numeric_value)&&e.source===f.source&&e.collected_at===f.collected_at)))continue;
  if(evidence.some(e=>e.metric_name==='owned_product_data_sufficiency'&&e.source_type==='manual'&&e.source===OWNED_SUFFICIENCY_VERSION
   &&e.calculation===JSON.stringify(proof)&&e.metric_value_json===JSON.stringify({readiness:'LIMITED',missingFields:proof.missingFields})))return true;
 }catch{/* Invalid raw/evidence never qualifies as Limited. */}
 return false;
}
