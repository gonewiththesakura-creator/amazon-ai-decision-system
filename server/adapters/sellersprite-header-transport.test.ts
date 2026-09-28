import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import { SellerSpriteMcpClient, sanitizeMcpError } from './sellersprite-mcp-client.js';

afterEach(() => vi.unstubAllEnvs());

it('sends the secret only in the official header through the real SDK transport', async () => {
  const requests: Array<{url:string;secret:unknown;method:unknown}> = [];
  const server = createServer(async (request,response) => {
    let body = '';
    for await (const chunk of request) body += String(chunk);
    const rpc = body ? JSON.parse(body) as {id?:number;method?:string} : {};
    requests.push({url:request.url!, secret:request.headers['secret-key'], method:rpc.method});
    if (request.method === 'GET') { response.writeHead(405).end(); return; }
    if (rpc.id === undefined) { response.writeHead(202).end(); return; }
    response.writeHead(200, {'content-type':'application/json'});
    response.end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result:rpc.method==='initialize'
      ? {protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'offline-test',version:'1'}}
      : {tools:[]}}));
  });
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  vi.stubEnv('SELLERSPRITE_MCP_URL',`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
  vi.stubEnv('SELLERSPRITE_MCP_SECRET','header-only-test-canary');
  const client = new SellerSpriteMcpClient();
  try {
    expect(await client.listTools()).toEqual([]);
    expect(requests.some((entry)=>entry.method==='tools/list')).toBe(true);
    expect(requests.every((entry)=>entry.url==='/mcp' && entry.secret==='header-only-test-canary')).toBe(true);
    expect(sanitizeMcpError('headers: {"secret-key":"header-only-test-canary"}')).not.toContain('header-only-test-canary');
  } finally { await client.close(); server.close(); await once(server,'close'); }
});

it('rejects redirects without forwarding the credential to another origin', async () => {
  let leakedRequests = 0;
  const target = createServer((_request,response)=>{ leakedRequests++; response.writeHead(500).end(); });
  target.listen(0,'127.0.0.1'); await once(target,'listening');
  const server = createServer((_request,response)=>response.writeHead(307,{
    location:`http://127.0.0.1:${(target.address() as AddressInfo).port}/stolen`,
  }).end());
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  vi.stubEnv('SELLERSPRITE_MCP_URL',`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
  vi.stubEnv('SELLERSPRITE_MCP_SECRET','header-only-test-canary');
  const client = new SellerSpriteMcpClient();
  try {
    await expect(client.listTools()).rejects.toThrow();
    expect(leakedRequests).toBe(0);
  } finally {
    await client.close();
    server.close(); target.close();
    await Promise.all([once(server,'close'),once(target,'close')]);
  }
});
