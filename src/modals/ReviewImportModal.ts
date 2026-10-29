import { App, Modal, Notice, setIcon } from 'obsidian';
import { TransactionData, TRANSFER_CATEGORY } from '../services/AIService';
import { validateTransaction, entryKind, EntryKind } from '../services/ledger';
import { openDatePicker } from '../popover';
import { tr } from '../i18n';

/** What the AI read from: the receipt image or the start of the note. */
export interface ReviewSource {
    imageSrc?: string;
    text?: string;
}

export interface ReviewOptions {
    /** Row index → description of the ledger row it may repeat. */
    duplicates?: Map<number, string>;
    /** Offered for saved drafts: throw the draft away. */
    onDiscard?: () => Promise<void>;
    /** Saved drafts keep their edits when the dialog closes without entering. */
    onKeep?: (rows: TransactionData[]) => Promise<void>;
}

type Field = Exclude<keyof TransactionData, 'id'>;

const FIELDS = (): { key: Field, label: string }[] => [
    { key: 'date', label: tr('Date', '日期') },
    { key: 'description', label: tr('Description', '内容') },
    { key: 'category', label: tr('Category', '分类') },
    { key: 'amount', label: tr('Amount', '金额') },
    { key: 'currency', label: tr('Currency', '币种') },
    { key: 'paymentMethod', label: tr('Payment method', '支付方式') }
];

const KINDS = (): { kind: EntryKind, label: string }[] => [
    { kind: 'expense', label: tr('Expense', '支出') },
    { kind: 'refund', label: tr('Refund', '退款') },
    { kind: 'transfer', label: tr('Transfer', '转账') }
];

