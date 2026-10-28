import { App, Modal, Notice, setIcon } from 'obsidian';
import { TransactionData } from '../services/AIService';
import { validateTransaction } from '../services/ledger';
import { openDatePicker } from '../popover';

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
    constructor(app: App, rows: TransactionData[], private owner: string, private source: string, private preview: ReviewSource = {}, private draftLabel = 'AI 已填草稿') {
        super(app);
        this.draft = rows.map(row => ({ ...row }));
    }
    review(): Promise<TransactionData[] | null> {
        return new Promise(resolve => { this.resolve = resolve; this.open(); });
    }
    onOpen() {
        this.modalEl.addClass('aa-modal', 'aa-review-modal');
        this.modalEl.addClass('ap', 'ap-modal');
        this.setTitle('核对后入账');
        this.contentEl.createDiv({ cls: 'ap-modal-kicker', text: [this.draftLabel, '还没有入账', this.owner, this.source, `${this.draft.length} 笔`].filter(Boolean).join(' · ') });

        const body = this.contentEl.createDiv({ cls: 'aa-review-body' });
        if (this.preview.imageSrc || this.preview.text) {
            const sourceEl = body.createDiv({ cls: 'aa-review-source' });
            if (this.preview.imageSrc) sourceEl.createEl('img', { attr: { src: this.preview.imageSrc, alt: this.source } });
            else sourceEl.createEl('pre', { text: this.preview.text });
        }

        // One line per transaction with the full text; click a line to edit it.
        // Lines with something missing open by themselves.
        const right = body.createDiv({ cls: 'aa-review-main' });
        const list = right.createDiv({ cls: 'ap-group aa-review-list' });
        const summary = right.createDiv({ cls: 'ap-split aa-review-summary' });
        const notes = right.createDiv({ cls: 'ap-notice is-warn aa-review-notes' });
        const lines: { row: TransactionData, item: HTMLElement, draw: () => void, inputs: HTMLInputElement[] }[] = [];

        const refresh = () => {
            const totals = new Map<string, number>();
            const problems: string[] = [];
            this.draft.forEach((row, index) => {
                const amount = Number(row.amount);
                if (Number.isFinite(amount)) totals.set(row.currency || '?', (totals.get(row.currency || '?') || 0) + amount);
                const missing = FIELDS.filter(field => this.isMissing(row, field.key)).map(field => field.label);
                if (missing.length) problems.push(`第 ${index + 1} 笔：${missing.join('、')}`);
            });
            lines.forEach(line => {
                line.draw();
                line.inputs.forEach(input => {
                    const key = input.dataset.key as keyof TransactionData;
                    input.toggleClass('is-flagged', this.isMissing(line.row, key));
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
            const item = list.createDiv({ cls: 'ap-disclosure aa-review-item' });
            const head = item.createDiv({ cls: 'ap-disclosure-head aa-review-line', attr: { role: 'button', tabindex: '0' } });
            const chevron = head.createSpan({ cls: 'ap-disclosure-chevron' });
            setIcon(chevron, 'chevron-right');
            const main = head.createDiv({ cls: 'ap-grow' });
            const title = main.createDiv({ cls: 'aa-review-title' });
            const meta = main.createDiv({ cls: 'aa-review-meta' });
            const amount = head.createDiv({ cls: 'ap-amt aa-review-amount' });
            const toggle = () => { item.toggleClass('is-open', !item.hasClass('is-open')); };
            head.onclick = toggle;
            head.onkeydown = (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(); } };

            const editor = item.createDiv({ cls: 'ap-disclosure-body aa-review-editor' });
            const inputs: HTMLInputElement[] = [];
            FIELDS.forEach(({ key, label }) => {
                if (key === 'date') {
                    // The date is a pill that opens the same month calendar as the ledger header.
                    const field = editor.createDiv({ cls: 'aa-review-field is-date' });
                    field.createSpan({ cls: 'ap-cap', text: label });
                    const pill = field.createEl('button', { cls: 'ap-pill-select aa-date-pill', attr: { 'aria-label': label, 'aria-haspopup': 'dialog' } });
                    const drawPill = () => {
                        pill.empty();
                        pill.appendText(row.date || '选择日期');
                        setIcon(pill.createSpan(), 'chevron-down');
                        pill.toggleClass('is-flagged', this.isMissing(row, 'date'));
                    };
                    drawPill();
                    pill.onclick = () => openDatePicker(pill, row.date || '', date => { row.date = date; drawPill(); refresh(); });
                    return;
                }
                const field = editor.createEl('label', { cls: `aa-review-field is-${key}` });
                field.createSpan({ cls: 'ap-cap', text: label });
                const input = field.createEl('input', {
                    type: key === 'amount' ? 'number' : 'text',
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
                input.dataset.key = key;
                inputs.push(input);
            });

            const draw = () => {
                const missing = FIELDS.filter(field => this.isMissing(row, field.key));
                title.setText(row.description || '（没有内容）');
                title.toggleClass('is-empty', !row.description);
                meta.empty();
                if (row.category) meta.createSpan({ cls: 'ap-pill', text: row.category });
                meta.createSpan({ cls: 'ap-num', text: [row.date, row.paymentMethod].filter(Boolean).join(' · ') });
                if (missing.length) meta.createSpan({ cls: 'ap-pill is-warn', text: `需补：${missing.map(field => field.label).join('、')}` });
                amount.empty();
                const value = Number(row.amount);
                amount.appendText(Number.isFinite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: 2 }) : '—');
                amount.createSpan({ cls: 'ap-amt-unit', text: row.currency || '' });
            };
            if (FIELDS.some(field => this.isMissing(row, field.key))) item.addClass('is-open');
            lines.push({ row, item, draw, inputs });
        }
        refresh();

        const foot = this.contentEl.createDiv({ cls: 'ap-modal-foot' });
        foot.createDiv({ cls: 'ap-foot-note', text: '确认日期、金额和币种后再入账。' });
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
