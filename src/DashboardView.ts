import { ItemView, WorkspaceLeaf, Notice, setIcon } from 'obsidian';
import { Chart, registerables } from 'chart.js';
import { DataService, MonthlyStats, TransactionRecord } from './services/DataService';
import AccountingPlugin from './main';
import { RenameCategoryModal } from './modals/RenameCategoryModal';
import { EditTransactionModal } from './modals/EditTransactionModal';
import { budgetUsage, parseBudgets } from './services/planning';
import { openPopover } from './popover';

Chart.register(...registerables);


export const VIEW_TYPE_DASHBOARD = 'ai-accounting-dashboard';

enum PanelTab {
    Transactions = '明细',
    Charts = '分析'
}
// 新增：图表视图范围类型
type ChartScope = 'day' | 'month' | 'year';

interface RenderContext {
    rawStats: MonthlyStats | null;
    navRawStats: MonthlyStats | null;
    navLabel: string;
    yyyy: string;
    yyyy_mm: string;
    yyyy_mm_dd: string;
}

export class DashboardView extends ItemView {
    plugin: AccountingPlugin;
    dataService: DataService;
    allStats: MonthlyStats[] = [];
    displayCurrency: string;

    // Unified State
    currentDate: Date = new Date();
    chartScope: ChartScope = 'month';
    currentTab: PanelTab = PanelTab.Transactions;

    // Filters
    private searchQuery: string = '';
    private selectedCats: Set<string> = new Set();
    private selectedPMs: Set<string> = new Set();
    private selectedUserId: string = 'all';

    // Sorting
    sortColumn: string = 'date';
    sortDirection: 'asc' | 'desc' = 'desc';
    navSortColumn: 'period' | 'amount' = 'period';
    navSortDirection: 'asc' | 'desc' = 'desc';

    // Internal State
    selectedPrimaryCategory: string | null = null; // For drill-down in Charts
    selectedDailyCategory: string | null = null; // Primary category in Transactions tab
    selectedSecondaryCategory: string | null = null; // Secondary category in Transactions tab
    selectedTransactionDate: string | null = null; // Selected date in Transactions view (when scope > day)

    constructor(leaf: WorkspaceLeaf, plugin: AccountingPlugin) {
        super(leaf);
        this.plugin = plugin;
        this.dataService = new DataService(this.app, this.plugin.settings);
        this.displayCurrency = this.plugin.settings.baseCurrency;
    }

    getViewType() {
        return VIEW_TYPE_DASHBOARD;
    }

    getDisplayText() {
        return '账本';
    }

    getIcon() {
        return 'pie-chart';
    }

    async onOpen() {
        await this.refreshData();
        await this.render();
        // Charts read theme colours when drawn; redraw when the theme changes.
        this.registerEvent(this.app.workspace.on('css-change', () => void this.render()));
        // 绑定快捷键
        this.registerDomEvent(this.containerEl, 'keydown', (e: KeyboardEvent) => {
            const target = e.target as HTMLElement;
            const isInputFocused = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
            if (!isInputFocused) {
                if (e.key === '/') {
                    const el = this.containerEl.querySelector('#aa-search') as HTMLInputElement;
                    if (el) { el.focus(); e.preventDefault(); }
                } else if (e.key.toLowerCase() === 'n') {
                    const el = this.containerEl.querySelector('#aa-quick-date') as HTMLInputElement;
                    if (el) { el.focus(); e.preventDefault(); }
                } else if (e.key.toLowerCase() === 'f') {
                    const el = this.containerEl.querySelector('#aa-filters') as HTMLElement;
                    if (el) { el.click(); e.preventDefault(); }
                } else if (e.key === 'Escape') {
                    this.clearAllFilters();
                    void this.render();
                }
            }
        });
    }

    async refreshData() {
        this.allStats = await this.dataService.getAllData();
    }

    async refresh() {
        await this.refreshData();
        await this.render();
    }

    private aggregateStats(statsList: MonthlyStats[], label: string): MonthlyStats {
        const aggregated: MonthlyStats = {
            month: label,
            total: 0,
            categories: {},
            secondaryCategories: {},
            dailyStats: {},
            paymentMethods: {},
            transactions: [],
            userId: 'aggregated'
        };

        for (const s of statsList) {
            aggregated.total += s.total;
            aggregated.transactions.push(...s.transactions);

            for (const [k, v] of Object.entries(s.categories)) aggregated.categories[k] = (aggregated.categories[k] || 0) + v;
            for (const [k, v] of Object.entries(s.dailyStats)) aggregated.dailyStats[k] = (aggregated.dailyStats[k] || 0) + v;
            for (const [k, v] of Object.entries(s.paymentMethods)) aggregated.paymentMethods[k] = (aggregated.paymentMethods[k] || 0) + v;

            for (const [prim, secs] of Object.entries(s.secondaryCategories)) {
                if (!aggregated.secondaryCategories[prim]) aggregated.secondaryCategories[prim] = {};
                for (const [sec, v] of Object.entries(secs)) {
                    aggregated.secondaryCategories[prim][sec] = (aggregated.secondaryCategories[prim][sec] || 0) + v;
                }
            }
        }
        return aggregated;
    }

    private async getConvertedStats(stats: MonthlyStats): Promise<MonthlyStats> {
        if (this.displayCurrency === this.plugin.settings.baseCurrency) return stats;

        const base = this.plugin.settings.baseCurrency;
        const target = this.displayCurrency;

        const converted: MonthlyStats = {
            ...stats,
            total: 0,
            categories: {},
            secondaryCategories: {},
            dailyStats: {},
            paymentMethods: {},
            transactions: stats.transactions
        };

        // Convert individual transactions to build accurate aggregated stats
        for (const record of stats.transactions) {
            const convertedAmount = await this.plugin.fxService.convert(record.baseAmount, base, target, record.date);
            converted.total += convertedAmount;

            const parts = record.category.split(/[/>:：]/);
            const primary = (parts[0] || '其他支出').trim() || '其他支出';
            converted.categories[primary] = (converted.categories[primary] || 0) + convertedAmount;

            const secondary = (parts[1] || '一般').trim() || '一般';
            if (!converted.secondaryCategories[primary]) converted.secondaryCategories[primary] = {};
            converted.secondaryCategories[primary][secondary] = (converted.secondaryCategories[primary][secondary] || 0) + convertedAmount;

            converted.dailyStats[record.date] = (converted.dailyStats[record.date] || 0) + convertedAmount;

            const pm = record.paymentMethod || '未分类';
            converted.paymentMethods[pm] = (converted.paymentMethods[pm] || 0) + convertedAmount;
        }

        return converted;
    }

    private getCurrentContext(): RenderContext {
        // 1. Prepare data based on Unified Scope
        let rawStats: MonthlyStats | null = null;
        let navRawStats: MonthlyStats | null = null; // For Navigation List
        let navLabel = '';

        const year = this.currentDate.getFullYear();
        const month = this.currentDate.getMonth() + 1;
        const day = this.currentDate.getDate();
        const yyyy = year.toString();
        const mm = month.toString().padStart(2, '0');
        const dd = day.toString().padStart(2, '0');
        const yyyy_mm = `${yyyy}-${mm}`;
        const yyyy_mm_dd = `${yyyy}-${mm}-${dd}`;

        // Filter by user first
        let relevantStats = this.allStats;
        if (this.selectedUserId !== 'all') {
            relevantStats = this.allStats.filter(s => s.userId === this.selectedUserId || (!s.userId && this.selectedUserId === 'default'));
        }

        if (relevantStats.length > 0) {
            if (this.chartScope === 'year') {
                const yearStats = relevantStats.filter(s => s.month.startsWith(yyyy));
                rawStats = this.aggregateStats(yearStats, `${yyyy} 年度`);
                navLabel = `${yyyy} 年度`;
                navRawStats = this.mergeAllMonths();
            } else if (this.chartScope === 'month') {
                const monthStats = relevantStats.filter(s => s.month === yyyy_mm);
                if (monthStats.length > 0) {
                    rawStats = this.aggregateStats(monthStats, yyyy_mm);
                }
                navLabel = `${yyyy}-${mm}`;
                const yearStats = relevantStats.filter(s => s.month.startsWith(yyyy));
                navRawStats = this.aggregateStats(yearStats, `${yyyy} 年度`);
            } else { // day
                const monthStats = relevantStats.filter(s => s.month === yyyy_mm);
                if (monthStats.length > 0) {
                    const allTx = monthStats.flatMap(s => s.transactions);
                    const dayTx = allTx.filter(t => t.date === yyyy_mm_dd);
                    rawStats = this.buildStatsFromTransactions(dayTx, yyyy_mm_dd);
                    navRawStats = this.aggregateStats(monthStats, yyyy_mm);
                }
                navLabel = `${yyyy}-${mm}-${dd}`;
            }
        }
        return { rawStats, navRawStats, navLabel, yyyy, yyyy_mm, yyyy_mm_dd };
    }

    private async render() {
        let container = this.contentEl.querySelector('.ai-accounting-dashboard-container') as HTMLElement;
        if (!container) {
            // Initial render or if cleared
            this.contentEl.empty(); // Preserve the native ItemView header.
            container = this.contentEl.createEl('div', { cls: 'ai-accounting-dashboard-container' });
        }
        this.contentEl.addClass('aa-view-content');
        container.addClass('ap', 'ap-view');

        // We generally shouldn't empty container unless we reconstruct everything.
        // But for tab switching or date change, we often do.
        // Let's stick to full re-render logic for render() but check child count for partialness?
        // Actually, render() is usually called for full updates.
        container.empty();

        const ctx = this.getCurrentContext();

        // 2. Render Header
        this.renderHeader(container, ctx);

        // 3. Render Grid
        const gridContainer = container.createEl('div', { cls: 'dashboard-grid' });
        await this.renderGrid(gridContainer, ctx);
    }

    private async refreshGridOnly() {
        const container = this.contentEl.querySelector('.ai-accounting-dashboard-container') as HTMLElement;
        if (!container) {
            console.error('Dashboard container not found!');
            return;
        }
        const grid = container.querySelector('.dashboard-grid') as HTMLElement;
        if (grid) {
            grid.empty();
            const ctx = this.getCurrentContext();
            await this.renderGrid(grid, ctx);
        } else {
            console.error('Dashboard grid not found!');
        }
    }

