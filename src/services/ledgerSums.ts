/** Numbers for the ledger view: amounts read from note properties, and their totals. */

/** `1234.5`, `"1,234.50"`, `"¥1,234"`, `"-35 USD"` as numbers; anything without a single number is null. */
export function amountOf(raw: unknown): number | null {
    if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
    if (typeof raw !== 'string') return null;
    const match = /^[^\d-]*(-?[\d,]*\.?\d+)[^\d]*$/.exec(raw.trim());
    if (!match?.[1]) return null;
    const value = Number(match[1].replace(/,/g, ''));
    return Number.isFinite(value) ? value : null;
}

export interface Summary {
    total: number;
    count: number;
    average: number;
    /** Largest absolute amount, for scaling bars. */
    max: number;
}

export function summarize(amounts: number[]): Summary {
    const total = amounts.reduce((sum, value) => sum + value, 0);
    return {
        total,
        count: amounts.length,
        average: amounts.length ? total / amounts.length : 0,
        max: amounts.reduce((max, value) => Math.max(max, Math.abs(value)), 0)
    };
}

/** Width of a bar as a share of the largest amount, at least a sliver so small amounts stay visible. */
export function barShare(amount: number, max: number): number {
    if (!(max > 0) || amount === 0) return 0;
    return Math.max(Math.abs(amount) / max, 0.02);
}

/**
 * Formats in the report currency; an unknown currency code falls back to the number and the code.
 * With `whole`, no decimals are shown, for a list where every amount is a whole number.
 */
export function formatMoney(amount: number, currency: string, locale?: string, whole = false): string {
    const digits = whole ? { minimumFractionDigits: 0, maximumFractionDigits: 0 } : { maximumFractionDigits: 2 };
    try {
        return new Intl.NumberFormat(locale, { style: 'currency', currency, ...digits }).format(amount);
    } catch {
        return `${amount.toLocaleString(locale, digits)} ${currency}`;
    }
}
