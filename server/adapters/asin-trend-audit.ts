import {isDeepStrictEqual} from 'node:util';
import {sellerSpriteAsinTrendSchema} from './sellersprite-mcp-schemas.js';

export interface JsonDifference {path:string; kind:string; raw?:unknown; normalized?:unknown}
/** Diagnostic direction: raw is expected, normalized is actual. Never logs payloads. */
export function deepDiff(raw:unknown,normalized:unknown,path='$'):JsonDifference[]{
 if(isDeepStrictEqual(raw,normalized))return [];
 const type=(v:unknown)=>v===null?'null':Array.isArray(v)?'array':typeof v;
 if(type(raw)!==type(normalized))return [{path,kind:'type mismatch',raw,normalized}];
 if(Array.isArray(raw)&&Array.isArray(normalized)){
  const out:JsonDifference[]=raw.length===normalized.length?[]:[{path,kind:'array length mismatch',raw:raw.length,normalized:normalized.length}];
  if(raw.length===normalized.length&&raw.every(v=>normalized.some(n=>isDeepStrictEqual(v,n))))out.push({path,kind:'array order mismatch'});
  for(let i=0;i<Math.max(raw.length,normalized.length);i++)out.push(...deepDiff(raw[i],normalized[i],`${path}[${i}]`));
  return out;
 }
 if(raw&&normalized&&typeof raw==='object'&&typeof normalized==='object'){
  const a=raw as Record<string,unknown>,b=normalized as Record<string,unknown>;
  return [...new Set([...Object.keys(a),...Object.keys(b)])].sort().flatMap(key=>
   !Object.hasOwn(b,key)?[{path:`${path}.${key}`,kind:'missing key',raw:a[key]}]:
   !Object.hasOwn(a,key)?[{path:`${path}.${key}`,kind:'extra key',normalized:b[key]}]:deepDiff(a[key],b[key],`${path}.${key}`));
 }
 return [{path,kind:'value mismatch',raw,normalized}];
}
const pointFields=['month','asin','marketplace','childUnitSales','parentUnitSales','childSalesRevenue','parentSalesRevenue','price','rating','ratings','bsr','bsrRank','sellers'];
function pick(value:Record<string,unknown>,keys:string[]){return Object.fromEntries(keys.filter(k=>Object.hasOwn(value,k)).map(k=>[k,value[k]]));}
export function trendBusinessProjection(value:unknown){
 const data=sellerSpriteAsinTrendSchema.parse(value);
 return {asin:pick(data.asin,['asin','marketplace','parent','dataAsin']),
  salesTrendPointsLength:data.salesTrendPoints.length,salesTrendPoints:data.salesTrendPoints.map(p=>pick(p,pointFields))};
}
/** Retain raw hashes separately for provenance; strictly compare identity and every consumed numeric field. */
export function assertTrendBusinessEquality(raw:unknown,normalized:unknown):void {
 if(deepDiff(trendBusinessProjection(raw),trendBusinessProjection(normalized)).length)
  throw new Error('ASIN_TREND_BUSINESS_MAPPING_MISMATCH');
}