    private renderHeader(container: HTMLElement, ctx: RenderContext) {
        const head = container.createDiv({ cls: 'ap-head ap-bar-glass aa-head' });
        const headMain = head.createDiv({ cls: 'ap-head-main' });
        headMain.createDiv({ cls: 'ap-eyebrow', text: 'AI Accounting · 我的账本' });
        headMain.createEl('h1', { cls: 'ap-title', text: this.formatPeriodTitle(ctx) });

        const actions = head.createDiv({ cls: 'ap-head-actions' });
        const refreshBtn = actions.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': '刷新' } });
        setIcon(refreshBtn, 'refresh-cw');
        refreshBtn.onclick = () => this.refresh();
        const exportBtn = actions.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': '导出 CSV' } });
        setIcon(exportBtn, 'download');
        exportBtn.onclick = () => { if (ctx.rawStats) this.exportData(ctx.rawStats); };
        const settingsBtn = actions.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': '插件设置' } });
        setIcon(settingsBtn, 'settings');
        settingsBtn.onclick = () => {
            const settings = (this.app as typeof this.app & { setting?: { open(): void; openTabById(id: string): void } }).setting;
            settings?.open();
            settings?.openTabById(this.plugin.manifest.id);
        };
        const quickAddBtn = actions.createEl('button', { text: '记一笔', cls: 'mod-cta', attr: { 'aria-label': '快速录入' } });
        quickAddBtn.onclick = () => {
            const qf = container.querySelector('.quick-form-wrapper');
            if (qf) qf.classList.toggle('is-hidden');
            (qf?.querySelector('input[type="number"]') as HTMLInputElement | null)?.focus();
        };

        // Tabs, scope and period
        const toolbar = container.createDiv({ cls: 'aa-toolbar' });
        const tabs = toolbar.createDiv({ cls: 'ap-seg' });
        [PanelTab.Transactions, PanelTab.Charts].forEach(key => {
            const btn = tabs.createEl('button', { text: key, cls: this.currentTab === key ? 'is-active' : '' });
            btn.onclick = () => { this.currentTab = key; void this.render(); };
        });

        // One capsule for the period: step back or forward, or click the label to pick.
        const period = toolbar.createDiv({ cls: 'aa-period' });
        const prevBtn = period.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': '上一段' } });
        setIcon(prevBtn, 'chevron-left');
        prevBtn.onclick = async () => { this.adjustDate(-1); await this.render(); };
        const periodBtn = period.createEl('button', { cls: 'ap-pill-select aa-period-pill', text: this.formatPeriodTitle(ctx), attr: { 'aria-label': '选择时间', 'aria-haspopup': 'dialog' } });
        setIcon(periodBtn.createSpan(), 'chevron-down');
        periodBtn.onclick = () => this.openPeriodPicker(periodBtn);
        const nextBtn = period.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': '下一段' } });
        setIcon(nextBtn, 'chevron-right');
        nextBtn.onclick = async () => { this.adjustDate(1); await this.render(); };

        const spacer = toolbar.createDiv({ cls: 'ap-grow' });
        if (this.currentTab === PanelTab.Transactions) {
            const search = spacer.createDiv({ cls: 'ap-search aa-search' });
            setIcon(search.createSpan(), 'search');
            const searchInput = search.createEl('input', { type: 'text', attr: { id: 'aa-search', placeholder: '搜索商户或备注（/）', 'aria-label': '搜索' } });
            searchInput.value = this.searchQuery;
            searchInput.oninput = () => {
                this.searchQuery = searchInput.value || '';
                void this.refreshGridOnly();
            };
        }

        // Scope, currency, member, category and payment method all live behind one button.
        const active = this.activeFilterCount();
        const filterBtn = toolbar.createEl('button', { cls: `ap-pill-select aa-filter-btn${active ? ' is-active' : ''}`, attr: { id: 'aa-filters', 'aria-haspopup': 'dialog' } });
        setIcon(filterBtn.createSpan(), 'sliders-horizontal');
        filterBtn.appendText('筛选');
        if (active) filterBtn.createSpan({ cls: 'ap-pill-count', text: String(active) });
        filterBtn.onclick = () => this.openFilters(filterBtn, ctx);

        this.renderQuickForm(container);
    }

    private formatPeriodTitle(ctx: RenderContext): string {
        const [y, m, d] = ctx.yyyy_mm_dd.split('-').map(part => parseInt(part, 10));
        if (this.chartScope === 'year') return `${y} 年`;
        if (this.chartScope === 'month') return `${y} 年 ${m} 月`;
        return `${y} 年 ${m} 月 ${d} 日`;
    }

    /** Filters that narrow the ledger; the time scope and display currency are not counted. */
    private activeFilterCount(): number {
        return this.selectedCats.size + this.selectedPMs.size + (this.selectedUserId !== 'all' ? 1 : 0);
    }

    private openPeriodPicker(anchor: HTMLElement) {
        openPopover(anchor, 'aa-period-pop', (el, close) => {
            const pick = (date: Date) => { this.currentDate = date; close(); this.adjustDate(0); void this.render(); };
            const today = new Date();
            const fill = (year: number, month: number) => {
                el.empty();
                const head = el.createDiv({ cls: 'ap-popover-head' });
                const back = head.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': '上一页' } });
                setIcon(back, 'chevron-left');
                const label = this.chartScope === 'day' ? `${year} 年 ${month + 1} 月` : this.chartScope === 'month' ? `${year} 年` : `${year - 11} – ${year} 年`;
                head.createSpan({ text: label });
                const forward = head.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': '下一页' } });
                setIcon(forward, 'chevron-right');
                if (this.chartScope === 'month') {
                    back.onclick = () => fill(year - 1, month);
                    forward.onclick = () => fill(year + 1, month);
                    const grid = el.createDiv({ cls: 'ap-month-grid' });
                    for (let m = 0; m < 12; m++) {
                        const btn = grid.createEl('button', { text: `${m + 1} 月` });
                        btn.toggleClass('is-selected', year === this.currentDate.getFullYear() && m === this.currentDate.getMonth());
                        btn.toggleClass('is-today', year === today.getFullYear() && m === today.getMonth());
                        btn.onclick = () => pick(new Date(year, m, 1));
                    }
                } else if (this.chartScope === 'year') {
                    back.onclick = () => fill(year - 12, month);
                    forward.onclick = () => fill(year + 12, month);
                    const grid = el.createDiv({ cls: 'ap-month-grid' });
                    for (let y = year - 11; y <= year; y++) {
                        const btn = grid.createEl('button', { text: String(y) });
                        btn.toggleClass('is-selected', y === this.currentDate.getFullYear());
                        btn.toggleClass('is-today', y === today.getFullYear());
                        btn.onclick = () => pick(new Date(y, 0, 1));
                    }
                } else {
                    back.onclick = () => (month === 0 ? fill(year - 1, 11) : fill(year, month - 1));
                    forward.onclick = () => (month === 11 ? fill(year + 1, 0) : fill(year, month + 1));
                    const grid = el.createDiv({ cls: 'ap-month-grid aa-day-grid' });
                    ['一', '二', '三', '四', '五', '六', '日'].forEach(d => grid.createSpan({ cls: 'ap-cap', text: d }));
                    const first = new Date(year, month, 1);
                    for (let i = 0; i < (first.getDay() + 6) % 7; i++) grid.createSpan();
                    const days = new Date(year, month + 1, 0).getDate();
                    for (let d = 1; d <= days; d++) {
                        const btn = grid.createEl('button', { text: String(d) });
                        btn.toggleClass('is-selected', year === this.currentDate.getFullYear() && month === this.currentDate.getMonth() && d === this.currentDate.getDate());
                        btn.toggleClass('is-today', year === today.getFullYear() && month === today.getMonth() && d === today.getDate());
                        btn.onclick = () => pick(new Date(year, month, d));
                    }
                }
            };
            const start = this.chartScope === 'year' ? Math.max(this.currentDate.getFullYear(), today.getFullYear()) : this.currentDate.getFullYear();
            fill(start, this.currentDate.getMonth());
        });
    }

    private openFilters(anchor: HTMLElement, ctx: RenderContext) {
        const categories = new Set<string>();
        const methods = new Set<string>();
        ctx.rawStats?.transactions.forEach((t: TransactionRecord) => {
            const cat = (t.category.split(/[/>:：]/)[0] || '其他').trim();
            if (cat) categories.add(cat);
            methods.add(t.paymentMethod || '未分类');
        });
        openPopover(anchor, 'aa-filter-pop', el => {
            const fill = () => {
                el.empty();
                const section = (title: string) => {
                    const box = el.createDiv({ cls: 'aa-filter-section' });
                    box.createDiv({ cls: 'ap-cap', text: title });
                    return box.createDiv({ cls: 'aa-chips' });
                };
                const chip = (parent: HTMLElement, text: string, selected: boolean, onClick: () => void) => {
                    const btn = parent.createEl('button', { cls: `aa-chip${selected ? ' is-selected' : ''}`, text, attr: { 'aria-pressed': String(selected) } });
                    btn.onclick = () => { onClick(); fill(); void this.render(); };
                };

                const scope = el.createDiv({ cls: 'ap-seg aa-filter-scope' });
                ([['day', '日'], ['month', '月'], ['year', '年']] as const).forEach(([key, label]) => {
                    const btn = scope.createEl('button', { text: label, cls: this.chartScope === key ? 'is-active' : '' });
                    btn.onclick = () => {
                        this.chartScope = key;
                        this.selectedPrimaryCategory = null;
                        this.selectedDailyCategory = null;
                        fill();
                        void this.render();
                    };
                });

                const currencies = section('显示币种');
                ['CNY', 'JPY', 'USD', 'EUR', 'HKD', 'GBP'].forEach(cur => chip(currencies, cur, cur === this.displayCurrency, () => { this.displayCurrency = cur; }));

                if (this.plugin.settings.users.length > 1) {
                    const users = section('成员');
                    chip(users, '全部', this.selectedUserId === 'all', () => { this.selectedUserId = 'all'; this.selectedPrimaryCategory = null; });
                    this.plugin.settings.users.forEach(u => chip(users, u.name, this.selectedUserId === u.id, () => { this.selectedUserId = u.id; this.selectedPrimaryCategory = null; }));
                }
                const toggle = (set: Set<string>, value: string) => { if (set.has(value)) set.delete(value); else set.add(value); };
                if (categories.size) {
                    const cats = section('分类');
                    [...categories].sort().forEach(cat => chip(cats, cat, this.selectedCats.has(cat), () => toggle(this.selectedCats, cat)));
                }
                if (methods.size) {
                    const pms = section('支付方式');
                    [...methods].sort().forEach(pm => chip(pms, pm, this.selectedPMs.has(pm), () => toggle(this.selectedPMs, pm)));
                }
                if (this.activeFilterCount() > 0) {
                    const foot = el.createDiv({ cls: 'aa-filter-foot' });
                    const clear = foot.createEl('button', { text: '清除筛选' });
                    clear.onclick = () => {
                        this.selectedCats.clear();
                        this.selectedPMs.clear();
                        this.selectedUserId = 'all';
                        fill();
                        void this.render();
                    };
                }
            };
            fill();
        });
    }

