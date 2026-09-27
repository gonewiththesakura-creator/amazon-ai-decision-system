import {afterEach,describe,expect,it,vi} from 'vitest';
import {openDatabase,type AppDatabase} from '../database/database.js';
import {addVerifiedMcpCoverage} from '../test-utils/verified-mcp-coverage.js';
import {WorkflowRepository} from '../repository/workflow-repository.js';
import {WorkflowOrchestrator} from './workflow-orchestrator.js';
import {GoLiveMigrationService} from './go-live-migration-service.js';
import {requestKey} from '../adapters/mcp-policy.js';
import {ownedSufficiencyProof,hasLimitedOwnedEvidence,OWNED_MISSING_ALLOWLIST} from './owned-data-sufficiency.js';

let db:AppDatabase;
afterEach(()=>{db?.close();vi.unstubAllGlobals();});
function fixture(){
 vi.stubGlobal('fetch',vi.fn(()=>{throw new Error('Network forbidden');}));
 db=openDatabase(':memory:');
 db.exec("INSERT INTO market_nodes(id,name,level,marketplace,source_type,status,created_at) VALUES('market','Synthetic',1,'US','import','active','2026-01-01')");
 for(let i=1;i<=3;i++)db.prepare(`INSERT INTO products(id,asin,sku,brand,title,image_url,marketplace,product_type,is_owned,market_node_id,source_type,created_at)
  VALUES(?,?,?,'Synthetic','Synthetic','','US','pillow',1,'market','import','2026-01-01')`).run(`owned-${i}`,`B0TEST000${i}`,`TEST-${i}`);
 addVerifiedMcpCoverage(db,'market','owned-1',undefined,{closedMonths:true,includeHistoricalMarketObservation:false,
  ownedSales:{'owned-1':7,'owned-2':null,'owned-3':null}});
 const runId=String(db.prepare('SELECT id FROM data_coverage_runs').get()!.id),now=new Date().toISOString();
 const cap=db.prepare('SELECT * FROM provider_capability_snapshots WHERE sync_run_id=?').get(runId)!;
 const capabilities=JSON.parse(String(cap.capabilities_json));capabilities.capabilitySchemaHashes.ASIN_SALES_TREND='synthetic-trend-schema';
 db.prepare('UPDATE provider_capability_snapshots SET capabilities_json=? WHERE id=?').run(JSON.stringify(capabilities),cap.id);
 db.exec("UPDATE research_jobs SET status='needs_data'");
 for(let i=1;i<=3;i++){
  const id=`owned-${i}`,asin=`B0TEST000${i}`,points=[];
  for(const [date,liuSales] of [['2026-07-31',28],['2026-08-31',7]] as const){
   const sales=i===1?liuSales:null,price=i===1?null:40;
   const existing=db.prepare('SELECT id FROM product_snapshots WHERE product_id=? AND date=?').get(id,date);
   const sid=`synthetic-${id}-${date}`;
   if(!existing||i!==1){
    db.prepare(`INSERT INTO product_snapshots(id,product_id,date,observation_date,estimated_sales,price,source,source_type,collected_at,period,is_estimated,confidence,sync_run_id,dedup_key)
     VALUES(?,?,?,?,?,?,'SellerSprite MCP','mcp',?,'1M',1,0.8,?,?)`).run(sid,id,date,date,sales,price,now,runId,sid);
    db.prepare("INSERT INTO mcp_sync_observation_links VALUES(?,'product',?,?,'inserted')").run(runId,sid,id);
   }
   for(const [metric,value] of Object.entries({estimated_sales:sales,estimated_revenue:null,price,rating:null,review_count:null,bsr:null,seller_count:null})){
    if(db.prepare('SELECT 1 FROM metric_facts WHERE entity_id=? AND observation_date=? AND metric_name=?').get(id,date,metric))continue;
    const fid=`${sid}-${metric}`;
    db.prepare(`INSERT INTO metric_facts(id,entity_type,entity_id,marketplace,metric_name,numeric_value,source,source_id,source_type,is_estimated,confidence,observation_date,collected_at,sync_run_id)
     VALUES(?,'product',?,'US',?,?,'SellerSprite MCP','source-sellersprite-mcp','mcp',1,0.8,?,?,?)`).run(fid,id,metric,value,date,now,runId);
    db.prepare("INSERT INTO mcp_sync_observation_links VALUES(?,'fact',?,?,'inserted')").run(runId,fid,id);
   }
   points.push({month:date,price,...(i===3?{}:{childUnitSales:sales}),parentUnitSales:500});
  }
  const call=db.prepare("SELECT * FROM mcp_call_logs WHERE sync_run_id=? AND entity_id=? AND capability='ASIN_SALES_TREND'").get(runId,asin)!;
  db.prepare('UPDATE mcp_call_logs SET result_count=2,completed_at=started_at WHERE id=?').run(call.id);
  const payload={content:[{type:'text',text:JSON.stringify({code:'OK',data:{asin:{asin,marketplace:'US',parent:i===1?asin:'B0PARENT01'},salesTrendPoints:points}})}]};
  db.prepare('INSERT INTO mcp_response_cache VALUES(?,?,?,?,?)').run(call.request_hash,'sellersprite',JSON.stringify(payload),call.started_at,'2099-01-01');
  db.prepare('INSERT INTO mcp_local_observations VALUES(?,?,?,?,?,?,?,?,?)').run(`synthetic-${asin}`,JSON.stringify(JSON.parse(payload.content[0].text).data),call.started_at,'2099-01-01',0,0,'synthetic-trend-schema','ASIN_SALES_TREND',requestKey(['US',asin,null]));
 }
 const repo=new WorkflowRepository(db),go=new GoLiveMigrationService(db);
 const job=(n=1)=>repo.createResearchJob({name:'Synthetic C2',type:'owned_product',entityType:'owned_product',entityId:`owned-${n}`,createdBy:'test',input:{certificationRunId:runId}});
 return {runId,repo,go,job,proof:(n=1)=>ownedSufficiencyProof(db,runId,'US',`owned-${n}`,'test-v1',[...OWNED_MISSING_ALLOWLIST])};
}

