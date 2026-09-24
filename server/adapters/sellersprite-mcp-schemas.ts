import { z } from 'zod';

export const mcpToolSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  inputSchema: z.object({
    type: z.literal('object'),
    properties: z.record(z.string(), z.unknown()).optional(),
    required: z.array(z.string()).optional(),
  }).passthrough(),
}).passthrough();

export const mcpListToolsResultSchema = z.object({
  tools: z.array(mcpToolSchema),
  nextCursor: z.string().optional(),
}).passthrough();

const mcpContentSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }).passthrough(),
  z.object({ type: z.literal('image'), data: z.string(), mimeType: z.string() }).passthrough(),
  z.object({ type: z.literal('audio'), data: z.string(), mimeType: z.string() }).passthrough(),
  z.object({ type: z.literal('resource'), resource: z.object({ uri: z.string() }).passthrough() }).passthrough(),
  z.object({ type: z.literal('resource_link'), uri: z.string(), name: z.string() }).passthrough(),
]);

export const mcpCallToolResultSchema = z.object({
  content: z.array(mcpContentSchema),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
  isError: z.boolean().optional(),
}).passthrough();

export type McpToolDefinition = z.infer<typeof mcpToolSchema>;
export type McpCallToolResult = z.infer<typeof mcpCallToolResultSchema>;

export const sellerSpriteObjectSchema = z.record(z.string(), z.unknown());

export const sellerSpriteMarketStatisticsSchema = z.object({
  marketplace: z.string().trim().min(1),
  nodeIdPath: z.string().trim().min(1),
}).passthrough();

export const sellerSpriteAsinTrendSchema = z.object({
  asin: z.object({
    asin: z.string().trim().min(1),
    marketplace: z.string().trim().min(1),
  }).passthrough(),
  salesTrendPoints: z.array(sellerSpriteObjectSchema),
}).passthrough();

export const sellerSpriteAsinIdentitySchema = z.object({
  asin: z.string().trim().min(1),
  marketplace: z.string().trim().min(1),
  title: z.string().nullable().optional(),
  brand: z.string().nullable().optional(),
  parent: z.string().nullable().optional(),
  nodeIdPath: z.string().nullable().optional(),
}).passthrough();

export const sellerSpriteMarketResearchSchema = z.object({
  items: z.array(z.object({
    marketplace: z.string().trim().min(1),
    nodeIdPath: z.string().trim().min(1),
  }).passthrough()),
  total: z.number().optional(),
}).passthrough();

export function mcpJsonPayload(result: McpCallToolResult): unknown {
  if (result.structuredContent) return result.structuredContent;
  const text = result.content.find((item) => item.type === 'text');
  if (!text || text.type !== 'text') return null;
  try { return JSON.parse(text.text) as unknown; }
  catch { return null; }
}

export function sellerSpriteEnvelope(result: McpCallToolResult): unknown {
  const payload = mcpJsonPayload(result);
  const envelope = z.object({ code: z.string(), data: z.unknown() }).passthrough().safeParse(payload);
  if (!envelope.success) throw new Error('Invalid SellerSprite response envelope');
  if (envelope.data.code !== 'OK') throw new Error('SellerSprite rejected the tool request');
  return envelope.data.data;
}