/** AI produces a draft; only the reviewed draft is written to the ledger. */
export class ReviewImportModal extends Modal {
    private resolve: (value: TransactionData[] | null) => void = () => {};
    private accepted = false;
    private discarded = false;
    private draft: (TransactionData & { removed?: boolean })[];
    constructor(app: App, rows: TransactionData[], private owner: string, private source: string, private preview: ReviewSource = {}, private draftLabel = tr('AI draft', 'AI 已填草稿'), private options: ReviewOptions = {}) {
        super(app);
        this.draft = rows.map(row => ({ ...row }));
    }
    review(): Promise<TransactionData[] | null> {
        return new Promise(resolve => { this.resolve = resolve; this.open(); });
    }
    private kept(): TransactionData[] {
        return this.draft.filter(row => !row.removed).map(({ removed: _removed, ...row }) => row);
    }
    onOpen() {
        this.modalEl.addClass('aa-modal', 'aa-review-modal');
        this.modalEl.addClass('ap', 'ap-modal');
        this.setTitle(tr('Review before entering', '核对后入账'));
        const kicker = this.contentEl.createDiv({ cls: 'ap-modal-kicker' });

        const body = this.contentEl.createDiv({ cls: 'aa-review-body' });
        if (this.preview.imageSrc || this.preview.text) {
            const sourceEl = body.createDiv({ cls: 'aa-review-source' });
            if (this.preview.imageSrc) sourceEl.createEl('img', { attr: { src: this.preview.imageSrc, alt: this.source } });
            else sourceEl.createEl('pre', { text: this.preview.text });
        }

        // One line per transaction with the full text; click a line to edit it.
        // Lines with something missing, or that may repeat a ledger row, open by themselves.
        const right = body.createDiv({ cls: 'aa-review-main' });
        const list = right.createDiv({ cls: 'ap-group aa-review-list' });
        const summary = right.createDiv({ cls: 'ap-split aa-review-summary' });
        const notes = right.createDiv({ cls: 'ap-notice is-warn aa-review-notes' });
        const lines: { row: TransactionData & { removed?: boolean }, item: HTMLElement, draw: () => void, inputs: HTMLInputElement[] }[] = [];
        let confirm: HTMLButtonElement | undefined;

        const refresh = () => {
            const totals = new Map<string, number>();
            const problems: string[] = [];
            const fields = FIELDS();
            this.draft.forEach((row, index) => {
                if (row.removed) return;
                const amount = Number(row.amount);
                if (Number.isFinite(amount) && entryKind(row) !== 'transfer') totals.set(row.currency || '?', (totals.get(row.currency || '?') || 0) + amount);
                const missing = fields.filter(field => this.isMissing(row, field.key)).map(field => field.label);
                if (missing.length) problems.push(tr(`Row ${index + 1}: ${missing.join(', ')}`, `第 ${index + 1} 笔：${missing.join('、')}`));
            });
            lines.forEach(line => {
                line.draw();
                line.inputs.forEach(input => input.toggleClass('is-flagged', this.isMissing(line.row, input.dataset.key as Field)));
            });
            const count = this.kept().length;
            kicker.setText([this.draftLabel, tr('not entered yet', '还没有入账'), this.owner, this.source, tr(`${count} row(s)`, `${count} 笔`)].filter(Boolean).join(' · '));
            summary.empty();
            summary.createSpan({ text: `${tr('Total', '合计')} ${[...totals].map(([cur, sum]) => `${sum.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${cur}`).join(' + ') || '—'}` });
            summary.createSpan({ text: tr('Transfers are not counted as spending', '转账不计入支出') });
            notes.empty();
            notes.toggle(problems.length > 0);
            if (problems.length) {
                const text = notes.createDiv();
                text.createEl('strong', { text: tr('Fill in first: ', '请先补上：') });
                text.appendText(problems.join(tr('; ', '；')));
            }
            confirm?.setText(tr(`Enter ${count}`, `确认 ${count} 笔入账`));
            if (confirm) confirm.disabled = count === 0;
        };

        this.draft.forEach((row, index) => {
            const duplicateOf = this.options.duplicates?.get(index);
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
            let amountInput: HTMLInputElement | undefined;
            let categoryInput: HTMLInputElement | undefined;

            // Expense, refund (negative amount) or transfer (not counted as spending).
            const kindField = editor.createDiv({ cls: 'aa-review-field is-kind' });
            kindField.createSpan({ cls: 'ap-cap', text: tr('Type', '类型') });
            const seg = kindField.createDiv({ cls: 'ap-seg aa-kind-seg', attr: { role: 'radiogroup', 'aria-label': tr('Type', '类型') } });
            const kindButtons = KINDS().map(({ kind, label }) => {
                const btn = seg.createEl('button', { text: label, attr: { role: 'radio' } });
                btn.onclick = () => {
                    const abs = Math.abs(Number(row.amount));
                    const wasTransfer = entryKind(row) === 'transfer';
                    if (kind === 'refund') row.amount = Number.isFinite(abs) ? -abs : NaN;
                    else row.amount = Number.isFinite(abs) ? abs : NaN;
                    if (kind === 'transfer' && !wasTransfer) row.category = `${tr('Transfer', TRANSFER_CATEGORY)} / ${(row.category.split('/')[1] || tr('Other', '其他')).trim()}`;
                    if (kind !== 'transfer' && wasTransfer) row.category = tr('Other / General', '其他支出 / 一般');
                    if (categoryInput) categoryInput.value = row.category;
                    if (amountInput) amountInput.value = Number.isFinite(abs) ? String(abs) : '';
                    refresh();
                };
                return { kind, btn };
            });

            FIELDS().forEach(({ key, label }) => {
                if (key === 'date') {
                    // The date is a pill that opens the same month calendar as the ledger header.
                    const field = editor.createDiv({ cls: 'aa-review-field is-date' });
                    field.createSpan({ cls: 'ap-cap', text: label });
                    const pill = field.createEl('button', { cls: 'ap-pill-select aa-date-pill', attr: { 'aria-label': label, 'aria-haspopup': 'dialog' } });
                    const drawPill = () => {
                        pill.empty();
                        pill.appendText(row.date || tr('Pick a date', '选择日期'));
                        setIcon(pill.createSpan(), 'chevron-down');
                        pill.toggleClass('is-flagged', this.isMissing(row, 'date'));
                    };
                    drawPill();
                    pill.onclick = () => openDatePicker(pill, row.date || '', date => { row.date = date; drawPill(); refresh(); });
                    return;
                }
                const field = editor.createEl('label', { cls: `aa-review-field is-${key}` });
                field.createSpan({ cls: 'ap-cap', text: label });
                const input = field.createEl('input', { type: key === 'amount' ? 'number' : 'text', cls: `aa-cell-input is-${key}` });
                // The amount box shows the size; the type decides the sign.
                input.value = key === 'amount' ? (Number.isFinite(Number(row.amount)) ? String(Math.abs(Number(row.amount))) : '') : String(row[key] ?? '');
                input.setAttribute('aria-label', label);
                if (key === 'amount') { input.step = 'any'; input.min = '0'; amountInput = input; }
                if (key === 'category') categoryInput = input;
                input.addEventListener('input', () => {
                    if (key === 'amount') {
                        const value = input.value.trim() ? Math.abs(Number(input.value)) : NaN;
                        row.amount = entryKind(row) === 'refund' ? -value : value;
                    } else row[key] = key === 'currency' ? input.value.trim().toUpperCase() : input.value;
                    refresh();
                });
                input.dataset.key = key;
                inputs.push(input);
            });

            const rowActions = editor.createDiv({ cls: 'aa-review-row-actions' });
            const removeBtn = rowActions.createEl('button', { cls: 'aa-quiet-danger' });
            removeBtn.onclick = () => { row.removed = !row.removed; refresh(); };

            const draw = () => {
                const missing = FIELDS().filter(field => this.isMissing(row, field.key));
                const kind = entryKind(row);
                item.toggleClass('is-removed', !!row.removed);
                removeBtn.setText(row.removed ? tr('Keep this row', '保留这笔') : tr('Leave this row out', '不入这笔'));
                kindButtons.forEach(({ kind: k, btn }) => { btn.toggleClass('is-active', k === kind); btn.setAttribute('aria-checked', String(k === kind)); });
                title.setText(row.description || tr('(no description)', '（没有内容）'));
                title.toggleClass('is-empty', !row.description);
                meta.empty();
                if (row.removed) meta.createSpan({ cls: 'ap-pill', text: tr('Left out', '不入账') });
                if (kind !== 'expense') meta.createSpan({ cls: 'ap-pill is-accent', text: KINDS().find(k => k.kind === kind)?.label ?? '' });
                if (row.category) meta.createSpan({ cls: 'ap-pill', text: row.category });
                meta.createSpan({ cls: 'ap-num', text: [row.date, row.paymentMethod].filter(Boolean).join(' · ') });
                if (duplicateOf !== undefined && !row.removed) meta.createSpan({ cls: 'ap-pill is-warn', text: tr(`Maybe already entered: ${duplicateOf}`, `可能已记过：${duplicateOf}`) });
                if (missing.length && !row.removed) meta.createSpan({ cls: 'ap-pill is-warn', text: tr(`Needs: ${missing.map(field => field.label).join(', ')}`, `需补：${missing.map(field => field.label).join('、')}`) });
                amount.empty();
                const value = Number(row.amount);
                amount.appendText(Number.isFinite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: 2 }) : '—');
                amount.createSpan({ cls: 'ap-amt-unit', text: row.currency || '' });
            };
            if (duplicateOf !== undefined || FIELDS().some(field => this.isMissing(row, field.key))) item.addClass('is-open');
            lines.push({ row, item, draw, inputs });
        });

