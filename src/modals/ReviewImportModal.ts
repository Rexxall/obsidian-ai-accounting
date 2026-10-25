import { App, Modal, Notice } from 'obsidian';
import { TransactionData } from '../services/AIService';
import { validateTransaction } from '../services/ledger';

/** AI produces a draft; only the reviewed draft is written to the ledger. */
export class ReviewImportModal extends Modal {
    private resolve: (value: TransactionData[] | null) => void = () => {};
    private accepted = false;
    private draft: TransactionData[];
    constructor(app: App, rows: TransactionData[], private owner: string, private source: string) {
        super(app);
        this.draft = rows.map(row => ({ ...row }));
    }
    review(): Promise<TransactionData[] | null> {
        return new Promise(resolve => { this.resolve = resolve; this.open(); });
    }
    onOpen() {
        this.modalEl.addClass('aa-review-modal');
        this.contentEl.createEl('h2', { text: '核对后入账' });
        this.contentEl.createEl('p', { text: `${this.owner} · ${this.source} · ${this.draft.length} 笔`, cls: 'aa-review-context' });
        this.contentEl.createEl('p', { text: '确认日期、金额和币种。相同金额的真实消费会分别保留。', cls: 'aa-review-hint' });
        const scroller = this.contentEl.createDiv({ cls: 'aa-review-table-wrap' });
        const table = scroller.createEl('table');
        const header = table.createEl('thead').createEl('tr');
        ['日期', '描述', '分类', '金额', '币种', '支付方式'].forEach(text => header.createEl('th', { text }));
        const body = table.createEl('tbody');
        for (const row of this.draft) {
            const tr = body.createEl('tr');
            const fields: (keyof TransactionData)[] = ['date', 'description', 'category', 'amount', 'currency', 'paymentMethod'];
            fields.forEach(field => {
                const input = tr.createEl('td').createEl('input', { type: field === 'date' ? 'date' : field === 'amount' ? 'number' : 'text' });
                input.value = String(row[field] ?? '');
                input.setAttribute('aria-label', field);
                if (field === 'amount') { input.step = 'any'; input.min = '0'; }
                input.addEventListener('input', () => {
                    if (field === 'amount') row.amount = input.value.trim() ? Number(input.value) : NaN;
                    else row[field] = field === 'currency' ? input.value.trim().toUpperCase() : input.value;
                });
            });
        }
        const actions = this.contentEl.createDiv({ cls: 'aa-review-actions' });
        actions.createEl('button', { text: '暂不入账' }).onclick = () => this.close();
        actions.createEl('button', { text: `确认 ${this.draft.length} 笔入账`, cls: 'mod-cta' }).onclick = () => {
            try {
                this.draft.forEach(validateTransaction);
                this.accepted = true;
                this.resolve(this.draft);
                this.close();
            } catch (error) { new Notice((error as Error).message); }
        };
    }
    onClose() { if (!this.accepted) this.resolve(null); this.contentEl.empty(); }
}
