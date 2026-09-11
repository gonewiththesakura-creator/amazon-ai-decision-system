export function formatSignedPercent(value: number, digits = 1): string {
  return `${value > 0 ? '+' : ''}${value.toFixed(digits)}%`;
}

export function formatPercent(value: number, digits = 0): string {
  return `${value.toFixed(digits)}%`;
}

export function formatCurrency(value: number | null, currency = 'USD'): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatInteger(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(value);
}

export function formatDashboardDate(value: string, includeTime = false): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', includeTime
    ? { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }
    : { month: '2-digit', day: '2-digit' }).format(date);
}

export function indexedTrendDomain(values: Array<number | null | undefined>): [number, number] {
  const finite = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const minimum = Math.min(100, ...finite);
  const maximum = Math.max(100, ...finite);
  const padding = Math.max(2, (maximum - minimum) * 0.12);
  return [Math.max(0, Math.floor(minimum - padding)), Math.ceil(maximum + padding)];
}