        const foot = this.contentEl.createDiv({ cls: 'ap-modal-foot' });
        foot.createDiv({ cls: 'ap-foot-note', text: this.options.onKeep
            ? tr('Check date, amount and currency. Closing keeps the draft for later.', '确认日期、金额和币种后再入账。关掉也会保留草稿，之后在账本页继续。')
            : tr('Check date, amount and currency before entering.', '确认日期、金额和币种后再入账。') });
        if (this.options.onDiscard) {
            foot.createEl('button', { text: tr('Discard draft', '丢弃草稿'), cls: 'aa-quiet-danger' }).onclick = () => {
                this.discarded = true;
                void this.options.onDiscard?.();
                this.close();
            };
        }
        foot.createEl('button', { text: this.options.onKeep ? tr('Later', '稍后再说') : tr('Not now', '暂不入账') }).onclick = () => this.close();
        confirm = foot.createEl('button', { cls: 'mod-cta' });
        confirm.onclick = () => {
            const rows = this.kept();
            try {
                rows.forEach(validateTransaction);
                this.accepted = true;
                this.resolve(rows);
                this.close();
            } catch (error) { new Notice((error as Error).message); }
        };
        refresh();
    }
    private isMissing(row: TransactionData & { removed?: boolean }, key: Field): boolean {
        if (row.removed) return false;
        const value = row[key];
        if (key === 'amount') return !Number.isFinite(Number(value)) || Number(value) === 0;
        if (key === 'paymentMethod') return false;
        return value === undefined || value === null || String(value).trim() === '';
    }
    onClose() {
        if (!this.accepted) {
            if (!this.discarded && this.options.onKeep) {
                void this.options.onKeep(this.draft.map(({ removed: _removed, ...row }) => row));
                new Notice(tr('Draft kept. Continue from "To review" on the ledger.', '草稿已保留，可在账本页的“待确认”里继续。'));
            }
            this.resolve(null);
        }
        this.contentEl.empty();
    }
}
