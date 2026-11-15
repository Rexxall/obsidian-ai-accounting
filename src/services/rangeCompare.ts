/** One bar of the trend chart: a day (YYYY-MM-DD) or a month (YYYY-MM) and what was spent in it. */
export interface TrendPoint {
    key: string;
    value: number;
}

export interface RangeComparison {
    /** Earlier and later point, whichever order they were picked in. */
    from: TrendPoint;
    to: TrendPoint;
    delta: number;
    /** Change against the earlier value; null when the earlier value is 0, where a percentage means nothing. */
    pct: number | null;
    /** Spent from the earlier point to the later one, both included. */
    sum: number;
    /** Days or months from the earlier point to the later one, both included. */
    count: number;
}

/** Compares two bars by index. Null when either index is outside the series. */
export function compareRange(points: TrendPoint[], a: number, b: number): RangeComparison | null {
    if (!Number.isInteger(a) || !Number.isInteger(b)) return null;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const from = points[lo];
    const to = points[hi];
    if (lo < 0 || !from || !to) return null;
    let sum = 0;
    for (let i = lo; i <= hi; i++) sum += points[i]?.value ?? 0;
    const delta = to.value - from.value;
    return { from, to, delta, pct: from.value === 0 ? null : (delta / Math.abs(from.value)) * 100, sum, count: hi - lo + 1 };
}

/**
 * Every day of a month (YYYY-MM), with what was spent on it; days without entries are 0. For the
 * current month the series stops at today (`today` as YYYY-MM-DD), so days still to come do not read as 0.
 */
export function dailySeries(month: string, totals: Record<string, number>, today?: string): TrendPoint[] {
    const [y, m] = month.split('-').map(part => parseInt(part, 10));
    if (!y || !m) return [];
    const inMonth = today?.startsWith(`${month}-`) ? parseInt(today.slice(8), 10) : NaN;
    const days = Number.isFinite(inMonth) && inMonth > 0 ? inMonth : new Date(y, m, 0).getDate();
    return Array.from({ length: days }, (_, i) => {
        const key = `${month}-${String(i + 1).padStart(2, '0')}`;
        return { key, value: totals[key] ?? 0 };
    });
}

/** Every month from the first to the last that has entries, gaps filled with 0, so a range spans real time. */
export function monthlySeries(totals: Record<string, number>): TrendPoint[] {
    const keys = Object.keys(totals).filter(k => /^\d{4}-\d{2}$/.test(k)).sort();
    const first = keys[0];
    const last = keys[keys.length - 1];
    if (!first || !last) return [];
    const out: TrendPoint[] = [];
    let [y, m] = first.split('-').map(part => parseInt(part, 10)) as [number, number];
    // A ledger spanning centuries is a typo in a date; stop at 1200 months rather than freeze.
    for (let guard = 0; guard < 1200; guard++) {
        const key = `${y}-${String(m).padStart(2, '0')}`;
        out.push({ key, value: totals[key] ?? 0 });
        if (key === last) break;
        m++;
        if (m > 12) { m = 1; y++; }
    }
    return out;
}

/** "+12.3%" style, with a real minus sign; very large changes drop the decimal. */
export function formatPct(pct: number): string {
    const sign = pct > 0 ? '+' : pct < 0 ? '−' : '';
    const abs = Math.abs(pct);
    return `${sign}${abs >= 1000 ? Math.round(abs).toLocaleString('en') : abs.toFixed(1)}%`;
}
