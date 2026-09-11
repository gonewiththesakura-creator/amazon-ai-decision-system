import { format, formatDistanceToNowStrict, isValid, parseISO } from 'date-fns';
import { zhCN } from 'date-fns/locale';

const integerFormatter = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 });
const decimalFormatter = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 });
const compactFormatter = new Intl.NumberFormat('zh-CN', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

function isDisplayNumber(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function formatInteger(value: number | null | undefined): string {
  if (!isDisplayNumber(value)) return '—';
  return integerFormatter.format(value);
}

export function formatDecimal(value: number | null | undefined): string {
  if (!isDisplayNumber(value)) return '—';
  return decimalFormatter.format(value);
}

export function formatCompact(value: number | null | undefined): string {
  if (!isDisplayNumber(value)) return '—';
  return compactFormatter.format(value);
}

export function formatCurrency(value: number | null | undefined, currency = 'USD', compact = false): string {
  if (!isDisplayNumber(value)) return '—';
  return new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency,
    notation: compact ? 'compact' : 'standard',
    maximumFractionDigits: compact ? 1 : 2,
  }).format(value);
}

export function formatPercent(value: number | null | undefined, showSign = true): string {
  if (!isDisplayNumber(value)) return '—';
  const prefix = showSign && value > 0 ? '+' : '';
  return `${prefix}${decimalFormatter.format(value)}%`;
}

export function formatConfidence(value: number | null | undefined): string {
  if (!isDisplayNumber(value)) return '—';
  const normalized = value <= 1 ? value * 100 : value;
  return `${Math.round(normalized)}%`;
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = parseISO(value);
  return isValid(parsed) ? parsed : null;
}

export function formatDate(value: string | null | undefined, pattern = 'MM-dd'): string {
  const parsed = parseDate(value);
  return parsed ? format(parsed, pattern) : '—';
}

export function formatDateTime(value: string | null | undefined): string {
  const parsed = parseDate(value);
  return parsed ? format(parsed, 'yyyy-MM-dd HH:mm') : '暂无记录';
}

export function formatFreshness(value: string | null | undefined): string {
  const parsed = parseDate(value);
  if (!parsed) return '尚未同步';
  return `${formatDistanceToNowStrict(parsed, { addSuffix: true, locale: zhCN })}更新`;
}

export function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}
