import { DatabaseSync, backup } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openDatabase } from '../database/database.js';
import { LocalObservationResolver } from '../services/local-observation-resolver.js';
import { SellerSpriteSyncService, type SellerSpriteSyncPort } from '../services/sellersprite-sync-service.js';
import { McpBudgetManager } from '../adapters/mcp-policy.js';

// Inspect a consistent isolated copy. Never migrate or mutate the supplied business DB.
const sourcePath = process.argv[2];
if (!sourcePath) throw new Error('Usage: tsx server/scripts/quota-report.ts <database>');
const temporary = mkdtempSync(join(tmpdir(), 'ys-quota-report-'));
const source = new DatabaseSync(resolve(sourcePath), {readOnly:true});
try { await backup(source, join(temporary,'report.db')); } finally { source.close(); }
const database = openDatabase(join(temporary,'report.db'));
try {
  const resolver = new LocalObservationResolver(database);
  const markets = database.prepare("SELECT id FROM market_nodes WHERE status='active'").all();
  const reusable = database.prepare("SELECT market_node_id, observation_date FROM market_snapshots WHERE source_type='mcp'").all()
    .filter((row) => resolver.market(String(row.market_node_id),String(row.observation_date)));
  const products = database.prepare("SELECT id FROM products WHERE source_type<>'mock' AND status='active' AND is_parent=0").all();
  const productPoints = products.reduce((n,row) => n+resolver.product(String(row.id)).length,0);
  const sync = new SellerSpriteSyncService(database, {} as SellerSpriteSyncPort);
  const settings = database.prepare('SELECT default_market_id FROM app_settings WHERE id=1').get();
  const marketId = String(settings?.default_market_id ?? markets[0]?.id);
  const month = new Date().toISOString().slice(0,7).replace('-','');
  const plans = ['incremental','certification'].map((mode) => {
    const plan = sync.planCritical({marketId,month,syncMode:mode as 'incremental'|'certification'});
    return {mode, estimatedRemoteCalls:plan.estimatedRemoteCalls, maximumRemoteCalls:plan.maximumRemoteCalls,
      localReuse:plan.localReuse, blockers:plan.blockers,
      skipped:plan.entries.filter((entry) => entry.remote===0).map((entry)=>entry.reason)};
  });
  const counts = Object.fromEntries(['market_snapshots','product_snapshots','metric_facts','competitor_candidates']
    .map((table)=>[table,(database.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE source_type='mcp'`).get() as {n:number}).n]));
  const quota = new McpBudgetManager(database).summary();
  console.log(JSON.stringify({counts,reusableMarketSnapshots:reusable.length,reusableProductPoints:productPoints,
    stableMonths:[...new Set(reusable.map((r)=>String(r.observation_date).slice(0,7)).filter((period)=>period<new Date().toISOString().slice(0,7)))],
    plans,quota},null,2));
} finally { database.close(); rmSync(temporary,{recursive:true,force:true}); }
