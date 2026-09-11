export interface PastedReviewInput {
  reviewId: string;
  sourceRecordId: string;
  productId: string;
  text: string;
  rating?: number;
  date?: string;
  source: 'Operator pasted review';
}

export function parsePastedReviews(value: string): PastedReviewInput[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  const raw = trimmed.startsWith('[') ? parseJsonReviews(trimmed) : parseLineReviews(trimmed);
  const ids = new Set<string>();
  return raw.map((item, index) => {
    if (!isRecord(item)) throw new Error(`评论 ${index + 1} 必须是对象。`);
    const productId = requiredText(item.productId ?? item.asin, `评论 ${index + 1} productId`);
    const text = requiredText(item.text ?? item.reviewText, `评论 ${index + 1} text`);
    const reviewId = optionalText(item.reviewId ?? item.sourceRecordId ?? item.id)
      ?? `operator-paste-${index + 1}`;
    if (ids.has(reviewId)) throw new Error(`评论来源 ID ${reviewId} 重复。`);
    ids.add(reviewId);
    const rating = optionalRating(item.rating, index);
    const date = optionalText(item.date);
    return {
      reviewId,
      sourceRecordId: reviewId,
      productId,
      text,
      ...(rating === undefined ? {} : { rating }),
      ...(date === undefined ? {} : { date }),
      source: 'Operator pasted review' as const,
    };
  });
}

function parseJsonReviews(value: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('评论 JSON 无法解析，请检查引号与逗号。');
  }
  if (!Array.isArray(parsed)) throw new Error('评论 JSON 必须是数组。');
  return parsed;
}

function parseLineReviews(value: string): unknown[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line, index) => {
    const separator = line.includes('\t') ? '\t' : '|';
    const [productId, ...textParts] = line.split(separator);
    const text = textParts.join(separator).trim();
    if (!productId?.trim() || !text) {
      throw new Error(`评论第 ${index + 1} 行应为 ProductId | ReviewText。`);
    }
    return { productId: productId.trim(), text, reviewId: `operator-paste-${index + 1}` };
  });
}

function optionalRating(value: unknown, index: number): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 5) {
    throw new Error(`评论 ${index + 1} rating 必须是 0 到 5 之间的数字。`);
  }
  return value;
}

function requiredText(value: unknown, label: string): string {
  const text = optionalText(value);
  if (!text) throw new Error(`${label} 不能为空。`);
  return text;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