describe('Owned sufficiency never conceals acquisition or pipeline errors',()=>{
 it('shows independent -75% closed growth, keeps needs_data and has no relative conclusion or decision',()=>{
  const {job,repo,runId,proof}=fixture();const j=job();const done=new WorkflowOrchestrator(db).run(j.id);
  expect(proof()?.closedMonthGrowth?.growth).toBe(-75);
  expect(done).toMatchObject({status:'needs_data',latestInsight:{insightType:'owned_product_data_sufficiency',hardGate:'needs_data',opportunities:[],possibleCauses:[]}});
  expect(done.latestInsight?.summary).toBe('没有合法全市场销量基线，因此不能判断相对市场表现。');
  expect(JSON.stringify(done.latestInsight)).not.toMatch(/relative_delta|outperform|underperform/);
  expect(repo.getEvidence(j.id).filter(e=>e.sourceType==='mcp').every(e=>e.syncRunId===runId)).toBe(true);
  expect(db.prepare('SELECT count(*) n FROM decisions WHERE research_job_id=?').get(j.id)!.n).toBe(0);
  expect(db.prepare('SELECT count(*) n FROM approvals WHERE research_job_id=?').get(j.id)!.n).toBe(0);
  expect(hasLimitedOwnedEvidence(db,runId,'US','owned-1')).toBe(true);
  expect(fetch).not.toHaveBeenCalled();
 });
 it.each([2,3])('accepts true child null/absent for child %s without assigning parent sales',n=>{
  const {job,proof,runId}=fixture();expect(proof(n)?.observations.every(o=>o.sales===null)).toBe(true);
  expect(new WorkflowOrchestrator(db).run(job(n).id).latestInsight?.insightType).toBe('owned_product_data_sufficiency');
  expect(hasLimitedOwnedEvidence(db,runId,'US',`owned-${n}`)).toBe(true);
 });
 it('accepts 1 Limited market + 3 Limited owned as 4/4 only in synthetic successful certification',()=>{
  const {job,go,repo,runId}=fixture();
  for(let i=1;i<=3;i++)new WorkflowOrchestrator(db).run(job(i).id);
  const market=repo.createResearchJob({name:'Synthetic limited market',type:'existing_market',entityType:'market',entityId:'market',createdBy:'test',input:{certificationRunId:runId}});
  new WorkflowOrchestrator(db).run(market.id);
  expect(go.verify()).toMatchObject({systemCertification:'PASS',marketAnalysisReadiness:'LIMITED',ownedAnalysisReadiness:'LIMITED',verifiedEvidenceEntities:4,requiredEvidenceEntities:4});
  expect(fetch).not.toHaveBeenCalled();
 });
 it.each(['mapping','redaction','normalization','schema','provider','persistence','identity','mock','lineage','unknown-gap'])('rejects %s, never generates Limited',kind=>{
  const {job,proof,runId}=fixture();const j=job(2);
  if(kind==='mapping'||kind==='redaction'||kind==='identity'){
   const cache=db.prepare("SELECT * FROM mcp_response_cache WHERE cache_key=?").get(`asin-owned-2-${runId}`)!;
   const envelope=JSON.parse(String(cache.response_json)),body=JSON.parse(envelope.content[0].text);
   if(kind==='mapping')body.data.salesTrendPoints[0].childUnitSales=99;
   if(kind==='redaction')body.data.salesTrendPoints='[REDACTED]';
   if(kind==='identity')body.data.asin.asin='B0WRONG001';
   envelope.content[0].text=JSON.stringify(body);db.prepare('UPDATE mcp_response_cache SET response_json=? WHERE cache_key=?').run(JSON.stringify(envelope),cache.cache_key);
   // Mapping defect means the raw and normalized values exist, but Snapshot/Fact lost the value.
   if(kind==='mapping')db.prepare('UPDATE mcp_local_observations SET payload_json=? WHERE request_key=?').run(JSON.stringify(body.data),'synthetic-B0TEST0002');
  }
  if(kind==='normalization')db.exec("UPDATE mcp_local_observations SET payload_json='{}' WHERE request_key='synthetic-B0TEST0002'");
  if(kind==='schema'||kind==='provider')db.prepare("UPDATE mcp_call_logs SET error_code=? WHERE sync_run_id=? AND entity_id='B0TEST0002'").run(kind,runId);
  if(kind==='persistence')db.exec("DELETE FROM metric_facts WHERE entity_id='owned-2' AND metric_name='price'");
  if(kind==='identity')expect(()=>proof(2)).toThrow();
  if(kind==='mock')db.exec("UPDATE products SET source_type='mock' WHERE id='owned-2'");
  if(kind==='lineage')db.exec("DELETE FROM mcp_sync_observation_links WHERE entity_id='owned-2' AND snapshot_kind='fact'");
  if(kind==='unknown-gap')expect(ownedSufficiencyProof(db,runId,'US','owned-2','v1',['unapproved'])).toBeNull();
  else expect(()=>proof(2)).toThrow();
  try{new WorkflowOrchestrator(db).run(j.id);}catch{/* expected integrity failure */}
  if(kind!=='unknown-gap')expect(repoInsight(j.id)).not.toBe('owned_product_data_sufficiency');
  if(['mapping','redaction','identity'].includes(kind))expect(db.prepare('SELECT status FROM research_jobs WHERE id=?').get(j.id)!.status).toBe('failed');
 });
 it('rejects tampered sufficiency claims and missing evidence',()=>{
  const {job,runId}=fixture();const j=job();new WorkflowOrchestrator(db).run(j.id);
  db.prepare("UPDATE ai_insights SET summary='outperform' WHERE research_job_id=?").run(j.id);
  expect(hasLimitedOwnedEvidence(db,runId,'US','owned-1')).toBe(false);
 });
 it.each(['c74c905a-5bc6-486d-90cf-aebb24f554f5','787a8019-7bb0-4d0d-a3ef-a6c014eb4236'])('never revives failed certification %s',failedId=>{
  const {runId,proof,go}=fixture();db.prepare("UPDATE data_tasks SET status='failed',failed=1,error_log=? WHERE id=?").run(failedId,runId);
  expect(proof()).toBeNull();expect(go.verify().systemCertification).toBe('FAIL');
  expect(()=>db.prepare("UPDATE data_tasks SET status='success' WHERE id=?").run(runId)).toThrow(/terminal/);
 });
});
function repoInsight(jobId:string){return db.prepare('SELECT insight_type FROM ai_insights WHERE research_job_id=? ORDER BY generated_at DESC LIMIT 1').get(jobId)?.insight_type;}
