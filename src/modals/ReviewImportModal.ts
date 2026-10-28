import { App, Modal, Notice } from 'obsidian';
import { TransactionData } from '../services/AIService';
import { validateTransaction } from '../services/ledger';

/** What the AI read from: the receipt image or the start of the note. */
export interface ReviewSource {
    imageSrc?: string;
    text?: string;
}

const FIELDS: { key: keyof TransactionData, label: string }[] = [
    { key: 'date', label: '日期' },
    { key: 'description', label: '内容' },
    { key: 'category', label: '分类' },
    { key: 'amount', label: '金额' },
    { key: 'currency', label: '币种' },
    { key: 'paymentMethod', label: '支付方式' }
];

/** AI produces a draft; only the reviewed draft is written to the ledger. */
export class ReviewImportModal extends Modal {
    private resolve: (value: TransactionData[] | null) => void = () => {};
    private accepted = false;
    private draft: TransactionData[];
    constructor(app: App, rows: TransactionData[], private owner: string, private source: string, private preview: ReviewSource = {}, private paper = false, private draftLabel = 'AI 已填草稿') {
        super(app);
        this.draft = rows.map(row => ({ ...row }));
    }
    review(): Promise<TransactionData[] | null> {
        return new Promise(resolve => { this.resolve = resolve; this.open(); });
    }
    onOpen() {
        this.modalEl.addClass('aa-modal', 'aa-review-modal');
        this.modalEl.toggleClass('rk-paper', this.paper);
        this.setTitle('核对后入账');
        this.contentEl.createDiv({ cls: 'rk-modal-kicker', text: [this.draftLabel, '还没有入账', this.owner, this.source, `${this.draft.length} 笔`].filter(Boolean).join(' · ') });

        const body = this.contentEl.createDiv({ cls: 'aa-review-body' });
        if (this.preview.imageSrc || this.preview.text) {
            const sourceEl = body.createDiv({ cls: 'aa-review-source' });
            if (this.preview.imageSrc) sourceEl.createEl('img', { attr: { src: this.preview.imageSrc, alt: this.source } });
            else sourceEl.createEl('pre', { text: this.preview.text });
        }

        const right = body.createDiv({ cls: 'aa-review-main' });
        const table = right.createEl('table', { cls: 'aa-table aa-review-table' });
        const header = table.createEl('thead').createEl('tr');
        FIELDS.forEach(field => header.createEl('th', { text: field.label, cls: field.key === 'amount' ? 'is-right' : '' }));
        const body2 = table.createEl('tbody');
        const summary = right.createDiv({ cls: 'rk-split aa-review-summary' });
        const notes = right.createDiv({ cls: 'rk-callout is-warn aa-review-notes' });

        // Cells the AI left empty or unreadable are marked, so it is clear what to check.
        const refresh = () => {
            const totals = new Map<string, number>();
            const problems: string[] = [];
            this.draft.forEach((row, index) => {
                const amount = Number(row.amount);
                if (Number.isFinite(amount)) totals.set(row.currency || '?', (totals.get(row.currency || '?') || 0) + amount);
                const missing = FIELDS.filter(field => this.isMissing(row, field.key)).map(field => field.label);
                if (missing.length) problems.push(`第 ${index + 1} 笔：${missing.join('、')}`);
            });
            body2.querySelectorAll('tr').forEach((tr, index) => {
                const row = this.draft[index];
                if (!row) return;
                tr.querySelectorAll('input').forEach((input, i) => {
                    const field = FIELDS[i];
                    if (field) input.toggleClass('is-flagged', this.isMissing(row, field.key));
                });
            });
            summary.empty();
            summary.createSpan({ text: `合计 ${[...totals].map(([cur, sum]) => `${sum.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${cur}`).join(' + ') || '—'}` });
            summary.createSpan({ text: '相同金额的真实消费会分别保留' });
            notes.empty();
            notes.toggle(problems.length > 0);
            if (problems.length) {
                const text = notes.createDiv();
                text.createEl('strong', { text: '请先补上：' });
                text.appendText(problems.join('；'));
            }
        };

        for (const row of this.draft) {
            const tr = body2.createEl('tr');
            FIELDS.forEach(({ key, label }) => {
                const input = tr.createEl('td', { cls: key === 'amount' ? 'is-right' : '' }).createEl('input', {
                    type: key === 'date' ? 'date' : key === 'amount' ? 'number' : 'text',
                    cls: `aa-cell-input is-${key}`
                });
                input.value = String(row[key] ?? '');
                input.setAttribute('aria-label', label);
                if (key === 'amount') { input.step = 'any'; input.min = '0'; }
                input.addEventListener('input', () => {
                    if (key === 'amount') row.amount = input.value.trim() ? Number(input.value) : NaN;
                    else row[key] = key === 'currency' ? input.value.trim().toUpperCase() : input.value;
                    refresh();
                });
            });
        }
        refresh();

        const foot = this.contentEl.createDiv({ cls: 'rk-modal-foot' });
        foot.createDiv({ cls: 'rk-foot-note', text: '确认日期、金额和币种后再入账。' });
        foot.createEl('button', { text: '暂不入账' }).onclick = () => this.close();
        foot.createEl('button', { text: `确认 ${this.draft.length} 笔入账`, cls: 'mod-cta' }).onclick = () => {
            try {
                this.draft.forEach(validateTransaction);
                this.accepted = true;
                this.resolve(this.draft);
                this.close();
            } catch (error) { new Notice((error as Error).message); }
        };
    }
    private isMissing(row: TransactionData, key: keyof TransactionData): boolean {
        const value = row[key];
        if (key === 'amount') return !Number.isFinite(Number(value)) || Number(value) <= 0;
        if (key === 'paymentMethod') return false;
        return value === undefined || value === null || String(value).trim() === '';
    }
    onClose() { if (!this.accepted) this.resolve(null); this.contentEl.empty(); }
}
