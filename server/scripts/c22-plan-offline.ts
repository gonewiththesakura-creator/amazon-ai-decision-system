/** Preview only: plan rows/tokens are confined to a disposable copy, never the business DB. */
import {DatabaseSync,backup} from 'node:sqlite';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';import assert from 'node:assert/strict';
import {migrate} from '../database/migrations.js';
import {SellerSpriteSyncService,type SellerSpriteSyncPort} from '../services/sellersprite-sync-service.js';
let networkAttempts=0;const deny=()=>{networkAttempts++;throw new Error('Offline preview only');};globalThis.fetch=deny;
const path=process.argv[2];if(!path)throw new Error('Business DB required');
const hash=()=>createHash('sha256').update(readFileSync(path)).digest('hex'),before=hash();
const source=new DatabaseSync(path,{readOnly:true}),copy=join(mkdtempSync(join(tmpdir(),'ys-c22-plan-')),'preview.db');
await backup(source,copy);const db=new DatabaseSync(copy);migrate(db);
const service=new SellerSpriteSyncService(db,new Proxy({} as SellerSpriteSyncPort,{get:()=>deny}));
const marketId=String(db.prepare('SELECT default_market_id FROM app_settings WHERE id=1').get()!.default_market_id);
const {id:copyOnlyId,...plan}=service.planCritical({marketId,month:'202608',syncMode:'certification'});
assert.ok(copyOnlyId);
const relations=db.prepare(`SELECT o.asin AS owned,c.asin AS competitor FROM competitor_relations r
 JOIN products o ON o.id=r.owned_product_id JOIN products c ON c.id=r.competitor_product_id
 WHERE r.relation_type='direct' ORDER BY o.asin,c.asin`).all();
assert.equal(hash(),before);assert.equal(networkAttempts,0);
const report={status:'AWAITING_APPROVAL_NOT_EXECUTED',productionSchemaVersion:source.prepare('SELECT max(version) version FROM schema_migrations').get()?.version,
 requiredSchemaVersion:38,formalTokenCreated:false,plan,relations,distinctCompetitors:[...new Set(relations.map(r=>r.competitor))],
 sourceUnchanged:true,networkAttempts,worstCaseRemaining:Math.max(0,plan.estimatedRemaining-plan.maximumRemoteCalls),
 preparation:['Independent backup and integrity/foreign-key checks','Apply V38 schema only after approval; no business backfill','Revalidate scope and reuse, then create a fresh formal token after approval'],
 exclusions:['Lumbar remote disabled','No Market remote','No additional Connection Test','No old-run retry','No Cleanup/Live/Merge/stash restore']};
db.close();source.close();const output=JSON.stringify(report,null,2);if(process.argv[3])writeFileSync(process.argv[3],output+'\n');console.log(output);
