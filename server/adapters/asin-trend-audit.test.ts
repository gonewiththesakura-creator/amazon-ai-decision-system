import {describe,it,expect} from 'vitest';
import {assertTrendBusinessEquality,deepDiff,trendBusinessProjection} from './asin-trend-audit.js';
import {scrubSecrets} from './sellersprite-mcp-client.js';
import {requestKey} from './mcp-policy.js';
const fixture=()=>({asin:{asin:'B0GYH8WT22',marketplace:'US',parent:'B0GYH8WT22',image:'https://example.com/image'},salesTrendPoints:[
 {month:'2026-07',childUnitSales:null,parentUnitSales:28,parentSalesRevenue:1287.7201,price:45.99},
 {month:'2026-08',childUnitSales:null,parentUnitSales:7,parentSalesRevenue:321.93002,price:45.99}]});
describe('strict Trend business audit',()=>{
 it('reproduces the overstrict saved raw versus transient adapter hash failure',()=>{
  const transient=fixture(),saved=scrubSecrets(transient);
  expect(requestKey(saved)).not.toBe(requestKey(transient));
  expect(deepDiff(transient,saved)[0]?.path).toBe('$.asin.image');
  expect(()=>assertTrendBusinessEquality(saved,transient)).not.toThrow();
 });
 it.each(['month','asin','marketplace','childUnitSales','parentUnitSales','childSalesRevenue','parentSalesRevenue','price','rating','ratings','bsr','bsrRank','sellers'])('rejects changed point %s',field=>{
  const raw=fixture(),local=structuredClone(raw);
  Object.assign(local.salesTrendPoints[0]!,{[field]:'changed'});
  expect(()=>assertTrendBusinessEquality(raw,local)).toThrow('BUSINESS_MAPPING_MISMATCH');
 });
 it.each(['asin','marketplace','parent','dataAsin'])('rejects identity change %s',field=>{
  const raw=fixture(),local=structuredClone(raw);Object.assign(local.asin,{[field]:'changed'});
  expect(()=>assertTrendBusinessEquality(raw,local)).toThrow();
 });
 it('rejects omitted null, array order, count and numeric type changes',()=>{
  const raw=fixture();
  const mutations=[(v:ReturnType<typeof fixture>)=>{Reflect.deleteProperty(v.salesTrendPoints[0]!,'childUnitSales');},
   (v:ReturnType<typeof fixture>)=>{v.salesTrendPoints.reverse();},(v:ReturnType<typeof fixture>)=>{v.salesTrendPoints.pop();},
   (v:ReturnType<typeof fixture>)=>{Object.assign(v.salesTrendPoints[0]!,{price:'45.99'});}];
  for(const change of mutations){const local=structuredClone(raw);change(local);expect(()=>assertTrendBusinessEquality(raw,local)).toThrow();}
 });
 it('classifies missing, extra, type, value, length and order differences',()=>{
  expect(deepDiff({a:1,b:2,c:3},{a:'1',b:4,d:5}).map(d=>d.kind)).toEqual(['type mismatch','value mismatch','missing key','extra key']);
  expect(deepDiff([1,2],[2,1])[0]?.kind).toBe('array order mismatch');
  expect(deepDiff([1],[])[0]?.kind).toBe('array length mismatch');
  expect(trendBusinessProjection(fixture()).salesTrendPointsLength).toBe(2);
 });
});
