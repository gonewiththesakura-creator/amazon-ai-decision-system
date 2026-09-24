import {describe,it,expect} from 'vitest';
import {openDatabase} from '../database/database.js';
import {confirmHumanOwnedRoster,ownedRosterState,sellerSpriteRosterScope} from './owned-roster-declaration.js';
import {SellerSpriteSyncService,type SellerSpriteSyncPort} from './sellersprite-sync-service.js';
import {GoLiveMigrationService} from './go-live-migration-service.js';
import {SellerSpriteMCPAdapter} from '../adapters/sellersprite-mcp-adapter.js';
import {addVerifiedMcpCoverage} from '../test-utils/verified-mcp-coverage.js';

describe('Human ownership and optional provider enrichment',()=>{
 it('confirms real ownership without provider title/node and plans only eligible products',async()=>{
  const db=openDatabase(':memory:');
  try{
   db.exec(`INSERT INTO market_nodes(id,name,level,marketplace,source_type,created_at,sellersprite_confirmed_node_path,status)
     VALUES ('main','Contour',1,'US','import','2026-09-01','1:2','active'),('lumbar','Lumbar Support Pillow / Body Positioner',1,'US','import','2026-09-01',NULL,'active')`);
   const products=['B0GYH8WT22','B0GY2TDLTZ','B0GY2WGTDM','B0HJWZM439','B0HJX1MGBF'].map((asin,i)=>({
    asin,sku:`SKU-${i}`,internalName:`Internal ${i}`,brand:'ELOVNOVA',title:i===3?null:'Actual supplied title',productType:'pillow',marketNodeId:i<3?'main':'lumbar',
    ...(i>=3?{enrichment:{status:i===3?'unavailable' as const:'pending' as const,providerStatus:i===3?'INVALID':null,evidence:{actor:'owner',reason:'confirmed ownership; no remote calls'}}}:{})}));
   expect(confirmHumanOwnedRoster(db,'US',products,{actor:'owner',statement:'These five ASINs are our actual US products'}))
    .toMatchObject({ownedRosterMatches:true,expectedOwnedProducts:5,ownedRosterDeclarationStatus:'confirmed'});
   expect(db.prepare("SELECT title FROM products WHERE asin='B0HJWZM439'").get()).toEqual({title:''});
   expect(db.prepare("SELECT sellersprite_confirmed_node_path FROM market_nodes WHERE id='lumbar'").get()).toEqual({sellersprite_confirmed_node_path:null});
   const sync=new SellerSpriteSyncService(db,{} as SellerSpriteSyncPort);
   const plan=sync.planCritical({marketId:'main',month:'202608',syncMode:'certification'});
   expect(plan).toMatchObject({ownedProductRosterCoverage:{total:5,ownedRosterMatches:true},ownedTrendCalls:3,competitorDiscoveryCalls:3,marketRemoteCalls:6});
   expect(plan.sellerSpriteEnrichmentCoverage.excluded).toHaveLength(2);
   expect(plan.entries.some(e=>e.target.includes('lumbar'))).toBe(false);
   await expect(new SellerSpriteMCPAdapter({database:db}).fetchAsinSalesTrend({marketplace:'US',asin:'B0HJWZM439'})).rejects.toThrow(/disabled/);
   await expect(new SellerSpriteMCPAdapter({database:db}).discoverAsinCompetitors({marketplace:'US',asin:'B0HJX1MGBF'})).rejects.toThrow(/disabled/);
   expect(new GoLiveMigrationService(db).verify()).toMatchObject({ownedProductRosterCoverage:{total:5,confirmed:5,passed:true},hasMinimumRealCoverage:false});
   db.exec("UPDATE product_provider_enrichment SET remote_enabled=1 WHERE status='pending'");
   expect(()=>sync.planCritical({marketId:'main',month:'202608',syncMode:'certification'})).toThrow(/节点/);
   db.exec("UPDATE products SET sku='changed' WHERE asin='B0HJWZM439'");
   expect(ownedRosterState(db,'US').ownedRosterMatches).toBe(false);
  }finally{db.close();}
 });
 it('requires the explicit exclusion scope in the certified run and keeps other Go Live gates',()=>{
  const db=openDatabase(':memory:');
  try{
   db.exec("INSERT INTO market_nodes(id,name,level,marketplace,source_type,created_at,status) VALUES ('main','Contour',1,'US','import','2026-09-01','active')");
   addVerifiedMcpCoverage(db,'main','owned');
   expect(new GoLiveMigrationService(db).verify().hasMinimumRealCoverage).toBe(true);
   db.exec(`INSERT INTO market_nodes(id,name,level,marketplace,source_type,created_at,status) VALUES ('lumbar','Internal',1,'US','import','2026-09-01','active');
    INSERT INTO products(id,asin,sku,brand,title,image_url,marketplace,product_type,is_owned,market_node_id,source_type,created_at)
    VALUES ('excluded','B0HJWZM439','LUMBAR','ELOVNOVA','','','US','pillow',1,'lumbar','import','2026-09-01');
    INSERT INTO product_provider_enrichment VALUES ('excluded','unavailable','INVALID',0,NULL,NULL,'{"actor":"owner","reason":"unavailable"}','2026-09-24');`);
   // Reconfirm all actual owned identities with explicit human evidence, without remote enrichment.
   const p=db.prepare("SELECT asin,sku FROM products WHERE id='owned'").get()!;
   confirmHumanOwnedRoster(db,'US',[
    {asin:String(p.asin),sku:String(p.sku),internalName:'Owned',brand:'Test',title:'Test',productType:'pillow',marketNodeId:'main'},
    {asin:'B0HJWZM439',sku:'LUMBAR',internalName:'Lumbar',brand:'ELOVNOVA',title:null,productType:'pillow',marketNodeId:'lumbar'}
   ],{actor:'owner',statement:'Both products are real owned products'});
   expect(new GoLiveMigrationService(db).verify().hasMinimumRealCoverage).toBe(false);
   const run=db.prepare("SELECT id,coverage_json FROM data_coverage_runs WHERE run_type='critical_sync'").get()!;
   db.prepare('UPDATE data_coverage_runs SET coverage_json=? WHERE id=?').run(JSON.stringify({...JSON.parse(String(run.coverage_json)),rosterScopeDigest:sellerSpriteRosterScope(db,'US').digest}),run.id);
   expect(new GoLiveMigrationService(db).verify()).toMatchObject({hasMinimumRealCoverage:true,ownedProductRosterCoverage:{total:2,confirmed:2},sellerSpriteEnrichmentCoverage:{required:1,covered:1}});
   db.exec("UPDATE product_provider_enrichment SET evidence_json='{}'");
   expect(new GoLiveMigrationService(db).verify().hasMinimumRealCoverage).toBe(false);
  }finally{db.close();}
 });
});