    private renderQuickForm(container: HTMLElement) {
        // Quick Form Wrapper (same as before)
        const quickFormWrapper = container.createEl('div', { cls: 'quick-form-wrapper is-hidden' });
        const qForm = quickFormWrapper.createEl('div', { cls: 'quick-form-inline' });
        const dateInput = qForm.createEl('input', { type: 'date', attr: { id: 'aa-quick-date', 'aria-label': '交易日期' } });
        const today = new Date();
        dateInput.value = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
        const amountInput = qForm.createEl('input', { type: 'number', attr: { placeholder: '金额', step: '0.01' } });
        const currInput = qForm.createEl('select');
        ['CNY', 'JPY', 'USD', 'EUR', 'HKD', 'GBP'].forEach(c => { const o = currInput.createEl('option', { text: c, value: c }); if (c === this.plugin.settings.defaultInputCurrency) o.selected = true; });
        const catInput = qForm.createEl('input', { type: 'text', attr: { placeholder: '分类' } });
        const pmInput = qForm.createEl('input', { type: 'text', attr: { placeholder: '支付方式' } });
        const descInput = qForm.createEl('input', { type: 'text', attr: { placeholder: '描述' } });
        const isSplitInput = qForm.createEl('div', { cls: 'quick-add-toggle' });
        const splitCheckbox = isSplitInput.createEl('input', { type: 'checkbox', attr: { id: 'aa-split' } });
        isSplitInput.createEl('label', { text: 'AA/分账', attr: { for: 'aa-split' } });

        const addBtn = qForm.createEl('button', { text: '添加', cls: 'mod-cta' });
        addBtn.onclick = async () => {
            const date = dateInput.value || new Date().toISOString().slice(0, 10);
            const amount = parseFloat(amountInput.value || '0');
            const currency = currInput.value || this.plugin.settings.defaultInputCurrency;
            if (!amount || amount <= 0) return;
            const yearMonth = `${date.slice(0, 4)}-${date.slice(5, 7)}`;
            const baseAmount = await this.plugin.fxService.convert(amount, currency, this.plugin.settings.baseCurrency, date);
            const rate = await this.plugin.fxService.getExchangeRate(currency, this.plugin.settings.baseCurrency, date);

            const isSplit = splitCheckbox.checked;
            const users = this.plugin.settings.users;

            if (isSplit && users.length > 0) {
                const splitAmount = amount / users.length;
                const splitBaseAmount = baseAmount / users.length;

                for (const user of users) {
                    await this.plugin.dataService.appendBatchToMonthlyReport(
                        yearMonth,
                        [{
                            date,
                            description: descInput.value + ' (AA)' || 'AA',
                            category: catInput.value || '其他',
                            amount: splitAmount,
                            currency,
                            baseAmount: splitBaseAmount,
                            rate,
                            paymentMethod: pmInput.value || '未分类'
                        }],
                        user.id
                    );
                }
                new Notice(`已为 ${users.length} 位成员添加 AA 账单`);
            } else {
                await this.plugin.dataService.appendBatchToMonthlyReport(yearMonth, [{ date, description: descInput.value || '', category: catInput.value || '其他', amount, currency, baseAmount, rate, paymentMethod: pmInput.value || '未分类' }], this.selectedUserId !== 'all' ? this.selectedUserId : this.plugin.settings.currentUser);
                new Notice('已添加');
            }

            amountInput.value = ''; descInput.value = '';
            await this.refresh();
        };
    }

