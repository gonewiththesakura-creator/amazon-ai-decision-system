import {describe,it,expect} from 'vitest';
import {scrubSecrets,sanitizeMcpError} from './sellersprite-mcp-client.js';
describe('whole-key secret scrubbing',()=>{
 it('retains trend and ordinary endPoints through nested arrays and JSON envelopes',()=>{
  const business={salesTrendPoints:[{month:'202607',childUnitSales:28,nested:[{endPoints:[1,2]}]}],endPoints:'business',tokenCount:12};
  expect(scrubSecrets(business)).toEqual(business);
  expect(JSON.parse(String(scrubSecrets(JSON.stringify(business))))).toEqual(business);
 });
 it('redacts credential and transport keys at every nesting level',()=>{
  const keys=['endpoint','headers','Authorization','secret','apiKey','secret-key','x-api-key','access_token','clientSecret'];
  for(const key of keys) expect(JSON.stringify(scrubSecrets({data:[{[key]:'sensitive-value'}]}))).not.toContain('sensitive-value');
 });
 it('sanitizes error and log messages and cached JSON strings',()=>{
  for(const message of ['Authorization: Bearer sensitive-value','secret-key=sensitive-value','apiKey=sensitive-value',
   'https://example.test/?secret=sensitive-value','{"headers":{"Authorization":"sensitive-value"}}']) {
   expect(String(scrubSecrets(message))).not.toContain('sensitive-value');
   expect(sanitizeMcpError(new Error(message))).not.toContain('sensitive-value');
  }
 });
});
