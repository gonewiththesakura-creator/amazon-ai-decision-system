import {monthlyPeriodState} from './snapshot-growth.js';
/** Recoverable for legacy rows without rewriting them. Acquisition time, never today's date. */
export function productObservationPeriod(date:string,collectedAt:string,period:string){
 const monthly=/^(1m|monthly|closed_month|current_mtd)$/i.test(period.trim());
 return {periodMonth:date.slice(0,7).replace('-',''),
  periodState:monthly?monthlyPeriodState(date,collectedAt):'closed_month' as const};
}
export function productObservationSuffix(date:string,collectedAt:string,period:string){
 const p=productObservationPeriod(date,collectedAt,period);
 return `|${p.periodState}|${p.periodMonth}${p.periodState==='current_mtd'?`|${collectedAt}`:''}`;
}
