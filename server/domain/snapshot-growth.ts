export interface DatedMetric {
  id: string;
  date: string;
  value: number | null | undefined;
}

type FiniteDatedMetric = DatedMetric & { value: number };

export interface SnapshotGrowthPair {
  latest: FiniteDatedMetric;
  baseline: FiniteDatedMetric;
  elapsedDays: number;
  growth: number;
}

/** Selects the closest valid baseline to 30 days, constrained to 21-45 days. */
export function deriveSnapshotGrowth(
  points: DatedMetric[],
  minimumDays = 21,
  maximumDays = 45,
): SnapshotGrowthPair | null {
  const dated = points
    .filter((point) => validDate(point.date))
    .sort((left, right) => right.date.localeCompare(left.date));
  const latestCandidate = dated[0];
  if (!latestCandidate || !isFiniteNumber(latestCandidate.value)) return null;
  const latest: FiniteDatedMetric = { ...latestCandidate, value: latestCandidate.value };
  const latestTime = Date.parse(`${latest.date}T00:00:00Z`);
  const candidates = dated.slice(1).filter(
    (point): point is FiniteDatedMetric => isFiniteNumber(point.value),
  ).map((point) => ({
    point: { ...point, value: point.value },
    elapsedDays: Math.round((latestTime - Date.parse(`${point.date}T00:00:00Z`)) / 86_400_000),
  })).filter(({ point, elapsedDays }) => (
    elapsedDays >= minimumDays && elapsedDays <= maximumDays && point.value > 0
  )).sort((left, right) => (
    Math.abs(left.elapsedDays - 30) - Math.abs(right.elapsedDays - 30)
      || right.point.date.localeCompare(left.point.date)
  ));
  const selected = candidates[0];
  if (!selected) return null;
  const growth = Math.round(((latest.value / selected.point.value) - 1) * 1_000) / 10;
  return { latest, baseline: selected.point, elapsedDays: selected.elapsedDays, growth };
}

function isFiniteNumber(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`));
}
