/** Lossless table cells and explicit record identity; never deduplicate by amount. */
export function encodeCell(value: unknown): string {
    return (typeof value === 'string' || typeof value === 'number' ? String(value) : '').replace(/&/g, '&amp;').replace(/\|/g, '&#124;')
        .replace(/\r?\n/g, '&#10;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
export function decodeCell(value: string): string {
    return value.replace(/&#124;/g, '|').replace(/&#10;/g, '\n')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
export function recordId(row: string): string | undefined {
    return /<!-- aa:([a-zA-Z0-9_-]+) -->/.exec(row)?.[1];
}
export function tableCells(row: string): string[] {
    const plain = row.replace(/\s*<!-- aa:[a-zA-Z0-9_-]+ -->\s*$/, '').trim();
    if (!plain.startsWith('|') || !plain.endsWith('|')) return [];
    return plain.slice(1, -1).split(/(?<!\\)\|/).map(c => decodeCell(c.trim().replace(/\\\|/g, '|')));
}
export function newRecordId(): string { return crypto.randomUUID(); }
export function validDate(date: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
    const parsed = new Date(`${date}T12:00:00Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}
export function validateTransaction(tx: {date: string; amount: number; currency: string; rate?: number; baseAmount?: number}): void {
    if (!validDate(tx.date)) throw new Error('请填写有效日期（YYYY-MM-DD）。');
    if (!Number.isFinite(tx.amount) || tx.amount < 0) throw new Error('金额必须是有效的非负数。');
    if (!/^[A-Z]{3}$/.test(tx.currency)) throw new Error('请使用三位币种代码，例如 JPY、CNY。');
    if (tx.rate !== undefined && (!Number.isFinite(tx.rate) || tx.rate <= 0)) throw new Error('汇率必须大于零。');
    if (tx.baseAmount !== undefined && !Number.isFinite(tx.baseAmount)) throw new Error('本币金额无效。');
}
export function renderTransaction(tx: { id?: string; date: string; description: string; category: string; amount: number; currency: string; rate: number; baseAmount: number; paymentMethod?: string }): string {
    validateTransaction(tx);
    const id = tx.id || newRecordId();
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('交易标识无效。');
    return `| ${[tx.date, tx.description, tx.category, tx.amount.toFixed(2), tx.currency,
        tx.rate.toFixed(6), tx.baseAmount.toFixed(2), tx.paymentMethod || '未分类'].map(encodeCell).join(' | ')} | <!-- aa:${id} -->`;
}
export function locateTransaction(lines: string[], tx: {id?: string; sourceRow?: string; sourceLine?: number}): number {
    if (tx.id) {
        const matches = lines.map((line, i) => recordId(line) === tx.id ? i : -1).filter(i => i >= 0);
        if (matches.length !== 1) throw new Error('交易不存在或标识重复，请刷新账本。');
        const index = matches[0]!;
        if (tx.sourceRow && lines[index] !== tx.sourceRow) throw new Error('这笔交易已被修改，请刷新后重试。');
        return index;
    }
    if (tx.sourceLine !== undefined && lines[tx.sourceLine] === tx.sourceRow) return tx.sourceLine;
    const matches = lines.map((line, i) => line === tx.sourceRow ? i : -1).filter(i => i >= 0);
    if (matches.length !== 1) throw new Error('旧交易的位置已变化，无法唯一确认，请刷新后重试。');
    return matches[0]!;
}
