import { App, Modal, Setting } from 'obsidian';
import { tr } from '../i18n';

export interface MissingRate {
    currency: string;
    date: string;
    /** Last rate seen for this pair, offered as the starting value. */
    hint: { rate: number; date: string } | null;
}

/** Asks for the exchange rates that could not be fetched; resolves with one rate per row, or null when cancelled. */
export class ManualRateModal extends Modal {
    private rates: (number | null)[];
    private resolve: (rates: number[] | null) => void = () => {};
    private settled = false;

    constructor(app: App, private missing: MissingRate[], private base: string) {
        super(app);
        this.rates = missing.map(m => m.hint?.rate ?? null);
    }

    ask(): Promise<number[] | null> {
        return new Promise(resolve => {
            this.resolve = resolve;
            this.open();
        });
    }

    onOpen() {
        const { contentEl } = this;
        this.modalEl.addClass('aa-modal', 'ap', 'ap-modal', 'aa-rate-modal');
        this.setTitle(tr('Exchange rate', '填写汇率'));
        contentEl.createEl('p', { cls: 'ap-sub', text: tr('No rate could be fetched, possibly because you are offline. The rate you enter is saved with each entry.', '取不到汇率，可能没联网。填写的汇率会记在每一笔账里。') });

        let enter: HTMLButtonElement | null = null;
        const check = () => { if (enter) enter.disabled = !this.rates.every(r => r !== null && r > 0); };
        this.missing.forEach((m, i) => {
            const setting = new Setting(contentEl)
                .setName(`1 ${m.currency} = ? ${this.base}`)
                .setDesc(m.hint ? tr(`${m.date} · filled in with the rate from ${m.hint.date}`, `${m.date} · 已先填 ${m.hint.date} 的汇率`) : m.date)
                .addText(text => {
                    text.inputEl.type = 'number';
                    text.inputEl.step = 'any';
                    text.inputEl.min = '0';
                    text.inputEl.addClass('ap-num');
                    if (this.rates[i] !== null) text.setValue(String(this.rates[i]));
                    text.onChange(value => {
                        const n = Number(value);
                        this.rates[i] = value.trim() && Number.isFinite(n) && n > 0 ? n : null;
                        check();
                    });
                    if (i === 0) window.setTimeout(() => text.inputEl.select(), 0);
                });
            setting.settingEl.addClass('aa-rate-row');
        });

        new Setting(contentEl)
            .addButton(btn => btn.setButtonText(tr('Cancel', '取消')).onClick(() => this.close()))
            .addButton(btn => {
                enter = btn.buttonEl;
                btn.setButtonText(tr('Enter with these rates', '按这个汇率入账')).setCta().onClick(() => {
                    if (!this.rates.every(r => r !== null && r > 0)) return;
                    this.finish(this.rates.map(r => r ?? 0));
                    this.close();
                });
            });
        check();
    }

    private finish(value: number[] | null) {
        if (this.settled) return;
        this.settled = true;
        this.resolve(value);
    }

    onClose() {
        this.finish(null);
        this.contentEl.empty();
    }
}
