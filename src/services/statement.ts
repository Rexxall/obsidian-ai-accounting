/**
 * Reading bank and payment-app statements (CSV) into rows, entirely on this device: dates and amounts come from the
 * file itself and never from an AI service. Alipay, WeChat Pay, Japanese bank and card exports and plain
 * Date / Description / Amount files are recognised by their column names.
 */

export interface StatementRow {
    date: string;
    description: string;
    /** Spending is positive, a refund negative. */
    amount: number;
    currency: string;
    paymentMethod: string;
    /** The statement's own category (Alipay has one), passed on as a hint. */
    hint: string;
}

export interface Statement {
    rows: StatementRow[];
    /** Income rows, left out because the ledger records spending. */
    income: number;
    /** Rows that were closed, failed, or had no date or amount. */
    skipped: number;
    /** Which kind of file it looked like, for the review title. */
    source: 'alipay' | 'wechat' | 'bank' | 'card' | 'generic';
}

/** UTF-8 first; Alipay and older WeChat exports are GB18030, Japanese banks Shift_JIS. */
export function decodeStatement(bytes: ArrayBuffer | Uint8Array): string {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    for (const encoding of ['utf-8', 'gb18030', 'shift_jis']) {
        try {
            const text = new TextDecoder(encoding, { fatal: true }).decode(data);
            return text.replace(/^\uFEFF/, '');
        } catch {
            // try the next encoding
        }
    }
    return new TextDecoder('utf-8').decode(data).replace(/^\uFEFF/, '');
}

/** RFC 4180 CSV: quoted fields with commas, doubled quotes and line breaks; tab-separated files too. */
export function parseCsv(text: string): string[][] {
    const firstLine = text.slice(0, text.indexOf('\n') === -1 ? undefined : text.indexOf('\n'));
    const sep = (firstLine.match(/\t/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? '\t' : ',';
    const rows: string[][] = [];
    let row: string[] = [];
    let field = '';
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quoted) {
            if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
            else if (ch === '"') quoted = false;
            else field += ch;
        } else if (ch === '"' && field.trim() === '') { quoted = true; field = ''; }
        else if (ch === sep) { row.push(field.trim()); field = ''; }
        else if (ch === '\n' || ch === '\r') {
            if (ch === '\r' && text[i + 1] === '\n') i++;
            row.push(field.trim());
            rows.push(row);
            row = [];
            field = '';
        } else field += ch;
    }
    if (field !== '' || row.length) { row.push(field.trim()); rows.push(row); }
    return rows.filter(r => r.some(cell => cell !== ''));
}

const COLUMNS = {
    date: ['交易时间', '交易创建时间', '交易日期', '记账日期', '入账日期', '日期', '年月日', '取引日', '利用日', 'ご利用日', '日付', '取扱日', 'date', 'transaction date', 'posted date', 'posting date'],
    counterparty: ['交易对方', 'payee', 'merchant', 'counterparty'],
    item: ['商品说明', '商品', '摘要', '内容', 'お取り扱い内容', 'お取引内容', '取引内容', '利用店名・商品名', 'ご利用店名', '利用店名', 'ご利用先', 'description', 'details', 'memo'],
    amount: ['金额', '金额(元)', '金额（元）', '交易金额', '利用金額', 'ご利用金額', 'ご利用金額（円）', '支払総額', 'amount'],
    debit: ['支出', '支出金额', 'お引出し', 'お引き出し', '出金', '出金金額', '引出額', '支払金額', 'debit', 'withdrawal', 'withdrawals'],
    credit: ['收入', '收入金额', 'お預入れ', 'お預け入れ', '入金', '入金金額', '預入額', 'credit', 'deposit', 'deposits'],
    direction: ['收/支', '收支', '收/支/其他', 'type'],
    currency: ['币种', '币种代码', '通貨', 'currency'],
    method: ['收/付款方式', '支付方式', '支払方法', '支払い方法', 'payment method', 'account'],
    status: ['交易状态', '当前状态', 'status'],
    hint: ['交易分类', 'category']
};
type Column = keyof typeof COLUMNS;

const clean = (cell: string) => cell.replace(/\s+/g, '').toLowerCase();

/** Index of each known column in a header row; -1 when absent. */
export function mapColumns(header: string[]): Record<Column, number> {
    const cells = header.map(clean);
    const map = {} as Record<Column, number>;
    for (const key of Object.keys(COLUMNS) as Column[]) {
        const names = COLUMNS[key].map(clean);
        map[key] = cells.findIndex(cell => names.includes(cell));
    }
    // "支出" and "收入" are amount columns in bank files but values of 收/支 in Alipay and WeChat.
    if (map.direction !== -1) { map.debit = -1; map.credit = -1; }
    return map;
}

/** The header is the first row with a date column and some amount column; Alipay and WeChat put a preamble above it. */
function findHeader(rows: string[][]): number {
    return rows.findIndex(row => {
        const map = mapColumns(row);
        return map.date !== -1 && (map.amount !== -1 || map.debit !== -1);
    });
}