    private async renderGrid(dashboardGrid: HTMLElement, ctx: RenderContext) {
        const { rawStats, navRawStats, navLabel } = ctx;
        if (this.allStats.length === 0 || !rawStats) {
            const empty = dashboardGrid.createDiv({ cls: 'ap-card aa-empty-state' });
            empty.createEl('h2', { cls: 'ap-title', text: this.allStats.length === 0 ? '从第一笔记录开始' : '这个时间范围还没有记录' });
            empty.createEl('p', { cls: 'ap-sub', text: '可以直接录入一笔支出，或用上方日期选择器查看其他月份。已有账单也可以通过 AI 收件箱提取，核对后入账。' });
            const add = empty.createEl('button', { text: '录入一笔支出', cls: 'mod-cta' });
            add.onclick = () => {
                const form = this.contentEl.querySelector('.quick-form-wrapper');
                form?.classList.remove('is-hidden');
                (form?.querySelector('input[type="number"]') as HTMLInputElement | null)?.focus();
            };
            return;
        }

        // Apply filters
        const statsForDisplay = rawStats ? this.getFilteredTransactions(rawStats) : this.buildStatsFromTransactions([], navLabel);
        const displayStats = await this.getConvertedStats(statsForDisplay);

        let navDisplayStats = displayStats;
        if (navRawStats) {
            const filteredNav = this.getFilteredTransactions(navRawStats);
            navDisplayStats = await this.getConvertedStats(filteredNav);
        }

        // Today / this week (whole ledger)
        const todayStr = new Date().toISOString().slice(0, 10);
        const baseCur = this.plugin.settings.baseCurrency;
        const targetCur = this.displayCurrency;
        const allTx = this.allStats.flatMap(s => s.transactions);
        const todayTx = allTx.filter(t => t.date === todayStr);
        const weekStart = new Date(); weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));
        const weekEnd = new Date(weekStart); weekEnd.setDate(weekStart.getDate() + 7);
        const weekTx = allTx.filter(t => { const d = new Date(t.date); return d >= weekStart && d < weekEnd; });
        const [todayTotal, weekTotal] = await Promise.all([
            Promise.all(todayTx.map(t => this.plugin.fxService.convert(t.baseAmount, baseCur, targetCur, t.date))).then(arr => arr.reduce((a, b) => a + b, 0)),
            Promise.all(weekTx.map(t => this.plugin.fxService.convert(t.baseAmount, baseCur, targetCur, t.date))).then(arr => arr.reduce((a, b) => a + b, 0))
        ]);

        const renderTotals = (parent: HTMLElement) => {
            const card = parent.createDiv({ cls: 'ap-card aa-totals' });
            const total = this.createMetricCard(card, '期间支出', this.formatAmount(displayStats.total), this.displayCurrency, 'is-main');
            total.labelEl.id = 'aa-dynamic-total-label';
            total.valEl.id = 'aa-dynamic-total-val';
            const minor = card.createDiv({ cls: 'aa-minor-metrics' });
            const count = this.createMetricCard(minor, '交易笔数', displayStats.transactions.length.toString(), '笔');
            count.labelEl.id = 'aa-dynamic-count-label';
            count.valEl.id = 'aa-dynamic-count-val';
            this.createMetricCard(minor, '今日', this.formatAmount(todayTotal), this.displayCurrency);
            this.createMetricCard(minor, '本周', this.formatAmount(weekTotal), this.displayCurrency);
        };

        if (this.currentTab === PanelTab.Transactions) {
            // The ledger is the main column; totals and categories sit beside it.
            const layout = dashboardGrid.createDiv({ cls: 'aa-ledger-layout' });
            const main = layout.createDiv({ cls: 'aa-ledger-main' });
            const aside = layout.createDiv({ cls: 'aa-ledger-aside' });
            renderTotals(aside);
            this.renderBudget(aside, allTx);

            const where = aside.createDiv({ cls: 'ap-card is-flat aa-where' });
            where.createDiv({ cls: 'ap-label', text: '花在哪' });
            const cats = Object.entries(displayStats.categories).sort((a, b) => b[1] - a[1]);
            const colors = this.seriesColors();
            if (cats.length === 0) where.createDiv({ cls: 'ap-cap', text: '暂无数据' });
            cats.forEach(([cat, val], index) => {
                const row = where.createDiv({ cls: `ap-line aa-where-row${this.selectedCats.has(cat) ? ' is-active' : ''}` });
                row.createSpan({ cls: 'ap-dot' }).setCssProps({ background: colors[index % colors.length] || '' });
                row.createSpan({ cls: 'ap-grow', text: cat });
                row.createSpan({ cls: 'ap-amt', text: this.formatAmount(val) });
                row.onclick = () => {
                    const active = this.selectedCats.has(cat);
                    this.selectedCats.clear();
                    if (!active) this.selectedCats.add(cat);
                    void this.render();
                };
            });

            void this.renderTransactionDetailView(main, aside, displayStats, navDisplayStats);
        } else if (this.currentTab === PanelTab.Charts) {
            renderTotals(dashboardGrid);
            const charts = dashboardGrid.createDiv({ cls: 'aa-charts' });

            const chartCard = charts.createDiv({ cls: 'ap-card aa-chart-card' });
            const chartHead = chartCard.createDiv({ cls: 'aa-card-head' });
            chartHead.createDiv({ cls: 'ap-label', text: this.selectedPrimaryCategory ? `${this.selectedPrimaryCategory} · 子分类` : '支出分类' });
            if (this.selectedPrimaryCategory) {
                const backBtn = chartHead.createEl('button', { text: '← 返回主分类', cls: 'aa-link-btn' });
                backBtn.onclick = () => { this.selectedPrimaryCategory = null; void this.render(); };
            }
            const canvas = chartCard.createDiv({ cls: 'aa-chart' }).createEl('canvas');
            this.renderCategoryChart(canvas, displayStats);
            chartCard.createDiv({ cls: 'ap-cap', text: '点分类看子分类；按住 ⌥ 或 ⌘ 点击可以重命名分类。' });

            const trendCard = charts.createDiv({ cls: 'ap-card aa-chart-card' });
            trendCard.createDiv({ cls: 'ap-label', text: '月度趋势' });
            const trendCanvas = trendCard.createDiv({ cls: 'aa-chart' }).createEl('canvas');
            void this.renderTrendChart(trendCanvas, this.allStats);

            const paymentCard = charts.createDiv({ cls: 'ap-card aa-chart-card' });
            paymentCard.createDiv({ cls: 'ap-label', text: '支付方式' });
            const paymentCanvas = paymentCard.createDiv({ cls: 'aa-chart' }).createEl('canvas');
            this.renderPaymentMethodChart(paymentCanvas, displayStats);

            if (this.selectedUserId === 'all' && this.plugin.settings.users.length > 1) {
                const contribCard = charts.createDiv({ cls: 'ap-card aa-chart-card' });
                contribCard.createDiv({ cls: 'ap-label', text: '成员' });
                const contribCanvas = contribCard.createDiv({ cls: 'aa-chart' }).createEl('canvas');
                this.renderContributionChart(contribCanvas, rawStats);
            }
        }
    }


    private adjustDate(delta: number) {
        if (this.chartScope === 'day') {
            this.currentDate.setDate(this.currentDate.getDate() + delta);
        } else if (this.chartScope === 'month') {
            this.currentDate.setMonth(this.currentDate.getMonth() + delta);
        } else if (this.chartScope === 'year') {
            this.currentDate.setFullYear(this.currentDate.getFullYear() + delta);
        }
        this.selectedPrimaryCategory = null;
        this.selectedDailyCategory = null;
    }

    private exportData(stats: MonthlyStats) {
        const header = ['日期', '描述', '分类', '金额', '币种', '汇率', '基准金额', '支付方式'];
        const rows = stats.transactions.map(t => [t.date, t.description, t.category, t.amount.toFixed(2), t.currency, (t.rate || 1).toString(), t.baseAmount.toFixed(2), t.paymentMethod || '未分类']);
        const csv = [header.join(','), ...rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(','))].join('\n');
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `transactions-${stats.month}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    // 辅助：创建指标卡片
    private createMetricCard(parent: HTMLElement, label: string, value: string, suffix: string = '', cls: string = '') {
        const card = parent.createDiv({ cls: `aa-metric ${cls}`.trim() });
        const labelEl = card.createSpan({ text: label, cls: 'ap-label' });
        const valContainer = card.createDiv();
        const valEl = valContainer.createSpan({ text: value, cls: 'ap-stat-value' });
        if (suffix) valContainer.createSpan({ text: suffix, cls: 'ap-stat-unit' });
        return { labelEl, valEl };
    }

    // 辅助：合并所有月份为一个数据集，便于跨月过滤
    private mergeAllMonths(): MonthlyStats {
        const tx = this.allStats.flatMap(s => s.transactions);
        return this.buildStatsFromTransactions(tx, 'ALL');
    }

    // 辅助：根据交易列表构建一个最小 MonthlyStats（其余字段后续由 getConvertedStats 计算）
    private buildStatsFromTransactions(transactions: TransactionRecord[], label: string): MonthlyStats {
        return {
            month: label,
            total: 0,
            categories: {},
            secondaryCategories: {},
            dailyStats: {},
            paymentMethods: {},
            transactions
        };
    }

    private async renderTransactionDetailView(parent: HTMLElement, aside: HTMLElement, stats: MonthlyStats, navStats: MonthlyStats) {
        // 1. The ledger itself
        const detailsCard = parent.createDiv({ cls: 'aa-ledger' });

        const analysis = aside.createEl('details', { cls: 'ap-card is-flat aa-analysis' });
        analysis.createEl('summary', { cls: 'ap-label', text: '按周期看 · 分类细分' });
        const rightPanel = analysis.createDiv('aa-analysis-body');

        // --- Scope-aware navigation ---
        const navCard = rightPanel.createDiv({ cls: 'aa-nav-card' });
        const navTitle = this.chartScope === 'day' ? '每日开支' :
            this.chartScope === 'month' ? '月度开支' : '年度开支';
        navCard.createDiv({ cls: 'ap-cap', text: navTitle });

        const navTable = navCard.createEl('table', { cls: 'aa-table is-compact' });
        const navThead = navTable.createEl('thead');
        const navHeaderRow = navThead.createEl('tr');

        const createNavSortHeader = (text: string, col: 'period' | 'amount') => {
            const th = navHeaderRow.createEl('th', { text, cls: 'is-sortable' });
            if (this.navSortColumn === col) {
                th.innerText += this.navSortDirection === 'asc' ? ' ▲' : ' ▼';
            }
            th.onclick = () => {
                if (this.navSortColumn === col) {
                    this.navSortDirection = this.navSortDirection === 'asc' ? 'desc' : 'asc';
                } else {
                    this.navSortColumn = col;
                    this.navSortDirection = col === 'period' ? 'desc' : 'desc'; // Default to desc for both
                }
                void this.render();
            };
            return th;
        };

        createNavSortHeader('周期', 'period');
        createNavSortHeader('金额', 'amount');

        const navTbody = navTable.createEl('tbody');

        let sortedItems: string[] = [];
        let itemAmounts: Record<string, number> = {};

        if (this.chartScope === 'day') {
            const daily: Record<string, number> = navStats.dailyStats || {};
            sortedItems = Object.keys(daily);
            itemAmounts = daily;
        } else if (this.chartScope === 'month') {
            const daily: Record<string, number> = navStats.dailyStats || {};
            Object.keys(daily).forEach(day => {
                const m = day.slice(0, 7);
                itemAmounts[m] = (itemAmounts[m] || 0) + (daily[day] || 0);
            });
            sortedItems = Object.keys(itemAmounts);
        } else {
            const daily: Record<string, number> = navStats.dailyStats || {};
            Object.keys(daily).forEach(day => {
                const y = day.slice(0, 4);
                itemAmounts[y] = (itemAmounts[y] || 0) + (daily[day] || 0);
            });
            sortedItems = Object.keys(itemAmounts);
        }

        // Apply Navigation Sorting
        sortedItems.sort((a, b) => {
            let res = 0;
            if (this.navSortColumn === 'period') {
                res = a.localeCompare(b);
            } else {
                res = (itemAmounts[a] || 0) - (itemAmounts[b] || 0);
            }
            return this.navSortDirection === 'asc' ? res : -res;
        });

        // Determine active selection
        let activeKey = this.selectedTransactionDate;
        if (this.chartScope === 'day') {
            const yyyy_mm_dd = `${this.currentDate.getFullYear()}-${(this.currentDate.getMonth() + 1).toString().padStart(2, '0')}-${this.currentDate.getDate().toString().padStart(2, '0')}`;
            if (!activeKey || !sortedItems.includes(activeKey)) activeKey = yyyy_mm_dd;
        } else if (this.chartScope === 'month') {
            const yyyy_mm = `${this.currentDate.getFullYear()}-${(this.currentDate.getMonth() + 1).toString().padStart(2, '0')}`;
            if (!activeKey || activeKey.length > 7) activeKey = yyyy_mm;
        } else {
            const yyyy = this.currentDate.getFullYear().toString();
            if (!activeKey || activeKey.length > 4) activeKey = yyyy;
        }

        sortedItems.forEach(key => {
            const amount = itemAmounts[key] || 0;
            const row = navTbody.createEl('tr', { cls: `is-clickable${key === activeKey ? ' is-selected' : ''}` });
            row.createEl('td', { text: key, cls: 'ap-num' });
            row.createEl('td', { text: `${this.formatAmount(amount)} ${this.displayCurrency}`, cls: 'ap-num is-right' });

            row.onclick = () => {
                if (this.chartScope === 'day') {
                    this.currentDate = new Date(key);
                } else if (this.chartScope === 'month') {
                    const parts = key.split('-');
                    const y = parseInt(parts[0] || '0');
                    const m = parseInt(parts[1] || '1');
                    this.currentDate = new Date(y, m - 1, 1);
                } else {
                    this.currentDate = new Date(parseInt(key), 0, 1);
                }
                this.selectedTransactionDate = key;
                this.selectedDailyCategory = null;
                void this.render();
            };
        });

        // --- SUB-CHART (Right Panel) ---
        const chartCard = rightPanel.createDiv({ cls: 'aa-nav-chart' });
        const displayDate = activeKey;

        if (this.selectedSecondaryCategory && this.selectedDailyCategory) {
            chartCard.createDiv({ cls: 'ap-cap', text: `${displayDate} · ${this.selectedDailyCategory} › ${this.selectedSecondaryCategory}` });
            const backBtn = chartCard.createEl('button', { text: '← 返回 ' + this.selectedDailyCategory, cls: 'aa-link-btn' });
            backBtn.onclick = () => {
                this.selectedSecondaryCategory = null;
                void this.render();
            };
        } else if (this.selectedDailyCategory) {
            chartCard.createDiv({ cls: 'ap-cap', text: `${displayDate} · ${this.selectedDailyCategory}` });
            const backBtn = chartCard.createEl('button', { text: '← 返回全部分类', cls: 'aa-link-btn' });
            backBtn.onclick = () => {
                this.selectedDailyCategory = null;
                this.selectedSecondaryCategory = null;
                void this.render();
            };
        } else {
            chartCard.createDiv({ cls: 'ap-cap', text: displayDate ? `${displayDate} 分类统计` : '每日明细' });
        }

        if (displayDate) {
            const canvasWrapper = chartCard.createDiv({ cls: 'aa-chart is-small' });
            const canvas = canvasWrapper.createEl('canvas');
            this.renderDailyCategoryChart(canvas, navStats, displayDate);


            let filteredTransactions: TransactionRecord[] = [];
            if (this.chartScope === 'day') {
                filteredTransactions = stats.transactions.filter(t => t.date === displayDate);
            } else if (this.chartScope === 'month') {
                filteredTransactions = stats.transactions.filter(t => t.date.startsWith(displayDate));
            } else {
                // Year scope
                // We should use stats.transactions because it is already filtered by Search Query and User ID from renderGrid context
                filteredTransactions = stats.transactions.filter(t => t.date.startsWith(displayDate));
            }

            // Apply global filters (Category, Payment Method)
            if (this.selectedCats.size > 0) {
                filteredTransactions = filteredTransactions.filter(t => {
                    const primary = (t.category.split(/[/>:：]/)[0] || '其他').trim();
                    return this.selectedCats.has(primary);
                });
            }

            if (this.selectedPMs.size > 0) {
                filteredTransactions = filteredTransactions.filter(t => {
                    const pm = t.paymentMethod || '未分类';
                    return this.selectedPMs.has(pm);
                });
            }

            // Apply category drill-down filter
            if (this.selectedSecondaryCategory && this.selectedDailyCategory) {
                // Filter by full category path (primary/secondary)
                filteredTransactions = filteredTransactions.filter(t => {
                    const parts = t.category.split(/[/>:：]/);
                    const primary = (parts[0] || '其他').trim();
                    const secondary = (parts[1] || '一般').trim();
                    return primary === this.selectedDailyCategory && secondary === this.selectedSecondaryCategory;
                });
            } else if (this.selectedDailyCategory) {
                filteredTransactions = filteredTransactions.filter(t => {
                    const primary = (t.category.split(/[/>:：]/)[0] || '其他').trim();
                    return primary === this.selectedDailyCategory;
                });
            }

            // Sort
            filteredTransactions.sort((a, b) => {
                let valA: any = a[this.sortColumn as keyof TransactionRecord];
                let valB: any = b[this.sortColumn as keyof TransactionRecord];

                if (this.sortColumn === 'amount') {
                    valA = a.baseAmount;
                    valB = b.baseAmount;
                }

                if (valA < valB) return this.sortDirection === 'asc' ? -1 : 1;
                if (valA > valB) return this.sortDirection === 'asc' ? 1 : -1;
                return 0;
            });

            if (filteredTransactions.length >= 0) { // Keep table even if empty to show Quick Add

                // Batch Action Bar
                const batchBar = detailsCard.createDiv({ cls: 'ap-notice aa-batch-bar' });
                const batchCount = batchBar.createSpan({ cls: 'ap-grow', text: '已选择 0 项' });
                const batchSplitBtn = batchBar.createEl('button', { text: '批量 AA', cls: 'mod-cta' });

                const selectedSet = new Set<string>();

                const updateDynamicSummary = async () => {
                    const labelTotal = this.containerEl.querySelector('#aa-dynamic-total-label') as HTMLElement;
                    const valTotal = this.containerEl.querySelector('#aa-dynamic-total-val') as HTMLElement;
                    const labelCount = this.containerEl.querySelector('#aa-dynamic-count-label') as HTMLElement;
                    const valCount = this.containerEl.querySelector('#aa-dynamic-count-val') as HTMLElement;

                    if (!labelTotal || !valTotal || !labelCount || !valCount) return;

                    let isSelecting = selectedSet.size > 0;
                    let targetTransactions = isSelecting 
                        ? filteredTransactions.filter(tx => selectedSet.has(JSON.stringify(tx))) 
                        : filteredTransactions;

                    let totalAmt = 0;
                    for (const tx of targetTransactions) {
                        let displayAmt = tx.amount;
                        if (this.displayCurrency !== tx.currency) {
                            if (this.displayCurrency === this.plugin.settings.baseCurrency) {
                                displayAmt = tx.baseAmount;
                            } else {
                                displayAmt = await this.plugin.fxService.convert(tx.baseAmount, this.plugin.settings.baseCurrency, this.displayCurrency, tx.date);
                            }
                        }
                        totalAmt += displayAmt;
                    }

                    labelTotal.innerText = isSelecting ? '已选总和' : '期间支出';
                    valTotal.innerText = this.formatAmount(totalAmt);
                    
                    labelCount.innerText = isSelecting ? '选中笔数' : '匹配笔数';
                    valCount.innerText = targetTransactions.length.toString();

                    if (isSelecting) {
                        batchCount.innerText = `已选择 ${selectedSet.size} 项`;
                        batchBar.addClass('is-visible');
                    } else {
                        batchBar.removeClass('is-visible');
                    }
                };

                // Initialize dynamic summary initially
                void updateDynamicSummary();

                const updateBatchUI = async () => {
                    await updateDynamicSummary();
                };

                batchSplitBtn.onclick = () => {
                    const existing = detailsCard.querySelector('.batch-aa-panel');
                    if (existing) { existing.remove(); return; }

                    const panel = detailsCard.createDiv({ cls: 'ap-card aa-split-panel batch-aa-panel' });
                    const detailTable = detailsCard.querySelector('.aa-table');
                    if (detailTable) detailsCard.insertBefore(panel, detailTable);

                    panel.createDiv({ cls: 'ap-label', text: `批量分账 · ${selectedSet.size} 笔` });

                    const userChecks: Record<string, HTMLInputElement> = {};
                    const usersContainer = panel.createDiv({ cls: 'aa-split-users is-inline' });

                    this.plugin.settings.users.forEach(u => {
                        const label = usersContainer.createEl('label', { cls: 'aa-split-user' });
                        const chk = label.createEl('input', { type: 'checkbox' });
                        chk.checked = true;
                        label.createEl('span', { text: u.name });
                        userChecks[u.id] = chk;
                    });

                    const actionContainer = panel.createDiv({ cls: 'ap-actions aa-split-actions' });
                    const confirmBtn = actionContainer.createEl('button', { text: '确认批量分账', cls: 'mod-cta' });

                    confirmBtn.onclick = async () => {
                        const participants = this.plugin.settings.users.filter(u => {
                            const chk = userChecks[u.id];
                            return chk && chk.checked;
                        });
                        if (participants.length <= 1) {
                            new Notice('分账至少需要 2 人参与');
                            return;
                        }

                        new Notice(`开始批量处理 ${selectedSet.size} 笔交易...`);

                        for (const tx of filteredTransactions) {
                            if (!selectedSet.has(JSON.stringify(tx))) continue;
                            if (tx.description.includes('(AA)')) continue;

                            const splitAmount = tx.amount / participants.length;
                            const ownerId = tx.userId || 'default';

                            const othersArray: { userId: string, amount: number }[] = [];
                            participants.forEach(p => {
                                if (p.id !== ownerId) {
                                    othersArray.push({ userId: p.id, amount: splitAmount });
                                }
                            });

                            if (othersArray.length > 0) {
                                await this.plugin.dataService.splitTransaction(tx, othersArray);
                            }
                        }

                        new Notice('批量分账完成！');
                        panel.remove();
                        await this.refresh();
                    };

                    const cancelBtn = actionContainer.createEl('button', { text: '取消' });
                    cancelBtn.onclick = () => panel.remove();
                };

                const detailTable = detailsCard.createEl('table', { cls: 'aa-table' });
                const detailThead = detailTable.createEl('thead');
                const detailHeaderRow = detailThead.createEl('tr');

                // Header Checkbox
                const checkTh = detailHeaderRow.createEl('th', { cls: 'checkbox-col hide-mobile', attr: { 'data-hide': 'mobile' } });
                const masterCheck = checkTh.createEl('input', { type: 'checkbox' });
                masterCheck.onchange = () => {
                    const isChecked = masterCheck.checked;
                    selectedSet.clear();
                    if (isChecked) {
                        filteredTransactions.forEach(tx => {
                            if (!tx.description.includes('(AA)')) selectedSet.add(JSON.stringify(tx));
                        });
                    }
                    detailTbody.querySelectorAll('.batch-check').forEach((c: HTMLInputElement) => {
                        if (!c.disabled) c.checked = isChecked;
                    });
                    void updateBatchUI();
                };

                const createSortHeader = (text: string, col: string, width?: string, cls?: string) => {
                    const th = detailHeaderRow.createEl('th', { text, cls: (cls || '') });
                    if (width) th.setCssProps({ width });
                    if (col !== 'action') {
                        th.addClass('is-sortable');
                        if (this.sortColumn === col) {
                            th.innerText += this.sortDirection === 'asc' ? ' ▲' : ' ▼';
                        }
                        th.onclick = () => {
                            if (this.sortColumn === col) {
                                this.sortDirection = this.sortDirection === 'asc' ? 'desc' : 'asc';
                            } else {
                                this.sortColumn = col;
                                this.sortDirection = 'desc';
                            }
                            void this.render();
                        };
                    }
                    return th;
                };

                createSortHeader('日期', 'date', '100px', 'date-col hide-mobile').setAttribute('data-hide', 'mobile');
                createSortHeader('描述', 'description');
                createSortHeader('分类', 'category', undefined, 'hide-mobile').setAttribute('data-hide', 'mobile');
                createSortHeader('金额', 'amount', undefined, 'is-right');
                createSortHeader('支付方式', 'paymentMethod', undefined, 'hide-mobile').setAttribute('data-hide', 'mobile');
                detailHeaderRow.createEl('th', { text: '操作', cls: 'hide-mobile', attr: { 'data-hide': 'mobile' } });

                const detailTbody = detailTable.createEl('tbody');
                // Same date, description and amount more than once: real repeat purchases, kept apart on purpose.
                const twinCounts = new Map<string, number>();
                for (const tx of filteredTransactions) {
                    const key = `${tx.userId}|${tx.date}|${tx.description}|${tx.amount}|${tx.currency}`;
                    twinCounts.set(key, (twinCounts.get(key) || 0) + 1);
                }
                // When sorted by date, each day gets a header row with its total, like a page in a ledger.
                const groupByDay = this.sortColumn === 'date';
                detailTable.toggleClass('is-grouped', groupByDay);
                const dayTotals = new Map<string, { el: HTMLElement, total: number }>();
                for (const tx of filteredTransactions) {
                    if (groupByDay && !dayTotals.has(tx.date)) {
                        const dayRow = detailTbody.createEl('tr', { cls: 'aa-day-row' });
                        const cell = dayRow.createEl('td', { attr: { colspan: '7' } });
                        cell.createSpan({ cls: 'aa-day-label', text: this.formatDayLabel(tx.date) });
                        const totalEl = cell.createSpan({ cls: 'aa-day-total ap-num' });
                        dayTotals.set(tx.date, { el: totalEl, total: 0 });
                    }
                    const row = detailTbody.createEl('tr', { cls: 'aa-tx-row' });

                    // Row Checkbox
                    const checkTd = row.createEl('td', { cls: 'checkbox-col hide-mobile', attr: { 'data-hide': 'mobile' } });
                    const chk = checkTd.createEl('input', { type: 'checkbox', cls: 'batch-check' });
                    if (tx.description.includes('(AA)')) {
                        chk.disabled = true;
                    }
                    chk.onchange = () => {
                        const key = JSON.stringify(tx);
                        if (chk.checked) selectedSet.add(key);
                        else selectedSet.delete(key);
                        void updateBatchUI();
                    };

                    row.createEl('td', { text: tx.date, cls: 'date-col hide-mobile', attr: { 'data-hide': 'mobile' } });

                    const descTd = row.createEl('td');
                    // User Distinction
                    // Only a shared ledger needs to say whose spending a row is.
                    if (this.plugin.settings.users.length > 1) {
                        const userId = tx.userId || 'default';
                        const user = this.plugin.settings.users.find(u => u.id === userId);
                        if (user) {
                            const badge = descTd.createSpan({ text: user.name.charAt(0).toUpperCase(), cls: 'aa-user-badge', attr: { title: user.name } });
                            badge.setCssProps({ '--aa-user': user.color || 'var(--ap-label-3)' });
                        }
                    }
                    descTd.createSpan({ text: tx.description });
                    const twins = twinCounts.get(`${tx.userId}|${tx.date}|${tx.description}|${tx.amount}|${tx.currency}`) || 0;
                    if (twins > 1) descTd.createSpan({ cls: 'ap-pill is-good aa-twin', text: `同价 ×${twins}，分别保留` });

                    descTd.ondblclick = () => this.makeCellEditable(descTd, tx, 'description');

                    const catTd = row.createEl('td', { text: tx.category, cls: 'hide-mobile', attr: { 'data-hide': 'mobile' } });
                    catTd.ondblclick = () => this.makeCellEditable(catTd, tx, 'category');

                    // Currency Conversion
                    let displayAmt = tx.amount;
                    let displayCur = tx.currency;

                    if (this.displayCurrency !== tx.currency) {
                        if (this.displayCurrency === this.plugin.settings.baseCurrency) {
                            displayAmt = tx.baseAmount;
                            displayCur = this.plugin.settings.baseCurrency;
                        } else {
                            displayAmt = await this.plugin.fxService.convert(tx.baseAmount, this.plugin.settings.baseCurrency, this.displayCurrency, tx.date);
                            displayCur = this.displayCurrency;
                        }
                    }

                    const amountTd = row.createEl('td', { cls: 'aa-amount-cell ap-num' });
                    amountTd.createSpan({ text: this.formatAmount(displayAmt) });
                    amountTd.createSpan({ cls: 'ap-amt-unit', text: displayCur });
                    const day = dayTotals.get(tx.date);
                    if (day) day.total += displayAmt;
                    amountTd.ondblclick = () => {
                        if (this.displayCurrency !== tx.currency) {
                            new Notice('请切换回原始币种进行编辑金额');
                            return;
                        }
                        this.makeCellEditable(amountTd, tx, 'amount');
                    };

                    const payTd = row.createEl('td', { text: tx.paymentMethod || '未分类', cls: 'hide-mobile', attr: { 'data-hide': 'mobile' } });
                    payTd.ondblclick = () => this.makeCellEditable(payTd, tx, 'paymentMethod');
                    const actionsCell = row.createEl('td', { cls: 'action-cell hide-mobile', attr: { 'data-hide': 'mobile' } });

                    // AA Button
                    const aaBtn = actionsCell.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': 'AA 分账' } });
                    setIcon(aaBtn, 'users');
                    if (tx.description.includes('(AA)')) {
                        aaBtn.disabled = true;
                    }

                    aaBtn.onclick = () => {
                        const existing = actionsCell.querySelector('.inline-aa-panel');
                        if (existing) { existing.remove(); return; }

                        const ownerId = tx.userId || 'default';
                        const panel = actionsCell.createDiv({ cls: 'ap-card aa-split-panel inline-aa-panel' });
                        panel.createDiv({ cls: 'ap-label', text: `发起分账 · 总金额 ${tx.amount}` });

                        const userChecks: Record<string, HTMLInputElement> = {};
                        const userInputs: Record<string, HTMLInputElement> = {};

                        const usersContainer = panel.createDiv({ cls: 'aa-split-users' });
                        
                        const calcRemainder = () => {
                            let othersTotal = 0;
                            const ownerInput = userInputs[ownerId];
                            this.plugin.settings.users.forEach(u => {
                                if (u.id !== ownerId && userChecks[u.id]?.checked && userInputs[u.id]) {
                                    othersTotal += parseFloat(userInputs[u.id]!.value || '0');
                                }
                            });
                            if (ownerInput) {
                                const remainder = tx.amount - othersTotal;
                                ownerInput.value = Math.max(0, remainder).toFixed(2);
                            }
                        };

                        const recalculateEqual = () => {
                            const participants = this.plugin.settings.users.filter(u => userChecks[u.id] && userChecks[u.id]!.checked);
                            if (participants.length === 0) return;
                            const splitAmount = tx.amount / participants.length;
                            
                            let othersTotal = 0;
                            participants.forEach(u => {
                                if (u.id !== ownerId && userInputs[u.id]) {
                                    userInputs[u.id]!.value = splitAmount.toFixed(2);
                                    othersTotal += parseFloat(splitAmount.toFixed(2));
                                }
                            });
                            const ownerInput = userInputs[ownerId];
                            if (ownerInput) {
                                ownerInput.value = Math.max(0, tx.amount - othersTotal).toFixed(2);
                            }
                        };

                        this.plugin.settings.users.forEach(u => {
                            const isOwner = u.id === ownerId;
                            const row = usersContainer.createDiv({ cls: 'aa-split-row' });

                            const label = row.createEl('label', { cls: 'aa-split-user ap-grow' });
                            const chk = label.createEl('input', { type: 'checkbox' });
                            chk.checked = true; // default all checked
                            label.createEl('span', { text: u.name + (isOwner ? ' (付款方)' : '') });
                            userChecks[u.id] = chk;

                            const input = row.createEl('input', { type: 'number', cls: 'aa-split-amount', attr: { step: '0.01', min: '0' } });
                            userInputs[u.id] = input;

                            if (isOwner) {
                                input.readOnly = true;
                            } else {
                                input.oninput = () => calcRemainder();
                            }

                            chk.onchange = () => {
                                if (!isOwner) {
                                    input.disabled = !chk.checked;
                                    if (!chk.checked) input.value = '0';
                                }
                                recalculateEqual();
                            };
                        });

                        recalculateEqual();

                        const actionContainer = panel.createDiv({ cls: 'ap-actions aa-split-actions' });

                        const equalBtn = actionContainer.createEl('button', { text: '重置平分' });
                        equalBtn.onclick = () => recalculateEqual();

                        const confirmBtn = actionContainer.createEl('button', { text: '确认分账', cls: 'mod-cta' });
                        confirmBtn.onclick = async () => {
                            const othersArray: { userId: string, amount: number }[] = [];
                            let totalSplitOut = 0;
                            
                            for (const u of this.plugin.settings.users) {
                                if (u.id !== ownerId && userChecks[u.id]?.checked && userInputs[u.id]) {
                                    const val = parseFloat(userInputs[u.id]!.value);
                                    if (isNaN(val) || val < 0) {
                                        new Notice(`请为 ${u.name} 输入有效金额`);
                                        return;
                                    }
                                    if (val > 0) {
                                        othersArray.push({ userId: u.id, amount: val });
                                        totalSplitOut += val;
                                    }
                                }
                            }

                            if (othersArray.length === 0) {
                                new Notice('未设定任何其他人的分账金额');
                                return;
                            }
                            
                            if (totalSplitOut > tx.amount + 0.01) {
                                new Notice('分账总额超过了这笔交易的总金额！');
                                return;
                            }

                            await this.plugin.dataService.splitTransaction(tx, othersArray);
                            new Notice('分账成功');
                            panel.remove();
                            await this.refresh();
                        };

                        const cancelBtn = actionContainer.createEl('button', { text: '取消' });
                        cancelBtn.onclick = () => panel.remove();
                    };

                    // Edit Button
                    const editBtn = actionsCell.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': '编辑' } });
                    setIcon(editBtn, 'pencil');
                    editBtn.onclick = () => {
                        new EditTransactionModal(this.app, tx, this.plugin, () => {
                            void this.refresh();
                        }).open();
                    };

                    // Open note link
                    const openBtn = actionsCell.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': '在新标签页打开源文件' } });
                    setIcon(openBtn, 'external-link');
                    openBtn.onclick = async () => {
                        const file = this.plugin.dataService.getLocationFile(tx);
                        if (file) {
                            await this.app.workspace.getLeaf('tab').openFile(file);
                        } else {
                            new Notice('未找到源文件');
                        }
                    };
                }

                for (const day of dayTotals.values()) day.el.setText(`${this.formatAmount(day.total)} ${this.displayCurrency}`);

                // --- Inline Quick Add Row ---
                const addRow = detailTbody.createEl('tr', { cls: 'aa-add-row quick-add-row' });
                addRow.createEl('td', { cls: 'checkbox-col hide-mobile', attr: { 'data-hide': 'mobile' } });

                // Show date input in Quick Add row for non-day scopes
                const dateEntryTd = addRow.createEl('td', { cls: 'date-col hide-mobile', attr: { 'data-hide': 'mobile' } });
                const dateEntryInput = dateEntryTd.createEl('input', { type: 'date', cls: 'quick-add-date-input' });

                // Set default date for Quick Add
                let defaultAddDate = '';
                if (this.chartScope === 'day') {
                    defaultAddDate = displayDate;
                } else if (this.chartScope === 'month') {
                    defaultAddDate = `${displayDate}-01`;
                } else {
                    defaultAddDate = `${displayDate}-01-01`;
                }
                dateEntryInput.value = defaultAddDate;

                const descTd = addRow.createEl('td');
                const descInput = descTd.createEl('input', { type: 'text', attr: { placeholder: '新账目描述...' } });

                const catTd = addRow.createEl('td', { cls: 'hide-mobile', attr: { 'data-hide': 'mobile' } });
                const catInput = catTd.createEl('input', { type: 'text', attr: { placeholder: '分类' } });

                const amountTd = addRow.createEl('td');
                const amountInput = amountTd.createEl('input', { type: 'number', attr: { placeholder: '金额', step: '0.01' } });

                const payTd = addRow.createEl('td', { cls: 'hide-mobile', attr: { 'data-hide': 'mobile' } });
                const payInput = payTd.createEl('input', { type: 'text', attr: { placeholder: '支付方式' } });

                const actionsCell = addRow.createEl('td', { cls: 'action-cell hide-mobile', attr: { 'data-hide': 'mobile' } });
                const saveBtn = actionsCell.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': '快速添加' } });
                setIcon(saveBtn, 'plus-circle');

                const handleAdd = async () => {
                    const amount = parseFloat(amountInput.value);
                    if (!amount || amount <= 0) {
                        new Notice('请输入有效金额');
                        return;
                    }
                    const desc = descInput.value || '未命名交易';
                    const category = catInput.value || '其他';
                    const payment = payInput.value || '未分类';
                    const date = dateEntryInput.value || defaultAddDate;
                    const currency = this.displayCurrency;

                    const baseAmount = await this.plugin.fxService.convert(amount, currency, this.plugin.settings.baseCurrency, date);
                    const rate = await this.plugin.fxService.getExchangeRate(currency, this.plugin.settings.baseCurrency, date);
                    const yearMonth = date.slice(0, 7);

                    await this.plugin.dataService.appendBatchToMonthlyReport(yearMonth, [{
                        date,
                        description: desc,
                        category,
                        amount,
                        currency,
                        baseAmount,
                        rate,
                        paymentMethod: payment
                    }]);

                    new Notice('账目已添加');
                    await this.refresh();
                };

                saveBtn.onclick = handleAdd;
                [descInput, catInput, amountInput, payInput].forEach(input => {
                    input.onkeydown = (e) => { if (e.key === 'Enter') void handleAdd(); };
                });
            } else {
                detailsCard.createDiv({ cls: 'ap-cap', text: '暂无交易记录' });
            }
        } else {
            chartCard.createDiv({ cls: 'ap-cap', text: '点上面的周期查看明细' });
        }
    }

    /** This month's spending against the budgets in settings, in the report currency. */
    private renderBudget(parent: HTMLElement, allTx: TransactionRecord[]) {
        const settings = this.plugin.settings;
        const budgets = parseBudgets(settings.budgetText);
        const hasBudgets = budgets.total !== null || Object.keys(budgets.categories).length > 0;
        const hasRecurring = settings.recurring.some(r => r.enabled && r.amount > 0);
        if (!hasBudgets && !hasRecurring) return;

        const month = new Date().toISOString().slice(0, 7);
        const card = parent.createDiv({ cls: 'ap-card is-flat aa-budget' });
        const head = card.createDiv({ cls: 'ap-split' });
        head.createDiv({ cls: 'ap-label', text: `本月预算 · ${settings.baseCurrency}` });
        if (hasRecurring) {
            const add = head.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': '添加本月固定支出' } });
            setIcon(add, 'calendar-plus');
            add.onclick = () => void this.plugin.addRecurringForMonth(month);
        }
        if (!hasBudgets) {
            card.createDiv({ cls: 'ap-cap', text: '在设置 → 月度预算里填写后，这里显示本月用了多少。' });
            return;
        }
        const usage = budgetUsage(allTx, month, budgets);
        const rows = usage.total ? [usage.total, ...usage.rows] : usage.rows;
        for (const row of rows) {
            const tone = row.ratio > 1 ? 'is-danger' : row.ratio >= 0.8 ? 'is-warn' : 'is-good';
            const item = card.createDiv({ cls: `aa-budget-row${row === usage.total ? ' is-total' : ''}` });
            const line = item.createDiv({ cls: 'ap-split' });
            line.createSpan({ text: row.category });
            line.createSpan({ cls: `ap-amt aa-budget-amt ${tone}`, text: `${this.formatAmount(row.spent)} / ${this.formatAmount(row.limit)}` });
            const meter = item.createDiv({ cls: `ap-meter ${tone}` });
            meter.createDiv({ cls: 'ap-meter-fill' }).setCssProps({ '--ap-value': `${Math.min(row.ratio, 1) * 100}%` });
            if (row.ratio > 1) item.createDiv({ cls: 'ap-cap aa-budget-over', text: `超出 ${this.formatAmount(row.spent - row.limit)}` });
        }
    }

    private renderDailyCategoryChart(canvas: HTMLCanvasElement, stats: MonthlyStats, date: string) {
        const base = this.plugin.settings.baseCurrency;
        const target = this.displayCurrency;

        // Scope-aware filtering
        let scopedTransactions: TransactionRecord[] = [];
        if (this.chartScope === 'day') {
            scopedTransactions = stats.transactions.filter(t => t.date === date);
        } else if (this.chartScope === 'month') {
            scopedTransactions = stats.transactions.filter(t => t.date.startsWith(date));
        } else {
            // Year scope - need to pull from allStats
            const allTx = this.allStats.flatMap(s => s.transactions);
            scopedTransactions = allTx.filter(t => t.date.startsWith(date));

            // Apply user filter for year scope
            if (this.selectedUserId !== 'all') {
                scopedTransactions = scopedTransactions.filter(t => t.userId === this.selectedUserId || (!t.userId && this.selectedUserId === 'default'));
            }
        }

        const labels: string[] = [];
        const values: number[] = [];
        const dict: Record<string, number> = {};

        void Promise.all(scopedTransactions.map(async t => {
            const converted = await this.plugin.fxService.convert(t.baseAmount, base, target, t.date);
            const parts = t.category.split(/[/>:：]/);
            const primary = (parts[0] || '其他').trim();
            const secondary = (parts[1] || '一般').trim();
            if (this.selectedDailyCategory) {
                if (primary === this.selectedDailyCategory) {
                    dict[secondary] = (dict[secondary] || 0) + converted;
                }
            } else {
                dict[primary] = (dict[primary] || 0) + converted;
            }
        })).then(() => {
            labels.push(...Object.keys(dict));
            values.push(...Object.values(dict));
            const textColor = this.getObsidianColor('--ap-label-2');
            new Chart(canvas, {
                type: 'pie',
                data: { labels, datasets: [{ data: values, backgroundColor: this.seriesColors(), borderColor: this.getObsidianColor('--ap-page'), borderWidth: 2 }] },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    onClick: (evt, elements) => {
                        if (elements && elements.length > 0 && elements[0]) {
                            const index = elements[0].index;
                            const category = labels[index];

                            // Check for Alt/Option key
                            const nativeEvent = evt.native as MouseEvent;
                            if (nativeEvent && (nativeEvent.altKey || nativeEvent.metaKey)) { // metaKey for Command on Mac, altKey for Option
                                if (category) {
                                    let fullCategory = category;
                                    if (this.selectedDailyCategory) {
                                        fullCategory = `${this.selectedDailyCategory} / ${category}`;
                                    }
                                    new RenameCategoryModal(this.app, this.plugin, fullCategory, () => {
                                        void this.refresh();
                                    }).open();
                                }
                                return;
                            }

                            if (category) {
                                if (this.selectedDailyCategory) {
                                    // Already in secondary view - allow switching between secondaries
                                    this.selectedSecondaryCategory = category;
                                    void this.render();
                                } else {
                                    // Clicking on primary category
                                    this.selectedDailyCategory = category;
                                    void this.render();
                                }
                            }
                        }
                    },
                    plugins: {
                        legend: {
                            position: 'bottom',
                            labels: {
                                color: textColor,
                                boxWidth: 12,
                                font: { size: 11 }
                            }
                        }
                    }
                }
            });
        });
    }

    /**
     * Reads a colour token from the dashboard, so charts follow the theme. Tokens may be
     * color-mix() expressions, which canvas does not take, so the browser resolves them to rgb.
     */
    private getObsidianColor(variable: string): string {
        const scope = this.contentEl.querySelector('.ai-accounting-dashboard-container') || document.body;
        const value = getComputedStyle(scope).getPropertyValue(variable).trim();
        if (!value) return '';
        const probe = (scope as HTMLElement).createDiv();
        probe.setCssProps({ color: value });
        const resolved = getComputedStyle(probe).color;
        probe.remove();
        return resolved || value;
    }

    private seriesColors(): string[] {
        return [1, 2, 3, 4, 5, 6, 7, 8].map(i => this.getObsidianColor(`--aa-series-${i}`)).filter(Boolean);
    }

    /** Any CSS colour with a given opacity, resolved by the browser. */
    private withAlpha(color: string, alpha: number): string {
        const probe = document.body.createDiv();
        probe.setCssProps({ color });
        const rgb = getComputedStyle(probe).color;
        probe.remove();
        const parts = rgb.match(/[\d.]+/g);
        return parts && parts.length >= 3 ? `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, ${alpha})` : color;
    }

    private formatDayLabel(date: string): string {
        const [y, m, d] = date.split('-').map(part => parseInt(part, 10));
        const weekday = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date(y || 1970, (m || 1) - 1, d || 1).getDay()];
        return `${m} 月 ${d} 日 ${weekday}`;
    }

    // 金额格式化
    private formatAmount(n: number): string {
        return new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
    }

    private renderCategoryChart(canvas: HTMLCanvasElement, stats: MonthlyStats) {
        let labels: string[];
        let data: number[];

        if (this.selectedPrimaryCategory) {
            const secondaries = stats.secondaryCategories[this.selectedPrimaryCategory] || {};
            labels = Object.keys(secondaries);
            data = Object.values(secondaries);
        } else {
            labels = Object.keys(stats.categories);
            data = Object.values(stats.categories);
        }

        const textColor = this.getObsidianColor('--ap-label-2');

        new Chart(canvas, {
            type: 'doughnut',
            data: {
                labels: labels,
                datasets: [{
                    data: data,
                    backgroundColor: this.seriesColors(),
                    borderColor: this.getObsidianColor('--ap-page'),
                    borderWidth: 2
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                onClick: (evt, elements) => {
                    const activeElement = (elements && elements.length > 0) ? elements[0] : null;
                    if (activeElement) {
                        const index = activeElement.index;
                        const label = labels[index];

                        // Check for Alt/Option key
                        const nativeEvent = evt.native as MouseEvent;
                        if (nativeEvent && (nativeEvent.altKey || nativeEvent.metaKey)) {
                            if (label) {
                                let fullLabel = label;
                                if (this.selectedPrimaryCategory) {
                                    // If we are in secondary view, construct full path
                                    fullLabel = `${this.selectedPrimaryCategory} / ${label}`;
                                }
                                new RenameCategoryModal(this.app, this.plugin, fullLabel, () => {
                                    void this.refresh();
                                }).open();
                            }
                            return;
                        }

                        if (label && !this.selectedPrimaryCategory) {
                            this.selectedPrimaryCategory = label;
                            void this.render();
                        }

                        if (!this.selectedPrimaryCategory && label) {
                            this.selectedPrimaryCategory = label;
                            void this.render();
                        }
                    }
                },
                plugins: {
                    legend: {
                        position: 'bottom',
                        labels: {
                            color: textColor,
                            boxWidth: 10,
                            font: { size: 10 }
                        }
                    }
                }
            }
        });
    }

    private renderPaymentMethodChart(canvas: HTMLCanvasElement, stats: MonthlyStats) {
        const labels = Object.keys(stats.paymentMethods);
        const data = Object.values(stats.paymentMethods);

        const textColor = this.getObsidianColor('--ap-label-2');

        new Chart(canvas, {
            type: 'pie',
            data: {
                labels: labels,
                datasets: [{
                    data: data,
                    backgroundColor: this.seriesColors(),
                    borderColor: this.getObsidianColor('--ap-page'),
                    borderWidth: 2
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: 'bottom',
                        labels: {
                            color: textColor,
                            boxWidth: 10,
                            font: { size: 10 }
                        }
                    },
                    tooltip: {
                        callbacks: {
                            label: (context) => {
                                const label = context.label || '';
                                const value = context.parsed || 0;
                                const total = (context.dataset.data).reduce((a, b) => a + b, 0);
                                const percentage = ((value / total) * 100).toFixed(1);
                                return `${label}: ${value.toFixed(2)} ${this.displayCurrency} (${percentage}%)`;
                            }
                        }
                    }
                }
            }
        });
    }

    private renderContributionChart(canvas: HTMLCanvasElement, stats: MonthlyStats) {
        // Since stats is aggregated, we can iterate transactions to sum by userId
        const userTotals: Record<string, number> = {};

        stats.transactions.forEach(t => {
            const uid = t.userId || 'default';
            // Try to map ID to name
            const user = this.plugin.settings.users.find(u => u.id === uid);
            const name = user ? user.name : 'Unknown';
            userTotals[name] = (userTotals[name] || 0) + t.baseAmount;
        });

        const labels = Object.keys(userTotals);
        const data = Object.values(userTotals);

        // Use user colors if available
        const colors = labels.map(name => {
            const user = this.plugin.settings.users.find(u => u.name === name);
            if (user) return user.color;
            return this.getObsidianColor('--aa-series-8');
        });

        const textColor = this.getObsidianColor('--ap-label-2');

        new Chart(canvas, {
            type: 'pie',
            data: {
                labels: labels,
                datasets: [{
                    data: data,
                    backgroundColor: colors,
                    borderColor: this.getObsidianColor('--ap-page'),
                    borderWidth: 2
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: 'bottom',
                        labels: {
                            color: textColor,
                            boxWidth: 10,
                            font: { size: 10 }
                        }
                    },
                    tooltip: {
                        callbacks: {
                            label: (context) => {
                                const label = context.label || '';
                                const value = context.parsed || 0;
                                const total = (context.dataset.data).reduce((a, b) => a + b, 0);
                                const percentage = ((value / total) * 100).toFixed(1);
                                return `${label}: ${this.formatAmount(value)} ${this.plugin.settings.baseCurrency} (${percentage}%)`;
                            }
                        }
                    }
                }
            }
        });
    }

    private async renderTrendChart(canvas: HTMLCanvasElement, allStats: MonthlyStats[]) {
        // Filter allStats by user if selected
        let statsToRender = allStats;
        if (this.selectedUserId !== 'all') {
            statsToRender = allStats.filter(s => s.userId === this.selectedUserId || (!s.userId && this.selectedUserId === 'default'));
        }

        // We need to group by month and sum totals (in case of multiple users even after filter? No, if filtered, it's specific)
        // BUT if scope is 'all', we have multiple files per month. We must aggregate them.
        const monthlyTotals: Record<string, number> = {};

        const base = this.plugin.settings.baseCurrency;
        const target = this.displayCurrency;

        for (const s of statsToRender) {
            let val = 0;
            if (base === target) {
                val = s.total;
            } else {
                for (const record of s.transactions) {
                    val += await this.plugin.fxService.convert(record.baseAmount, base, target, record.date);
                }
            }
            monthlyTotals[s.month] = (monthlyTotals[s.month] || 0) + val;
        }

        const labels = Object.keys(monthlyTotals).sort();
        const data = labels.map(label => monthlyTotals[label]);

        const textColor = this.getObsidianColor('--ap-label-2');
        const gridColor = this.getObsidianColor('--ap-sep');
        const accentColor = this.getObsidianColor('--ap-accent');
        const restColor = this.getObsidianColor('--aa-series-8');
        const current = `${this.currentDate.getFullYear()}-${String(this.currentDate.getMonth() + 1).padStart(2, '0')}`;

        new Chart(canvas, {
            type: 'bar',
            data: {
                labels: labels,
                datasets: [{
                    label: `支出金额 (${this.displayCurrency})`,
                    data: data,
                    // Only the month being viewed is highlighted.
                    backgroundColor: labels.map(label => label === current ? accentColor : this.withAlpha(restColor, 0.55)),
                    borderColor: labels.map(label => label === current ? accentColor : restColor),
                    borderWidth: 1,
                    borderRadius: 3
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    y: {
                        beginAtZero: true,
                        grid: { color: gridColor },
                        ticks: { color: textColor }
                    },
                    x: {
                        grid: { display: false },
                        ticks: { color: textColor }
                    }
                },
                plugins: {
                    legend: { display: false }
                }
            }
        });
    }

    private clearAllFilters() {
        this.searchQuery = '';
        this.selectedCats.clear();
        this.selectedPMs.clear();
    }

    private getFilteredTransactions(stats: MonthlyStats): MonthlyStats {
        const tx = stats.transactions.filter(t => {
            const query = this.searchQuery.toLowerCase();
            const matched = this.searchQuery ? (
                t.description.toLowerCase().includes(query) ||
                t.category.toLowerCase().includes(query) ||
                t.amount.toString().includes(query)
            ) : true;
            if (!matched) return false;

            if (this.selectedCats.size > 0) {
                const primary = (t.category.split(/[/>:：]/)[0] || '其他支出').trim();
                if (!this.selectedCats.has(primary)) return false;
            }
            if (this.selectedPMs.size > 0) {
                const pm = t.paymentMethod || '未分类';
                if (!this.selectedPMs.has(pm)) return false;
            }
            return true;
        });

        const filtered: MonthlyStats = {
            month: stats.month,
            total: tx.reduce((s, t) => s + t.baseAmount, 0),
            categories: {},
            secondaryCategories: {},
            dailyStats: {},
            paymentMethods: {},
            transactions: tx
        };

        for (const t of tx) {
            const parts = t.category.split(/[/>:：]/);
            const primary = (parts[0] || '其他支出').trim() || '其他支出';
            const secondary = (parts[1] || '一般').trim() || '一般';

            filtered.categories[primary] = (filtered.categories[primary] || 0) + t.baseAmount;

            if (!filtered.secondaryCategories[primary]) filtered.secondaryCategories[primary] = {};
            filtered.secondaryCategories[primary][secondary] = (filtered.secondaryCategories[primary][secondary] || 0) + t.baseAmount;

            filtered.dailyStats[t.date] = (filtered.dailyStats[t.date] || 0) + t.baseAmount;

            const pm = t.paymentMethod || '未分类';
            filtered.paymentMethods[pm] = (filtered.paymentMethods[pm] || 0) + t.baseAmount;
        }

        return filtered;
    }

    private makeCellEditable(cell: HTMLElement, tx: TransactionRecord, field: keyof TransactionRecord) {
        if (cell.querySelector('input') || cell.querySelector('select')) return;

        const originalValue = cell.textContent || '';
        cell.empty();

        const input = cell.createEl('input', {
            cls: 'inline-edit-input',
            attr: { value: field === 'amount' ? tx.amount.toString() : originalValue }
        });
        input.focus();

        const saveChanges = async () => {
            const newValue = input.value;
            const updatedTx = { ...tx };

            if (field === 'amount') {
                updatedTx.amount = parseFloat(newValue) || tx.amount;
                updatedTx.baseAmount = updatedTx.amount * (tx.rate || 1);
            } else if (field === 'description') {
                updatedTx.description = newValue || tx.description;
            } else if (field === 'category') {
                updatedTx.category = newValue || tx.category;
            } else if (field === 'paymentMethod') {
                updatedTx.paymentMethod = newValue || tx.paymentMethod;
            }

            if (JSON.stringify(tx) !== JSON.stringify(updatedTx)) {
                await this.plugin.dataService.updateTransaction(tx, updatedTx);
                await this.refresh();
            } else {
                cell.empty();
                cell.textContent = originalValue;
            }
        };

        input.onkeydown = (e) => {
            if (e.key === 'Enter') {
                void saveChanges();
            } else if (e.key === 'Escape') {
                cell.empty();
                cell.textContent = originalValue;
            }
        };

        input.onblur = () => {
            void saveChanges();
        };
    }
}


