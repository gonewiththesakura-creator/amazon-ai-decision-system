import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {GoLiveMigrationService} from '../services/go-live-migration-service.js';

export const GOLDEN_RUN = 'f9b38268-3558-49f0-b1ff-79b42542dcae';
/** Preserve scalar types and array order; object key order/prototypes are not database content. */
export function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value instanceof Uint8Array) return {sqliteBlob:Buffer.from(value).toString('hex')};
  if (value !== null && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,item])=>[key,canonicalValue(item)]),
  );
  if (typeof value==='bigint') return {sqliteInteger:value.toString()};
  return value;
}
const canonicalJSON=(value:unknown)=>JSON.stringify(canonicalValue(value));
const logicalHash=(value:unknown)=>createHash('sha256').update(canonicalJSON(value)).digest('hex');
export type DatabaseContent=Record<string,Record<string,unknown>[]>;
export function readDatabaseContent(db:DatabaseSync):DatabaseContent {
  const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
  return Object.fromEntries(tables.map(({name})=>{
    const statement=db.prepare(`SELECT * FROM "${String(name).replaceAll('"','""')}"`);
    const rows=statement.all() as Record<string,unknown>[];
    return [String(name),rows.sort((a,b)=>canonicalJSON(a).localeCompare(canonicalJSON(b)))];
  }));
}
function equalValues(actual:unknown,expected:unknown,label:string):void {
  // Do not attach database payloads to thrown errors or logs.
  try {assert.deepStrictEqual(canonicalValue(actual),canonicalValue(expected));}
  catch {throw new Error(`Release validation failed: ${label}`);}
}
export function validateContentDelta(before:DatabaseContent,after:DatabaseContent,mode:'activation'|'rollback') {
  equalValues(Object.keys(after).sort(),Object.keys(before).sort(),'table set');
  assert.equal(before.app_settings?.length,1,'pre-live app_settings must have one row');
  assert.equal(before.app_settings[0]!.id,1,'target app_settings.id');
  assert.equal(before.app_settings[0]!.mode,'empty','pre-live mode');
  assert.equal(after.app_settings?.length,1,'post app_settings must have one row');
  const expected=canonicalValue(before) as DatabaseContent;
  if(mode==='activation')expected.app_settings![0]!.mode='live';
  const tables:Record<string,{count:number;beforeHash:string;afterHash:string}>={};
  for(const table of Object.keys(before)) {
    assert.equal(after[table]!.length,before[table]!.length,`row count: ${table}`);
    equalValues(after[table],expected[table],`values: ${table}`);
    tables[table]={count:after[table]!.length,beforeHash:logicalHash(before[table]),afterHash:logicalHash(after[table])};
    if(table!=='app_settings'||mode==='rollback')assert.equal(tables[table]!.beforeHash,tables[table]!.afterHash,`logical hash: ${table}`);
  }
  return {allowedDelta:mode==='activation'?'app_settings.id=1 mode empty -> live':'none',tables,logicalHash:logicalHash(after)};
}
export interface ReleaseEvidence {goldenRunId:string|null;systemCertification:string;evidence:number;requiredEvidence:number;market:string;owned:string;roster:number;competitors:number;relations:number;mock:number;mcpCalls:number;usageEvents:number}
export function readReleaseEvidence(db:DatabaseSync):ReleaseEvidence {
  const v=new GoLiveMigrationService(db).verify();
  const count=(sql:string)=>Number(db.prepare(sql).get()!.n);
  return {goldenRunId:v.sellerSpriteCriticalRunId,systemCertification:v.systemCertification,evidence:v.verifiedEvidenceEntities,requiredEvidence:v.requiredEvidenceEntities,market:v.marketAnalysisReadiness,owned:v.ownedAnalysisReadiness,roster:v.ownedProductRosterCoverage.confirmed,competitors:v.confirmedDirectCompetitors,mock:v.mockObservations,
    relations:count("SELECT count(*) n FROM competitor_relations WHERE relation_type='direct'"),mcpCalls:count('SELECT count(*) n FROM mcp_call_logs'),usageEvents:count('SELECT count(*) n FROM mcp_usage_events')};
}
export function validateEvidence(before:ReleaseEvidence,after:ReleaseEvidence):void {
  for(const proof of [before,after])equalValues({...proof,mcpCalls:0,usageEvents:0},{goldenRunId:GOLDEN_RUN,systemCertification:'PASS',evidence:4,requiredEvidence:4,market:'LIMITED',owned:'LIMITED',roster:5,competitors:5,relations:9,mock:0,mcpCalls:0,usageEvents:0},'Golden evidence contract');
  assert.equal(after.mcpCalls,before.mcpCalls,'MCP call delta');assert.equal(after.usageEvents,before.usageEvents,'MCP usage delta');
}
export function validateReleaseDatabases(before:DatabaseSync,after:DatabaseSync,mode:'activation'|'rollback') {
  for(const db of [before,after]) {
    equalValues(db.prepare('PRAGMA integrity_check').all(),[{integrity_check:'ok'}],'integrity');
    equalValues(db.prepare('PRAGMA foreign_key_check').all(),[],'foreign keys');
  }
  equalValues(after.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all(),before.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all(),'schema');
  const delta=validateContentDelta(readDatabaseContent(before),readDatabaseContent(after),mode);
  const evidence=readReleaseEvidence(after);validateEvidence(readReleaseEvidence(before),evidence);
  return {status:'PASS',...delta,evidence,integrity:'ok',foreignKeys:0,MCPDelta:0};
}
// Read-only CLI. No activation, migration, network, cleanup, or automatic repair.
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const [mode,baseline,target]=process.argv.slice(2);
  assert.ok((mode==='activation'||mode==='rollback')&&baseline&&target,'Usage: tsx server/scripts/production-release-validator.ts activation|rollback BASELINE TARGET');
  const a=new DatabaseSync(baseline,{readOnly:true}),b=new DatabaseSync(target,{readOnly:true});
  try{console.log(JSON.stringify(validateReleaseDatabases(a,b,mode)));}finally{a.close();b.close();}
}
