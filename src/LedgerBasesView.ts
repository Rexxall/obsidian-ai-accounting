import { BasesEntry, BasesPropertyId, BasesView, BasesViewRegistration, Keymap, Plugin, QueryController } from 'obsidian';
import { amountOf, barShare, formatMoney, summarize } from './services/ledgerSums';
import { rawValue } from './basesSupport';
import { tr } from './i18n';

export const LEDGER_VIEW_ID = 'ai-accounting-ledger';

/** The property monthly ledgers carry their total in. */
const LEDGER_TOTAL = 'note.total_expense';

interface LedgerPlugin extends Plugin {
    settings: { baseCurrency: string };
}

function amountFor(plugin: Plugin, entry: BasesEntry, prop: BasesPropertyId | null): number | null {
    return prop ? amountOf(rawValue(plugin, entry, prop)) : null;
}

/** The ledger total when the base holds ledgers; otherwise the first visible property most entries hold as a number. */
function guessAmountProperty(plugin: Plugin, view: BasesView): BasesPropertyId | null {
    const entries = view.data.data.slice(0, 50);
    if (!entries.length) return null;
    const candidates = [LEDGER_TOTAL as BasesPropertyId, ...view.config.getOrder().filter(prop => !prop.startsWith('file.'))];
    for (const prop of candidates) {
        if (entries.filter(entry => amountFor(plugin, entry, prop) !== null).length * 2 >= entries.length) return prop;
    }
    return null;
}

/** The ledger view for Bases: a total, then one bar per note, split into the base's groups when it has them. */
export function ledgerViewRegistration(plugin: LedgerPlugin): BasesViewRegistration {
    class LedgerView extends BasesView {
        type = LEDGER_VIEW_ID;
        private root: HTMLElement;

        constructor(controller: QueryController, parent: HTMLElement) {
            super(controller);
            this.root = parent.createDiv({ cls: 'ai-accounting-bases ap' });
        }

        onDataUpdated(): void {
            this.render();
        }

        private whole = false;

        private money(amount: number): string {
            return formatMoney(amount, plugin.settings.baseCurrency || 'CNY', undefined, this.whole);
        }

        private render(): void {
            const prop = this.config.getAsPropertyId('amount') ?? guessAmountProperty(plugin, this);
            this.root.empty();

            const groups = this.data.groupedData.map(group => ({
                title: group.hasKey() ? group.key?.toString() ?? '' : '',
                rows: group.entries
                    .map(entry => ({ entry, amount: amountFor(plugin, entry, prop) }))
                    .filter((row): row is { entry: BasesEntry; amount: number } => row.amount !== null)
            }));
            const amounts = groups.flatMap(group => group.rows.map(row => row.amount));
            const missing = this.data.data.length - amounts.length;

            if (!amounts.length) {
                const empty = this.root.createDiv({ cls: 'ap-empty' });
                empty.createDiv({ cls: 'ap-empty-title', text: prop ? tr('No amounts here', '这里没有金额') : tr('Choose the amount property', '选出金额属性') });
                empty.createDiv({
                    cls: 'ap-empty-text',
                    text: prop
                        ? tr(`None of these notes has a number in “${this.config.getDisplayName(prop)}”.`, `这些笔记的“${this.config.getDisplayName(prop)}”里都没有数字。`)
                        : tr('Open the view options and pick the property that holds the amount. Monthly ledgers keep it in total_expense.', '在视图选项里选出存金额的属性。月账本的总额在 total_expense 里。')
                });
                return;
            }

            const all = summarize(amounts);
            this.whole = amounts.every(amount => Number.isInteger(amount));
            // One amount column for every group, so the bars line up across them.
            const widest = Math.max(...amounts.map(amount => this.money(amount).length));
            this.root.setCssProps({ '--aa-amount-width': `${widest + 1}ch` });
            const summary = this.root.createDiv({ cls: 'aa-bases-summary' });
            summary.createDiv({ cls: 'aa-bases-total', text: this.money(all.total), attr: { 'aria-label': tr(`Total ${this.money(all.total)}`, `合计 ${this.money(all.total)}`) } });
            summary.createDiv({ cls: 'aa-bases-facts', text: tr(`${all.count} notes · ${this.money(all.average)} on average`, `${all.count} 篇 · 平均 ${this.money(all.average)}`) });

            for (const group of groups) {
                if (!group.rows.length) continue;
                const section = this.root.createDiv({ cls: 'ap-section aa-bases-section' });
                if (group.title) {
                    const head = section.createDiv({ cls: 'ap-section-title aa-bases-group-head' });
                    head.createSpan({ text: group.title });
                    head.createSpan({ cls: 'aa-bases-subtotal', text: this.money(summarize(group.rows.map(row => row.amount)).total) });
                }
                const list = section.createDiv({ cls: 'ap-group' });
                for (const row of group.rows) {
                    const el = list.createEl('a', { cls: 'ap-row aa-bases-row', href: '#' });
                    el.createDiv({ cls: 'aa-bases-label', text: row.entry.file.basename });
                    const track = el.createDiv({ cls: 'aa-bases-track', attr: { 'aria-hidden': 'true' } });
                    track.createDiv({ cls: `aa-bases-bar${row.amount < 0 ? ' is-negative' : ''}` }).setCssProps({ '--aa-share': `${barShare(row.amount, all.max) * 100}%` });
                    el.createDiv({ cls: 'aa-bases-amount', text: this.money(row.amount) });
                    el.addEventListener('click', evt => {
                        evt.preventDefault();
                        void this.app.workspace.openLinkText(row.entry.file.path, '', Keymap.isModEvent(evt));
                    });
                }
            }
            if (missing > 0 && prop) this.root.createDiv({ cls: 'aa-bases-note', text: tr(`${missing} without an amount in “${this.config.getDisplayName(prop)}”`, `另有 ${missing} 篇的“${this.config.getDisplayName(prop)}”没有金额`) });
        }
    }

    return {
        name: tr('Ledger', '账本'),
        icon: 'wallet',
        factory: (controller, containerEl) => new LedgerView(controller, containerEl),
        options: () => [
            { type: 'property', key: 'amount', displayName: tr('Amount', '金额'), placeholder: tr('A number property, e.g. total_expense', '数字属性，比如 total_expense') }
        ]
    };
}