/** `2026/11/03 12:30:11`, `2026-11-3`, `2026年11月3日`, `20261103`, `26/11/03` → `2026-11-03`; otherwise ''. */
export function normalizeDate(text: string): string {
    const t = text.trim();
    let m = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/.exec(t) ?? /^(\d{4})(\d{2})(\d{2})(?:\D|$)/.exec(t);
    if (!m) {
        const short = /^(\d{2})[/.](\d{1,2})[/.](\d{1,2})(?:\D|$)/.exec(t);
        if (short) m = ['', `20${short[1]}`, short[2], short[3]] as unknown as RegExpExecArray;
    }
    if (!m) return '';
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const date = new Date(y, mo - 1, d);
    if (date.getMonth() !== mo - 1 || date.getDate() !== d) return '';
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** `¥1,234.50`, `-1,500`, `(35.00)`, `１２００円` → number; '' or text → null. */
export function parseAmount(text: string): number | null {
    let t = text.normalize('NFKC').trim();
    if (!t || t === '-' || t === '/') return null;
    const negative = /^\(.*\)$/.test(t) || /^[-−▲△]/.test(t);
    t = t.replace(/[^\d.]/g, '');
    if (!t || !/\d/.test(t)) return null;
    const value = Number(t);
    if (!Number.isFinite(value)) return null;
    return negative ? -value : value;
}

function sourceOf(header: string[], map: Record<Column, number>): Statement['source'] {
    const cells = header.map(clean);
    if (cells.includes('交易分类') || cells.includes('收/付款方式')) return 'alipay';
    if (cells.includes('金额(元)') || cells.includes('当前状态')) return 'wechat';
    if (map.debit !== -1 && map.credit !== -1) return 'bank';
    if (cells.some(cell => cell.includes('利用'))) return 'card';
    return 'generic';
}

const SKIP_STATUS = /关闭|失败|取消|撤销|closed|failed|cancel/i;
const REFUND = /退款|返金|返品|refund/i;

export function readStatement(text: string, defaultCurrency: string, defaultMethod = ''): Statement {
    const rows = parseCsv(text);
    const headerIndex = findHeader(rows);
    const empty: Statement = { rows: [], income: 0, skipped: 0, source: 'generic' };
    if (headerIndex === -1) return empty;
    const header = rows[headerIndex] ?? [];
    const map = mapColumns(header);
    const source = sourceOf(header, map);
    // Japanese banks and cards write in yen without a currency column.
    const japanese = header.some(name => /[ぁ-んァ-ヶ]|利用|円/.test(name));
    const cell = (row: string[], key: Column) => (map[key] === -1 ? '' : row[map[key]] ?? '');
    const body = rows.slice(headerIndex + 1).filter(row => row.length > 1 && !/^[-—=]+$/.test(row[0] ?? ''));

    // With one signed amount column, a file that has negative amounts writes spending as negative (bank style);
    // a file with none lists only charges (card style).
    const signed = map.amount !== -1 && map.direction === -1 && map.debit === -1;
    const spendingIsNegative = signed && body.some(row => (parseAmount(cell(row, 'amount')) ?? 0) < 0);

    const out: Statement = { rows: [], income: 0, skipped: 0, source };
    for (const row of body) {
        const date = normalizeDate(cell(row, 'date'));
        if (!date || SKIP_STATUS.test(cell(row, 'status'))) { out.skipped++; continue; }
        let amount: number | null;
        let transfer = false;
        if (map.direction !== -1) {
            const value = parseAmount(cell(row, 'amount'));
            const dir = cell(row, 'direction');
            if (value === null) { out.skipped++; continue; }
            if (/收入|income/i.test(dir)) {
                // A refund shows up as income with the word in the status or item; anything else is income.
                if (REFUND.test(`${cell(row, 'status')} ${cell(row, 'item')}`)) amount = -Math.abs(value);
                else { out.income++; continue; }
            } else {
                amount = Math.abs(value);
                // WeChat and Alipay mark moves between your own accounts as neither income nor spending.
                transfer = !/支出|expense/i.test(dir);
            }
        } else if (map.debit !== -1) {
            const debit = parseAmount(cell(row, 'debit'));
            const credit = parseAmount(cell(row, 'credit'));
            if (debit) amount = Math.abs(debit);
            else if (credit) { out.income++; continue; }
            else { out.skipped++; continue; }
        } else {
            const value = parseAmount(cell(row, 'amount'));
            if (value === null) { out.skipped++; continue; }
            if (spendingIsNegative) {
                if (value > 0 && !REFUND.test(`${cell(row, 'counterparty')} ${cell(row, 'item')}`)) { out.income++; continue; }
                amount = -value;
            } else amount = value;
        }
        if (!amount) { out.skipped++; continue; }
        const description = [cell(row, 'counterparty'), cell(row, 'item')].filter(part => part && part !== '/').join(' · ');
        const currency = cell(row, 'currency').toUpperCase();
        out.rows.push({
            date,
            description: description || cell(row, 'hint') || '—',
            amount: Math.round(amount * 100) / 100,
            currency: /^[A-Z]{3}$/.test(currency) ? currency : source === 'alipay' || source === 'wechat' ? 'CNY' : japanese ? 'JPY' : defaultCurrency,
            // A card statement's 支払方法 is the repayment plan (1回払い), not the card.
            paymentMethod: (source === 'card' ? '' : cell(row, 'method').replace(/^\/$/, '')) || (source === 'alipay' ? '支付宝' : source === 'wechat' ? '微信支付' : defaultMethod),
            hint: transfer ? '转账' : cell(row, 'hint')
        });
    }
    return out;
}
