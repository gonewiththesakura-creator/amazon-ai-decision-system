/** Zero-network persistence replay. Only a disposable database copy is writable. */
import {DatabaseSync,backup} from 'node:sqlite';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';import assert from 'node:assert/strict';
import http from 'node:http';import https from 'node:https';import net from 'node:net';import tls from 'node:tls';
import {migrate} from '../database/migrations.js';
import {transaction} from '../database/database.js';
import {SellerSpriteSyncService,type SellerSpriteSyncPort} from '../services/sellersprite-sync-service.js';
import {sellerSpriteAsinTrendSchema,sellerSpriteEnvelope,mcpCallToolResultSchema} from '../adapters/sellersprite-mcp-schemas.js';
import {mcpExecution} from '../adapters/mcp-policy.js';
import {productObservationPeriod} from '../domain/product-observation-period.js';
let networkAttempts=0;const deny=()=>{networkAttempts++;throw new Error('Network forbidden');};
globalThis.fetch=deny;http.request=deny;http.get=deny;https.request=deny;https.get=deny;net.connect=deny;net.createConnection=deny;tls.connect=deny;
const path=process.argv[2];if(!path)throw new Error('Business DB path required');
const hash=()=>createHash('sha256').update(readFileSync(path)).digest('hex'),beforeHash=hash();
const source=new DatabaseSync(path,{readOnly:true}),fromRun='f3f94995-07f5-4954-b0e6-f4474c53e489';
const copy=join(mkdtempSync(join(tmpdir(),'ys-c22-replay-')),'replay-only.db');await backup(source,copy);
const db=new DatabaseSync(copy);db.exec('PRAGMA foreign_keys=ON');
const existingTables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'schema_migrations' ORDER BY name").all();
const rowsDigest=()=>JSON.stringify(existingTables.map(t=>[t.name,db.prepare(`SELECT * FROM "${t.name}" ORDER BY rowid`).all()]));
const beforeMigration=rowsDigest();migrate(db);assert.equal(rowsDigest(),beforeMigration);
const protectedRuns=()=>JSON.stringify(db.prepare('SELECT * FROM data_tasks WHERE sync_run_id IN (?,?,?)').all(fromRun,'c74c905a-5bc6-486d-90cf-aebb24f554f5','787a8019-7bb0-4d0d-a3ef-a6c014eb4236'));
const protectedBefore=protectedRuns();
const ledger=db.prepare("SELECT l.*,c.response_json,c.created_at FROM mcp_call_logs l JOIN mcp_response_cache c ON c.cache_key=l.request_hash WHERE l.sync_run_id=? AND l.entity_id='B0GYH8WT22'").get(fromRun)!;
const original=sellerSpriteAsinTrendSchema.parse(sellerSpriteEnvelope(mcpCallToolResultSchema.parse(JSON.parse(String(ledger.response_json)))));
const product=db.prepare("SELECT id,asin,marketplace,market_node_id AS marketNodeId FROM products WHERE asin='B0GYH8WT22' AND marketplace='US'").get()!;
let data=structuredClone(original),at=String(ledger.created_at);
const port:SellerSpriteSyncPort={fetchAsinSalesTrend:async()=>({data,provenance:{source:'SellerSprite MCP',sourceType:'mcp' as const,collectedAt:at,period:'1M',isEstimated:true,confidence:0.85}}),
 fetchMarketResearchSummary:deny,fetchMarketStatistics:deny,fetchMarketConcentration:deny,discoverAsinCompetitors:deny};
const service=new SellerSpriteSyncService(db,port);
async function persist(){
 const id=`offline-replay-${randomUUID()}`;
 db.prepare(`INSERT INTO data_tasks(id,name,task_type,target,status,source,marketplace,created_at,sync_run_id)
  VALUES(?,'Synthetic C2.2 replay ONLY','offline_replay','B0GYH8WT22','running','offline replay','US',?,?)`).run(id,at,id);
 const prepared=await mcpExecution.run({syncMode:'force',remaining:0},()=>service['prepareProduct'](product as unknown as Parameters<typeof service['prepareProduct']>[0],id));
 const inserted=transaction(db,()=>service['persistProduct'](prepared,'product',id));
 return {id,inserted};
}
const september=()=>data.salesTrendPoints.find(p=>p.month==='2026-09')!;
assert.equal(september().parentUnitSales,30);
const first=await persist();const firstRows=JSON.stringify(db.prepare('SELECT * FROM product_snapshots WHERE sync_run_id=?').all(first.id));
at='2026-09-28T07:07:15.482Z';september().parentUnitSales=31;september().parentSalesRevenue=31*45.99;
const second=await persist();assert.equal(second.inserted,1);assert.equal((await persist()).inserted,0);
assert.equal(JSON.stringify(db.prepare('SELECT * FROM product_snapshots WHERE sync_run_id=?').all(first.id)),firstRows);
const mtd=db.prepare("SELECT * FROM product_snapshots WHERE product_id=? AND observation_date='2026-09-30' AND sync_run_id IN (?,?) ORDER BY collected_at").all(product.id!,first.id,second.id);
assert.deepEqual(mtd.map(r=>r.estimated_sales),[30,31]);
const facts=db.prepare("SELECT numeric_value,collected_at,sync_run_id FROM metric_facts WHERE entity_id=? AND observation_date='2026-09-30' AND metric_name='estimated_sales' AND sync_run_id IN (?,?) ORDER BY collected_at").all(product.id!,first.id,second.id);
assert.deepEqual(facts.map(f=>f.numeric_value),[30,31]);
data=structuredClone(original);data.salesTrendPoints.find(p=>p.month==='2026-08')!.parentUnitSales=8;at='2026-09-29T07:07:15.482Z';
await assert.rejects(persist,/不可变/);
assert.equal(protectedRuns(),protectedBefore);assert.equal(hash(),beforeHash);assert.equal(networkAttempts,0);
const report={copy,sourceUnchanged:true,migrationBusinessRowsUnchanged:true,oldRunsUnchanged:true,networkAttempts,
 sourceCallId:ledger.id,sourceRunId:fromRun,sourceRawHash:createHash('sha256').update(String(ledger.response_json)).digest('hex'),
 first,second,replayIdempotent:true,closedAugustMutationRejected:true,mtd:mtd.map(r=>({id:r.id,runId:r.sync_run_id,collectedAt:r.collected_at,sales:r.estimated_sales,...productObservationPeriod(String(r.date),String(r.collected_at),String(r.period))})),facts,
 disclaimer:'Synthetic acquisition 31 and replay runs exist only in this copy. Never Certification or Go Live evidence.'};
db.close();source.close();const out=JSON.stringify(report,null,2);if(process.argv[3])writeFileSync(process.argv[3],out+'\n');console.log(out);
