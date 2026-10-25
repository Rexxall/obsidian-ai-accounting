import { Modal, App, Setting, Notice } from 'obsidian';
import AccountingPlugin from '../main';
import { TransactionRecord } from '../services/DataService';

export class EditTransactionModal extends Modal {
    private tx: TransactionRecord;
    private plugin: AccountingPlugin;
    private onSuccess: () => void;

    constructor(app: App, tx: TransactionRecord, plugin: AccountingPlugin, onSuccess: () => void) {
        super(app);
        this.tx = tx;
        this.plugin = plugin;
        this.onSuccess = onSuccess;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        this.modalEl.addClass('aa-modal');
        this.modalEl.toggleClass('rk-paper', !!this.plugin.settings.paperStyle);
        this.setTitle('编辑交易');

        let date = this.tx.date;
        let description = this.tx.description;
        let category = this.tx.category;
        let amount = this.tx.amount;
        let paymentMethod = this.tx.paymentMethod || '';

        new Setting(contentEl)
            .setName('日期')
            .addText(text => text.setValue(date).onChange(v => date = v));

        new Setting(contentEl)
            .setName('描述')
            .addText(text => text.setValue(description).onChange(v => description = v));

        new Setting(contentEl)
            .setName('分类')
            .addText(text => text.setValue(category).onChange(v => category = v));

        new Setting(contentEl)
            .setName('金额')
            .addText(text => text.setValue(amount.toString()).onChange(v => {
                const val = parseFloat(v);
                if (!isNaN(val)) amount = val;
            }));

        new Setting(contentEl)
            .setName('支付方式')
            .addText(text => text.setValue(paymentMethod).onChange(v => paymentMethod = v));

        const btnDiv = contentEl.createDiv({ cls: 'modal-button-container', attr: { style: 'display: flex; justify-content: space-between; margin-top: 20px;' } });

        const deleteBtn = btnDiv.createEl('button', { text: '删除', cls: 'mod-warning' });
        let armed = false;
        deleteBtn.onclick = async () => {
            if (!armed) {
                armed = true;
                deleteBtn.setText('再点一次确认删除');
                window.setTimeout(() => { armed = false; deleteBtn.setText('删除'); }, 4000);
                return;
            }
            {
                try {
                await this.plugin.dataService.deleteTransaction(this.tx);
                new Notice('已删除');
                this.onSuccess();
                this.close();
                } catch (error) { new Notice((error as Error).message, 7000); }
            }
        };

        const saveBtn = btnDiv.createEl('button', { text: '保存', cls: 'mod-cta' });
        saveBtn.onclick = async () => {
            try {
            const rate = date === this.tx.date ? this.tx.rate : await this.plugin.fxService.getExchangeRate(this.tx.currency, this.plugin.settings.baseCurrency, date);
            const newTx: TransactionRecord = {
                ...this.tx,
                date,
                description,
                category,
                amount,
                rate,
                baseAmount: amount * rate,
                paymentMethod
            };
            await this.plugin.dataService.updateTransaction(this.tx, newTx);
            new Notice('已更新');
            this.onSuccess();
            this.close();
            } catch (error) { new Notice((error as Error).message, 7000); }
        };
    }

    onClose() {
        this.contentEl.empty();
    }
}
