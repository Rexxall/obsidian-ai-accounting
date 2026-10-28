/** Monthly budgets and recurring expenses. Pure functions, so they can be tested without Obsidian. */

export interface RecurringExpense {
    id: string;
    description: string;
    category: string;
    amount: number;
    currency: string;
    paymentMethod: string;
    /** Day of the month it is charged; clamped to the last day of short months. */
    day: number;
    enabled: boolean;
}

export interface Budgets {
    total: number | null;
    categories: Record<string, number>;
}

export interface BudgetRow {
    category: string;
    spent: number;
    limit: number;
    ratio: number;
}

export const TOTAL_BUDGET_NAMES = ['总计', '合计', 'total'];

/** Same rule as the ledger statistics: the part before the first "/", ">" or ":" is the primary category. */
export function primaryCategory(category: string): string {
    return (category.split(/[/>:：]/)[0] || '其他支出').trim() || '其他支出';
}

/**
 * One budget per line, the amount last: "餐饮 30000". A line named 总计, 合计 or total
 * sets a budget for all spending. Lines without a positive amount are ignored.
 */
export function parseBudgets(text: string): Budgets {
    const budgets: Budgets = { total: null, categories: {} };
    for (const raw of (text || '').split('\n')) {
        const match = /^(.+?)[\s:：=]+([\d,，.]+)\s*$/.exec(raw.trim());
        if (!match) continue;
        const name = match[1]!.trim();
        const amount = Number(match[2]!.replace(/[,，]/g, ''));
        if (!name || !Number.isFinite(amount) || amount <= 0) continue;
        if (TOTAL_BUDGET_NAMES.includes(name.toLowerCase())) budgets.total = amount;
        else budgets.categories[primaryCategory(name)] = amount;
    }
    return budgets;
}

/** Spending in the given month (YYYY-MM, base currency) against each budget, the fullest first. */
export function budgetUsage(transactions: { date: string; category: string; baseAmount: number }[], month: string, budgets: Budgets): { rows: BudgetRow[]; total: BudgetRow | null } {
    const spent: Record<string, number> = {};
    let all = 0;
    for (const tx of transactions) {
        if (!tx.date.startsWith(month) || !Number.isFinite(tx.baseAmount)) continue;
        const primary = primaryCategory(tx.category);
        spent[primary] = (spent[primary] || 0) + tx.baseAmount;
        all += tx.baseAmount;
    }
    const rows = Object.entries(budgets.categories)
        .map(([category, limit]) => ({ category, limit, spent: spent[category] || 0, ratio: (spent[category] || 0) / limit }))
        .sort((a, b) => b.ratio - a.ratio);
    const total = budgets.total ? { category: '总计', limit: budgets.total, spent: all, ratio: all / budgets.total } : null;
    return { rows, total };
}

/** Stable per expense and month, so adding the same month twice writes nothing new. */
export function recurringRecordId(expense: RecurringExpense, month: string): string {
    return `rec-${expense.id.replace(/[^a-zA-Z0-9_-]/g, '')}-${month}`;
}

export function recurringDate(expense: RecurringExpense, month: string): string {
    const [year, mon] = month.split('-').map(Number) as [number, number];
    const last = new Date(Date.UTC(year, mon, 0)).getUTCDate();
    const day = Math.min(Math.max(1, Math.floor(expense.day) || 1), last);
    return `${month}-${String(day).padStart(2, '0')}`;
}

/** Drafts for the enabled recurring expenses of a month that are not in the ledger yet. */
export function recurringDrafts(expenses: RecurringExpense[], month: string, knownIds: Set<string>) {
    return expenses
        .filter(expense => expense.enabled && expense.amount > 0 && !knownIds.has(recurringRecordId(expense, month)))
        .map(expense => ({
            id: recurringRecordId(expense, month),
            date: recurringDate(expense, month),
            description: expense.description,
            category: expense.category,
            amount: expense.amount,
            currency: expense.currency,
            paymentMethod: expense.paymentMethod || '未分类'
        }));
}
