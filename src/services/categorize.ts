/**
 * Category suggestions for imported rows. Your own ledger comes first: a shop you have filed before gets the same
 * category again, without asking anyone. Only rows that match nothing go to an AI service, and only their description,
 * amount and the statement's own category hint are sent.
 */

export interface Filed {
    description: string;
    category: string;
}

export type Origin = 'history' | 'ai' | 'none';

/** Lower case, full-width folded, without digits, punctuation, spaces or order numbers, so "FamilyMart 新宿店 #12" and "familymart新宿店" meet. */
export function merchantKey(text: string): string {
    return text.normalize('NFKC').toLowerCase().replace(/[\d\s\p{P}\p{S}]+/gu, '');
}

export interface Memory {
    exact: Map<string, string>;
    /** Keys long enough to look for inside other descriptions, longest first. */
    partial: [string, string][];
    categories: string[];
}

/** The category used most often for each description; ties go to the latest. */
export function learn(history: Filed[]): Memory {
    const counts = new Map<string, Map<string, number>>();
    const categories = new Set<string>();
    for (const { description, category } of history) {
        if (!category) continue;
        categories.add(category);
        const key = merchantKey(description);
        if (key.length < 2) continue;
        const forKey = counts.get(key) ?? new Map<string, number>();
        forKey.set(category, (forKey.get(category) ?? 0) + 1);
        counts.set(key, forKey);
    }
    const exact = new Map<string, string>();
    for (const [key, forKey] of counts) {
        let best = '';
        let most = 0;
        for (const [category, n] of forKey) if (n >= most) { best = category; most = n; }
        exact.set(key, best);
    }
    const partial = [...exact].filter(([key]) => key.length >= 4).sort((a, b) => b[0].length - a[0].length);
    return { exact, partial, categories: [...categories].sort() };
}

/** The category this description was filed under before, exactly or as part of a longer description; null if never. */
export function fromHistory(description: string, memory: Memory): string | null {
    const key = merchantKey(description);
    if (!key) return null;
    const exact = memory.exact.get(key);
    if (exact) return exact;
    for (const [known, category] of memory.partial) {
        if (key.includes(known) || (key.length >= 4 && known.includes(key))) return category;
    }
    return null;
}

/**
 * Reads the AI reply: a JSON array of {i, category}. Only indexes that were asked about and short plain-text
 * categories are kept, written as "Primary / Secondary".
 */
export function readCategoryReply(items: unknown[], asked: Set<number>): Map<number, string> {
    const out = new Map<number, string>();
    for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        const { i, category } = item as { i?: unknown; category?: unknown };
        const index = typeof i === 'number' ? i : typeof i === 'string' ? Number(i) : NaN;
        if (!asked.has(index) || typeof category !== 'string') continue;
        const text = category.replace(/\s*\/\s*/g, ' / ').replace(/[\r\n]+/g, ' ').trim();
        if (text && text.length <= 40) out.set(index, text);
    }
    return out;
}
