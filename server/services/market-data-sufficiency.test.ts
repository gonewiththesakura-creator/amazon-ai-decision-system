import {afterEach,describe,expect,it} from 'vitest';
import {openDatabase,type AppDatabase} from '../database/database.js';
import {addVerifiedMcpCoverage} from '../test-utils/verified-mcp-coverage.js';
import {WorkflowRepository} from '../repository/workflow-repository.js';
import {WorkflowOrchestrator} from './workflow-orchestrator.js';
import {GoLiveMigrationService} from './go-live-migration-service.js';
import {LIMITED_MARKET_MISSING_FIELDS,hasLimitedMarketEvidence} from './market-data-sufficiency.js';
import {requires90DaySupport} from './market-data-maturity.js';

let db:AppDatabase;
afterEach(()=>db?.close());
function fixture() {
 db=openDatabase(':memory:');
 db.exec(`INSERT INTO market_nodes(id,name,level,marketplace,source_type,status,created_at)
 VALUES('market','Synthetic market',1,'US','import','active','2026-01-01');`);
 for(let i=1;i<=3;i++) db.prepare(`INSERT INTO products(id,asin,sku,brand,title,image_url,marketplace,product_type,is_owned,market_node_id,source_type,created_at)
 VALUES(?,?,?,'Fixture','Synthetic product','','US','pillow',1,'market','import','2026-01-01')`).run(`owned-${i}`,`B0TEST000${i}`,`TEST-${i}`);
 addVerifiedMcpCoverage(db,'market','owned-1',undefined,{includeHistoricalMarketObservation:false,closedMonths:true});
 const runId=String(db.prepare('SELECT id FROM data_coverage_runs').get()!.id);
 // Keep full owned evidence from the explicitly synthetic certification fixture; remove its market conclusion.
 db.exec(`UPDATE research_jobs SET status='needs_data' WHERE job_type='existing_market';`);
 const repo=new WorkflowRepository(db);
 const job=repo.createResearchJob({name:'Sufficiency test',type:'existing_market',entityType:'market',entityId:'market',
  createdBy:'test',input:{certificationRunId:runId}});
 return {runId,repo,job,go:new GoLiveMigrationService(db)};
}
describe('LIMITED market system evidence does not complete market analysis',()=>{
 it('does not interpret an opaque certification UUID containing 90d as a 90-day request',()=>{
  expect(requires90DaySupport({certificationRunId:'1111190d-1111-4111-8111-111111111111'})).toBe(false);
  expect(requires90DaySupport({certificationRunId:'1111190d-1111-4111-8111-111111111111',analysisWindow:'90D'})).toBe(true);
 });
 it('runs three unchanged full owned diagnoses in an explicitly complete synthetic baseline fixture',()=>{
 const {runId,repo,go}=fixture();
  db.exec("UPDATE research_jobs SET status='needs_data' WHERE job_type='owned_product'");
  for(const [date,sales] of [['2026-07-31',100],['2026-08-31',120]] as const){
   const id=`synthetic-market-sales-${date}`;
   db.prepare(`INSERT INTO metric_facts(id,entity_type,entity_id,marketplace,metric_name,numeric_value,source,source_id,source_type,is_estimated,confidence,observation_date,collected_at,sync_run_id)
    VALUES(?,'market','market','US','monthly_sales',?,'SellerSprite MCP','source-sellersprite-mcp','mcp',1,0.8,?,?,?)`)
    .run(id,sales,date,new Date().toISOString(),runId);
   db.prepare("INSERT INTO mcp_sync_observation_links VALUES(?,'fact',?,'market','inserted')").run(runId,id);
  }
  for(let i=1;i<=3;i++){
   const id=`synthetic-owned-baseline-${i}`,productId=`owned-${i}`;
   db.prepare(`INSERT INTO product_snapshots(id,product_id,date,observation_date,estimated_sales,source,source_type,collected_at,period,is_estimated,confidence,sync_run_id,dedup_key)
    VALUES(?,?,'2026-07-31','2026-07-31',8,'SellerSprite MCP','mcp',?,'1M',1,0.8,?,?)`).run(id,productId,new Date().toISOString(),runId,id);
   db.prepare("INSERT INTO mcp_sync_observation_links VALUES(?,'product',?,?,'inserted')").run(runId,id,productId);
   const job=repo.createResearchJob({name:'Full owned synthetic fixture',type:'owned_product',entityType:'owned_product',entityId:productId,createdBy:'test'});
   const done=new WorkflowOrchestrator(db).run(job.id);
   expect(done.status).toBe('monitoring');
   expect(done.latestInsight?.insightType).toBe('owned_product_diagnosis');
  }
  const market=repo.createResearchJob({name:'Limited synthetic market',type:'existing_market',entityType:'market',entityId:'market',createdBy:'test'});
  expect(new WorkflowOrchestrator(db).run(market.id).latestInsight?.insightType).toBe('market_data_sufficiency');
  expect(go.verify()).toMatchObject({verifiedEvidenceEntities:4,requiredEvidenceEntities:4,systemCertification:'PASS',marketAnalysisReadiness:'LIMITED'});
 });
 it('takes the unchanged full diagnosis path when complete comparable market metrics are available',()=>{
  const {job,runId,repo}=fixture();
  expect(new WorkflowOrchestrator(db).run(job.id).latestInsight?.insightType).toBe('market_data_sufficiency');
  // Explicitly synthetic fixture, not a repair or estimate of real business observations.
  for(const [date,sales] of [['2026-07-31',100],['2026-08-31',120]] as const) {
   for(const [metric,value] of Object.entries({monthly_sales:sales,monthly_revenue:sales*30,avg_price:30,median_reviews:10,top10_share:20,top20_share:35})) {
    const id=`full-${date}-${metric}`;
    db.prepare(`INSERT INTO metric_facts(id,entity_type,entity_id,marketplace,metric_name,numeric_value,source,source_id,source_type,is_estimated,confidence,observation_date,collected_at,sync_run_id)
     VALUES(?,'market','market','US',?,?,'SellerSprite MCP','source-sellersprite-mcp','mcp',1,0.8,?,?,?)`)
     .run(id,metric,value,date,new Date().toISOString(),runId);
    db.prepare("INSERT INTO mcp_sync_observation_links VALUES(?,'fact',?,'market','inserted')").run(runId,id);
   }
  }
  const next=repo.createResearchJob({name:'Full market fixture',type:'existing_market',entityType:'market',entityId:'market',createdBy:'test'});
  const done=new WorkflowOrchestrator(db).run(next.id);
  expect(done.status).toBe('monitoring');
  expect(done.latestInsight?.insightType).toBe('market_diagnosis');
  expect(repo.getEvidence(next.id).some(e=>e.metricName==='market_data_sufficiency')).toBe(false);
 });
 it('creates deterministic sufficiency with real evidence, remains needs_data and certifies 1 limited + 3 full owned entities',()=>{
  const {job,runId,repo,go}=fixture();
  const done=new WorkflowOrchestrator(db).run(job.id);
  expect(done.status).toBe('needs_data');
  expect(done.latestInsight).toMatchObject({insightType:'market_data_sufficiency',hardGate:'needs_data',opportunities:[],possibleCauses:[]});
  const missing=repo.getMissingData(job.id).filter(m=>m.requiredForDecision).map(m=>m.fieldName).sort();
  expect(missing).toEqual([...LIMITED_MARKET_MISSING_FIELDS].sort());
  const evidence=repo.getEvidence(job.id);
  expect(evidence.filter(e=>e.sourceType==='mcp').length).toBeGreaterThanOrEqual(1);
  expect(evidence.filter(e=>e.sourceType==='mcp').every(e=>e.syncRunId===runId)).toBe(true);
  expect(evidence.find(e=>e.metricName==='market_data_sufficiency')?.calculation).toContain(job.ruleProfileId);
  expect(db.prepare('SELECT COUNT(*) n FROM decisions WHERE research_job_id=?').get(job.id)).toEqual({n:0});
  expect(db.prepare('SELECT COUNT(*) n FROM opportunities').get()).toEqual({n:0});
  expect(hasLimitedMarketEvidence(db,runId,'US','market')).toBe(true);
  expect(go.verify()).toMatchObject({systemCertification:'PASS',marketAnalysisReadiness:'LIMITED',verifiedEvidenceEntities:4,requiredEvidenceEntities:4,readyForDemoCleanup:true});
 });
 it.each(['numeric','schema','provider','persistence','identity','mock','unknown_missing','owned_failed'])(
  'does not certify %s defects',kind=>{
   const {job,runId,go}=fixture();
   if(kind==='numeric') db.exec("UPDATE metric_facts SET numeric_value=NULL WHERE entity_type='market'");
   if(kind==='schema'||kind==='provider') db.prepare("UPDATE mcp_call_logs SET status='failed',error_code=? WHERE sync_run_id=? AND capability='LIST_TOOLS'")
    .run(kind==='schema'?'INVALID_SCHEMA':'REMOTE_ERROR',runId);
   if(kind==='persistence') db.prepare("UPDATE data_tasks SET status='failed',failed=1 WHERE id=?").run(runId);
   if(kind==='identity') db.exec("UPDATE mcp_sync_observation_links SET entity_id='wrong' WHERE snapshot_kind='fact'");
   if(kind==='mock') db.exec("UPDATE metric_facts SET source_type='mock' WHERE entity_type='market'");
   if(kind==='unknown_missing') {
    const profile=JSON.parse(String(db.prepare('SELECT rule_profile_snapshot_json FROM research_jobs WHERE id=?').get(job.id)!.rule_profile_snapshot_json));
    profile.hardGates.required.push('unapproved_field');
    db.prepare('UPDATE research_jobs SET rule_profile_snapshot_json=? WHERE id=?').run(JSON.stringify(profile),job.id);
   }
   if(kind==='owned_failed') db.exec("UPDATE research_jobs SET status='needs_data' WHERE job_type='owned_product'");
   new WorkflowOrchestrator(db).run(job.id);
   expect(go.verify().systemCertification).toBe('FAIL');
  });
 it('rejects altered conclusions and mismatched derived lineage',()=>{
  const {job,runId}=fixture();new WorkflowOrchestrator(db).run(job.id);
  db.prepare("UPDATE ai_insights SET opportunities_json='[\"Buy now\"]' WHERE research_job_id=?").run(job.id);
  expect(hasLimitedMarketEvidence(db,runId,'US','market')).toBe(false);
  db.prepare("UPDATE ai_insights SET opportunities_json='[]' WHERE research_job_id=?").run(job.id);
  db.prepare("UPDATE evidence_records SET calculation='{}' WHERE research_job_id=? AND metric_name='market_data_sufficiency'").run(job.id);
  expect(hasLimitedMarketEvidence(db,runId,'US','market')).toBe(false);
 });
 it('rejects a Mock evidence substitution and missing LIST_TOOLS even with otherwise valid limited evidence',()=>{
  const {job,runId,go}=fixture();new WorkflowOrchestrator(db).run(job.id);
  db.prepare("UPDATE evidence_records SET source_type='mock' WHERE research_job_id=? AND source_type='mcp'").run(job.id);
  expect(go.verify().systemCertification).toBe('FAIL');
  db.prepare("UPDATE evidence_records SET source_type='mcp' WHERE research_job_id=? AND source_type='mock'").run(job.id);
  expect(go.verify().systemCertification).toBe('PASS');
  db.prepare("DELETE FROM mcp_call_logs WHERE sync_run_id=? AND capability='LIST_TOOLS'").run(runId);
  expect(go.verify().systemCertification).toBe('FAIL');
 });
 it.each(['c74c905a-5bc6-486d-90cf-aebb24f554f5','787a8019-7bb0-4d0d-a3ef-a6c014eb4236'])(
  'keeps a terminal failed acquisition ineligible (%s)',failedId=>{
   const {job,runId,go}=fixture();new WorkflowOrchestrator(db).run(job.id);
   db.prepare("UPDATE data_tasks SET status='failed',failed=1,error_log=? WHERE id=?").run(`fixture for ${failedId}`,runId);
   expect(go.verify().systemCertification).toBe('FAIL');
   expect(()=>db.prepare("UPDATE data_tasks SET status='success' WHERE id=?").run(runId)).toThrow(/terminal/);
  });
});
