import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {deepDiff,trendBusinessProjection,assertTrendBusinessEquality} from '../adapters/asin-trend-audit.js';
import {scrubSecrets} from '../adapters/sellersprite-mcp-client.js';
import assert from 'node:assert/strict';
import {mcpCallToolResultSchema,sellerSpriteEnvelope,sellerSpriteAsinTrendSchema} from '../adapters/sellersprite-mcp-schemas.js';
import {requestKey} from '../adapters/mcp-policy.js';
const path=process.argv[2]??'data/real-chain-market-research-20260922.db';
const hash=()=>createHash('sha256').update(readFileSync(path)).digest('hex');
const before=hash(),db=new DatabaseSync(path,{readOnly:true});
const run='f3f94995-07f5-4954-b0e6-f4474c53e489';
const call=db.prepare("SELECT * FROM mcp_call_logs WHERE sync_run_id=? AND capability='ASIN_SALES_TREND' AND entity_id='B0GYH8WT22'").get(run)!;
const cache=db.prepare('SELECT * FROM mcp_response_cache WHERE cache_key=? AND provider_id=?').get(call.request_hash!,call.provider_id!)!;
const locals=db.prepare("SELECT * FROM mcp_local_observations WHERE capability='ASIN_SALES_TREND' AND scope_key=? ORDER BY collected_at DESC").all(requestKey(['US','B0GYH8WT22',null]));
const local=locals[0]!;
const capability=db.prepare("SELECT id,collected_at,capabilities_json FROM provider_capability_snapshots WHERE provider_id='sellersprite' AND sync_run_id=? ORDER BY collected_at DESC LIMIT 1").get(run)!;
const schemaHash=JSON.parse(String(capability.capabilities_json)).capabilitySchemaHashes.ASIN_SALES_TREND;
const verifierLocal=db.prepare(`SELECT request_key FROM mcp_local_observations WHERE capability='ASIN_SALES_TREND'
 AND scope_key=? AND schema_hash=? AND ABS(julianday(collected_at)-julianday(?))<5.0/86400 ORDER BY collected_at DESC LIMIT 1`)
 .get(local.scope_key!,schemaHash,cache.created_at!);
assert.equal(verifierLocal?.request_key,local.request_key);
const envelope=mcpCallToolResultSchema.parse(JSON.parse(String(cache.response_json)));
const raw=sellerSpriteAsinTrendSchema.parse(sellerSpriteEnvelope(envelope));
const normalized=sellerSpriteAsinTrendSchema.parse(JSON.parse(String(local.payload_json)));
const withoutPayload=(r:Record<string,unknown>)=>Object.fromEntries(Object.entries(r).filter(([k])=>!['response_json','payload_json'].includes(k)));
const differences=deepDiff(raw,normalized),businessDifferences=deepDiff(trendBusinessProjection(raw),trendBusinessProjection(normalized));
const text=envelope.content.find(c=>c.type==='text');
const dual=envelope.structuredContent&&text?.type==='text'?deepDiff(envelope.structuredContent,JSON.parse(text.text)):null;
function redactions(value:unknown,path='$'):string[]{
 if(value==='[REDACTED]')return [path];
 if(Array.isArray(value))return value.flatMap((v,i)=>redactions(v,`${path}[${i}]`));
 if(value&&typeof value==='object')return Object.entries(value).flatMap(([k,v])=>redactions(v,`${path}.${k}`));
 return [];
}
// Replay only saved data in memory. Neither successful acquisition nor Go Live evidence is manufactured.
assertTrendBusinessEquality(raw,normalized);
const ancillary=structuredClone(normalized);ancillary.asin.image='https://example.invalid/synthetic-replay';
assertTrendBusinessEquality(raw,ancillary);
const mutated=structuredClone(normalized);mutated.salesTrendPoints[0]!.price=999;
assert.throws(()=>assertTrendBusinessEquality(raw,mutated),/BUSINESS_MAPPING_MISMATCH/);
const failedRuns=db.prepare('SELECT id,status FROM data_tasks WHERE id IN (?,?,?)').all(run,'c74c905a-5bc6-486d-90cf-aebb24f554f5','787a8019-7bb0-4d0d-a3ef-a6c014eb4236');
assert.equal(failedRuns.length,3);assert.equal(failedRuns.find(r=>r.id===run)?.status,'failed');
db.close();
const report=JSON.stringify({run,call,cache:withoutPayload(cache),local:withoutPayload(local),localCandidates:locals.map(withoutPayload),
 fullSavedRawHash:createHash('sha256').update(String(cache.response_json)).digest('hex'),
 rawHash:requestKey(raw),normalizedHash:requestKey(normalized),firstDifference:differences[0]?.path??null,differences,
 businessProjection:trendBusinessProjection(raw),businessDifferences,hasStructuredContent:!!envelope.structuredContent,
 hasTextPayload:!!text,dualPayloadDifferences:dual,verifierSelectedSameLocal:true,
 redactedPaths:redactions(raw),scrubIdempotent:deepDiff(raw,scrubSecrets(raw)).length===0,acquisitionTaskRows:failedRuns,
 replay:{savedBusinessEquality:true,ancillaryDifferenceAccepted:true,businessMutationRejected:true},
 networkAttempts:0,sourceUnchanged:hash()===before},null,2);
if(process.argv[3])writeFileSync(process.argv[3],report+'\n');
console.log(report);
