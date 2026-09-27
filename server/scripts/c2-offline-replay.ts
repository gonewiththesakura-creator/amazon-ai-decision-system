/** Read business DB only; all synthetic acquisition links/jobs are confined to a disposable copy. */
import {DatabaseSync,backup} from 'node:sqlite';
import {mkdtempSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import http from 'node:http';import https from 'node:https';import net from 'node:net';import tls from 'node:tls';
import {migrate} from '../database/migrations.js';
import {WorkflowRepository} from '../repository/workflow-repository.js';
import {WorkflowOrchestrator} from '../services/workflow-orchestrator.js';
import {GoLiveMigrationService} from '../services/go-live-migration-service.js';
import {deriveSnapshotGrowth,monthlyPeriodState} from '../domain/snapshot-growth.js';
let networkAttempts=0;
const deny=()=>{networkAttempts++;throw new Error('Offline replay: network forbidden');};
globalThis.fetch=deny;http.request=deny;http.get=deny;https.request=deny;https.get=deny;net.connect=deny;net.createConnection=deny;tls.connect=deny;
const sourcePath=process.argv[2];
if(!sourcePath)throw new Error('Usage: tsx server/scripts/c2-offline-replay.ts <business-db>');
const fileHash=()=>createHash('sha256').update(readFileSync(sourcePath)).digest('hex');
const originalFileHash=fileHash(),source=new DatabaseSync(sourcePath,{readOnly:true});
const fromRun='c74c905a-5bc6-486d-90cf-aebb24f554f5',oldRun='787a8019-7bb0-4d0d-a3ef-a6c014eb4236',shadowRun=randomUUID();
const protectedState=(d:DatabaseSync)=>JSON.stringify({tasks:d.prepare('SELECT * FROM data_tasks WHERE sync_run_id IN (?,?)').all(fromRun,oldRun),
 coverage:d.prepare('SELECT * FROM data_coverage_runs WHERE id IN (?,?)').all(fromRun,oldRun),quota:d.prepare('SELECT * FROM provider_quota_state').all(),
 usages:d.prepare('SELECT * FROM mcp_usage_events').all(),mode:d.prepare('SELECT * FROM app_settings').all()});
const before=protectedState(source),copyPath=join(mkdtempSync(join(tmpdir(),'ys-c2-offline-replay-')),'replay-only.db');
await backup(source,copyPath);
const db=new DatabaseSync(copyPath);migrate(db);const originalCopy=protectedState(db);
const tasks=db.prepare("SELECT * FROM data_tasks WHERE sync_run_id=? AND task_type IN ('critical_sync','competitor_discovery','competitor_refresh')").all(fromRun);
const mapping=new Map<string,string>([[fromRun,shadowRun]]);
for(const t of tasks)if(t.id!==fromRun)mapping.set(String(t.id),randomUUID());
function remap(value:unknown):unknown{
 if(typeof value==='string')return mapping.get(value)??value;
 if(Array.isArray(value))return value.map(remap);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,remap(v)]));
 return value;
}
function insert(table:string,row:Record<string,unknown>){const keys=Object.keys(row);db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(()=>'?').join(',')})`).run(...keys.map(k=>row[k]) as never[]);}
try{
 for(const task of tasks)insert('data_tasks',{...task,id:mapping.get(String(task.id)),sync_run_id:shadowRun,
  status:'success',success:task.total,failed:0,error_log:null,name:`OFFLINE SHADOW ONLY ${task.name}`});
 const coverage=db.prepare('SELECT * FROM data_coverage_runs WHERE id=?').get(fromRun)!;
 insert('data_coverage_runs',{...coverage,id:shadowRun,is_complete:1,
  coverage_json:JSON.stringify({...remap(JSON.parse(String(coverage.coverage_json))) as object,offlineReplayOnly:true,originalFailedRun:fromRun})});
 for(const row of db.prepare('SELECT * FROM mcp_sync_observation_links WHERE sync_run_id=?').all(fromRun))insert('mcp_sync_observation_links',{...row,sync_run_id:shadowRun,disposition:'reused'});
 for(const row of db.prepare('SELECT * FROM mcp_market_reuse_lineage WHERE sync_run_id=?').all(fromRun))insert('mcp_market_reuse_lineage',{...row,sync_run_id:shadowRun});
 for(const table of ['mcp_call_logs','provider_capability_snapshots'])for(const row of db.prepare(`SELECT * FROM ${table} WHERE sync_run_id=?`).all(fromRun))insert(table,{...row,id:randomUUID(),sync_run_id:shadowRun});
 for(const row of db.prepare('SELECT * FROM competitor_candidate_run_links WHERE sync_run_id=?').all(fromRun)){
  const o=db.prepare('SELECT * FROM competitor_candidate_observations WHERE id=?').get(row.observation_id)!;
  const id=randomUUID();insert('competitor_candidate_observations',{...o,id,sync_run_id:shadowRun});
  insert('competitor_candidate_run_links',{...row,sync_run_id:shadowRun,observation_id:id,disposition:'reused'});
 }
 const marketId=String(db.prepare('SELECT default_market_id FROM app_settings WHERE id=1').get()!.default_market_id),go=new GoLiveMigrationService(db);
 assert.equal(go.certifiedAcquisitionRun('US',marketId),shadowRun);
 const repo=new WorkflowRepository(db),workflow=new WorkflowOrchestrator(db),scope=JSON.parse(String(coverage.coverage_json));
 const targets=[{type:'existing_market' as const,entityType:'market',entityId:marketId},
  ...scope.ownedProducts.map((p:{id:string})=>({type:'owned_product' as const,entityType:'owned_product',entityId:p.id}))];
 const results=[];
 for(const target of targets){
  const job=repo.createResearchJob({...target,name:'OFFLINE C2 audit replay',createdBy:'offline-replay',input:{certificationRunId:shadowRun}});
  try{const done=workflow.run(job.id);results.push({entityId:target.entityId,status:done.status,insight:done.latestInsight?.insightType??null});}
  catch(error){assert.match(String(error),/RAW_SCHEMA_OR_REDACTION/);results.push({entityId:target.entityId,status:'failed',reason:'RAW_SCHEMA_OR_REDACTION'});}
 }
 assert.equal(results.filter(r=>r.reason==='RAW_SCHEMA_OR_REDACTION').length,3);
 const points=db.prepare(`SELECT s.id,s.date,s.estimated_sales,s.collected_at FROM product_snapshots s JOIN products p ON p.id=s.product_id WHERE p.asin='B0GYH8WT22'`).all();
 const independent=deriveSnapshotGrowth(points.map(p=>({id:String(p.id),date:String(p.date),value:p.estimated_sales as number|null,periodState:monthlyPeriodState(String(p.date),String(p.collected_at))})));
 assert.equal(independent?.growth,-75);
 assert.equal(go.verify().systemCertification,'FAIL');
 assert.equal(protectedState(db),originalCopy);assert.equal(protectedState(source),before);assert.equal(fileHash(),originalFileHash);assert.equal(networkAttempts,0);
 assert.ok(![fromRun,oldRun].includes(new GoLiveMigrationService(source).verify().sellerSpriteCriticalRunId??''));
 console.log(JSON.stringify({offlineReplayOnly:true,copyPath,shadowRun,results,independentClosedGrowth:independent?.growth,
  networkAttempts,businessDbUnchanged:true,originalRunsUnchanged:true,originalFileHash,systemCertification:go.verify().systemCertification},null,2));
}finally{db.close();source.close();}
