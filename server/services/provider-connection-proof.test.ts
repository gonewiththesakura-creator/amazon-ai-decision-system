import {afterEach,describe,expect,it} from 'vitest';
import {openDatabase,type AppDatabase} from '../database/database.js';
import {addVerifiedMcpCoverage} from '../test-utils/verified-mcp-coverage.js';
import {providerConnectionProof,recordExplicitConnectionProof} from './provider-connection-proof.js';
let db:AppDatabase;
afterEach(()=>db?.close());
describe('run-bound connection proof',()=>{
 it('requires immutable explicit test evidence, not a manually refreshed source timestamp',()=>{
  db=openDatabase(':memory:');const now=new Date().toISOString();
  db.prepare("UPDATE data_sources SET status='connected',last_sync_at=? WHERE id='source-sellersprite-mcp'").run(now);
  expect(providerConnectionProof(db,null)).toBeNull();
  recordExplicitConnectionProof(db,now);
  expect(providerConnectionProof(db,null)).toMatchObject({provider:'sellersprite',runId:null,collectedAt:now,status:'success',method:'explicit_connection_test'});
  expect(()=>db.exec("UPDATE provider_connection_proofs SET collected_at='2099-01-01'")).toThrow(/immutable/);
 });
 it('accepts only successful fresh unexpired same-run discovery without rewriting legacy status',()=>{
  db=openDatabase(':memory:');
  db.exec("INSERT INTO market_nodes(id,name,level,marketplace,source_type,status,created_at) VALUES('mkt-memory-foam','Synthetic',1,'US','import','active','2026-01-01')");
  addVerifiedMcpCoverage(db);
  const run=String(db.prepare('SELECT id FROM data_coverage_runs LIMIT 1').get()!.id);
  db.exec("UPDATE data_sources SET status='disconnected',last_sync_at='2026-01-01'");
  db.prepare("UPDATE mcp_call_logs SET completed_at=started_at WHERE sync_run_id=? AND capability='LIST_TOOLS'").run(run);
  expect(providerConnectionProof(db,run)).toMatchObject({runId:run,status:'success',provider:'sellersprite',method:'fresh_list_tools'});
  expect(providerConnectionProof(db,'different')).toBeNull();
  for(const change of ["cache_hit=1","status='failed'","completed_at='2026-01-01'","provider_id='other'"]) {
   db.prepare(`UPDATE mcp_call_logs SET ${change} WHERE sync_run_id=? AND capability='LIST_TOOLS'`).run(run);
   expect(providerConnectionProof(db,run)).toBeNull();
   db.prepare("UPDATE mcp_call_logs SET cache_hit=0,status='success',completed_at=started_at,provider_id='sellersprite' WHERE sync_run_id=? AND capability='LIST_TOOLS'").run(run);
  }
  expect(db.prepare("SELECT last_sync_at FROM data_sources WHERE id='source-sellersprite-mcp'").get()!.last_sync_at).toBe('2026-01-01');
  db.prepare("UPDATE data_sources SET status='connected',last_sync_at=? WHERE id='source-sellersprite-mcp'").run(new Date(Date.now()+1000).toISOString());
  expect(providerConnectionProof(db,null)).toBeNull();
 });
});
