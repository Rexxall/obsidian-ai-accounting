import { ItemView, WorkspaceLeaf, Notice, setIcon } from 'obsidian';
import { Chart, registerables } from 'chart.js';
import { DataService, MonthlyStats, TransactionRecord } from './services/DataService';
import AccountingPlugin from './main';
import { RenameCategoryModal } from './modals/RenameCategoryModal';
import { EditTransactionModal } from './modals/EditTransactionModal';

Chart.register(...registerables);

export const VIEW_TYPE_DASHBOARD = 'ai-accounting-dashboard';

enum PanelTab {
    Transactions = '明细',
    Charts = '图表'
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
            const isInputFocused = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || (target as any).isContentEditable);
            if (!isInputFocused) {
                if (e.key === '/') {
                    const el = this.containerEl.querySelector('#aa-search') as HTMLInputElement;
                    if (el) { el.focus(); e.preventDefault(); }
                } else if (e.key.toLowerCase() === 'n') {
                    const el = this.containerEl.querySelector('#aa-quick-date') as HTMLInputElement;
                    if (el) { el.focus(); e.preventDefault(); }
                } else if (e.key.toLowerCase() === 'f') {
                    const el = this.containerEl.querySelector('#aa-filters') as HTMLElement;
                    if (el) { el.scrollIntoView({ behavior: 'smooth' }); }
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
        const headerContainer = container.createEl('div', { cls: 'dashboard-header-container' });
        const topBar = headerContainer.createEl('div', { cls: 'dashboard-top-bar' });

        // Left: Title + Tabs
        const leftGroup = topBar.createEl('div', { cls: 'top-bar-left' });
        leftGroup.createEl('h1', { text: '我的账本' });
        leftGroup.createEl('p', { text: '支出记录与分类汇总', cls: 'ledger-subtitle' });
        const heroActions = topBar.createDiv('ledger-hero-actions');
        const settingsEntry = heroActions.createEl('button', { text: '插件设置', cls: 'plugin-settings-entry' });
        settingsEntry.addEventListener('click', () => {
            const settings = (this.app as typeof this.app & { setting?: { open(): void; openTabById(id: string): void } }).setting;
            settings?.open();
            settings?.openTabById(this.plugin.manifest.id);
        });

        const navigation = headerContainer.createDiv('ledger-navigation');

        const tabsContainer = navigation.createEl('div', { cls: 'tabs-bar compact' });
        [PanelTab.Transactions, PanelTab.Charts].forEach(key => {
            const btn = tabsContainer.createEl('button', { text: key, cls: 'tab-btn-compact' });
            btn.classList.toggle('is-active', this.currentTab === key);
            btn.onclick = () => { this.currentTab = key; void this.render(); };
        });

        // Right: Scope + Date Nav + Quick Add + Actions
        const rightGroup = headerContainer.createEl('div', { cls: 'top-bar-right' });
        // Scope Buttons
        const scopeGroup = navigation.createEl('div', { cls: 'scope-group-compact' });
        const scopes: Array<{ key: ChartScope, label: string }> = [
            { key: 'day', label: '当日' },
            { key: 'month', label: '月度' },
            { key: 'year', label: '年度' },
        ];
        scopes.forEach(s => {
            const btn = scopeGroup.createEl('button', { text: s.label, cls: 'scope-btn-compact' });
            btn.classList.toggle('is-active', this.chartScope === s.key);
            btn.onclick = () => {
                this.chartScope = s.key;
                this.selectedPrimaryCategory = null;
                this.selectedDailyCategory = null;
                void this.render();
            };
        });

        // Date Nav
        const navSection = rightGroup.createEl('div', { cls: 'nav-section-compact' });
        const prevBtn = navSection.createEl('button', { text: '◀', cls: 'nav-btn-icon' });
        prevBtn.onclick = async () => { this.adjustDate(-1); await this.render(); };

        const datePickerContainer = navSection.createEl('div', { cls: 'nav-picker-container' });
        if (this.chartScope === 'day') {
            const dateInput = datePickerContainer.createEl('input', { type: 'date', cls: 'nav-date-input' });
            dateInput.value = ctx.yyyy_mm_dd;
            dateInput.onchange = () => { if (dateInput.value) { this.currentDate = new Date(dateInput.value); void this.render(); } };
        } else if (this.chartScope === 'month') {
            const monthInput = datePickerContainer.createEl('input', { type: 'month', cls: 'nav-date-input' });
            monthInput.value = ctx.yyyy_mm;
            monthInput.onchange = () => {
                if (monthInput.value) {
                    const parts = monthInput.value.split('-');
                    if (parts.length >= 2) this.currentDate = new Date(parseInt(parts[0] || '1970'), parseInt(parts[1] || '1') - 1, 1);
                    void this.render();
                }
            };
        } else {
            const yearInput = datePickerContainer.createEl('input', { type: 'number', cls: 'nav-date-input year-input' });
            yearInput.value = ctx.yyyy;
            yearInput.onchange = () => { if (yearInput.value) { this.currentDate.setFullYear(parseInt(yearInput.value)); void this.render(); } };
        }

        const nextBtn = navSection.createEl('button', { text: '▶', cls: 'nav-btn-icon' });
        nextBtn.onclick = async () => { this.adjustDate(1); await this.render(); };

        // Currency
        const currencySelect = rightGroup.createEl('select', { cls: 'dropdown compact-dropdown' });
        ['CNY', 'JPY', 'USD', 'EUR', 'HKD', 'GBP'].forEach(cur => {
            const opt = currencySelect.createEl('option', { text: cur, value: cur });
            if (cur === this.displayCurrency) opt.selected = true;
        });
        currencySelect.onchange = async () => { this.displayCurrency = currencySelect.value; await this.render(); };

        // User Filter
        if (this.plugin.settings.users.length > 0) {
            const userSelect = rightGroup.createEl('select', { cls: 'dropdown compact-dropdown' });
            const allOpt = userSelect.createEl('option', { text: '全部成员', value: 'all' });
            if (this.selectedUserId === 'all') allOpt.selected = true;
            this.plugin.settings.users.forEach(u => {
                const opt = userSelect.createEl('option', { text: u.name, value: u.id });
                if (this.selectedUserId === u.id) opt.selected = true;
            });
            userSelect.onchange = async () => {
                this.selectedUserId = userSelect.value;
                this.selectedPrimaryCategory = null;
                await this.render();
            };
        }

        // Actions
        const refreshBtn = heroActions.createEl('button', { cls: 'icon-btn', attr: { 'aria-label': '刷新' } });
        setIcon(refreshBtn, 'refresh-cw');
        refreshBtn.onclick = () => this.refresh();

        const exportBtn = heroActions.createEl('button', { cls: 'icon-btn', attr: { 'aria-label': '导出' } });
        setIcon(exportBtn, 'download');
        exportBtn.onclick = () => { if (ctx.rawStats) this.exportData(ctx.rawStats); };

        const quickAddBtn = heroActions.createEl('button', { cls: 'quick-add-plus-btn mod-cta', attr: { 'aria-label': '快速录入' } });
        quickAddBtn.createSpan({ text: '+', cls: 'ledger-add-icon' });
        quickAddBtn.createSpan({ text: '记一笔' });
        quickAddBtn.onclick = () => {
            const qf = container.querySelector('.quick-form-wrapper');
            if (qf) qf.classList.toggle('is-hidden');
        };

        // Controls Bar (Filters)
        if (this.currentTab === PanelTab.Transactions) {
            const controlsBar = headerContainer.createEl('div', { cls: 'dashboard-controls-bar' });
            const filtersContainer = controlsBar.createEl('div', { cls: 'filters-container' });

            const searchInput = filtersContainer.createEl('input', { type: 'text', attr: { id: 'aa-search', placeholder: '搜索商户或备注…' } }) as HTMLInputElement;
            searchInput.classList.add('compact-input');
            searchInput.value = this.searchQuery;
            searchInput.oninput = () => {
                this.searchQuery = searchInput.value || '';
                void this.refreshGridOnly(); // Only refresh grid!
            };
            searchInput.onkeydown = (e) => { if (e.key === 'Enter') void this.refreshGridOnly(); };

            if (ctx.rawStats) {
                const categories = new Set<string>();
                const methods = new Set<string>();
                ctx.rawStats.transactions.forEach((t: TransactionRecord) => {
                    const cat = (t.category.split(/[/>:：]/)[0] || '其他').trim();
                    if (cat) categories.add(cat);
                    const pm = t.paymentMethod || '未分类';
                    if (pm) methods.add(pm);
                });

                const catGroup = filtersContainer.createEl('div', { cls: 'dropdown-group compact' });
                catGroup.createEl('label', { text: '分类：', cls: 'compact-label' });
                const catSelect = catGroup.createEl('select', { cls: 'filter-dropdown compact' });
                catSelect.createEl('option', { text: '全部', value: '' });
                Array.from(categories).sort().forEach(cat => {
                    const opt = catSelect.createEl('option', { text: cat, value: cat });
                    if (this.selectedCats.has(cat)) opt.selected = true;
                });
                catSelect.onchange = () => {
                    this.selectedCats.clear();
                    if (catSelect.value) this.selectedCats.add(catSelect.value);
                    void this.refreshGridOnly();
                };

                const pmGroup = filtersContainer.createEl('div', { cls: 'dropdown-group compact' });
                pmGroup.createEl('label', { text: '支付：', cls: 'compact-label' });
                const pmSelect = pmGroup.createEl('select', { cls: 'filter-dropdown compact' });
                pmSelect.createEl('option', { text: '全部', value: '' });
                Array.from(methods).sort().forEach(pm => {
                    const opt = pmSelect.createEl('option', { text: pm, value: pm });
                    if (this.selectedPMs.has(pm)) opt.selected = true;
                });
                pmSelect.onchange = () => {
                    this.selectedPMs.clear();
                    if (pmSelect.value) this.selectedPMs.add(pmSelect.value);
                    void this.refreshGridOnly();
                };
            }
        }

        // Quick Form Rendering
        this.renderQuickForm(container);
    }

    private renderQuickForm(container: HTMLElement) {
        // Quick Form Wrapper (same as before)
        const quickFormWrapper = container.createEl('div', { cls: 'quick-form-wrapper is-hidden' });
        const qForm = quickFormWrapper.createEl('div', { cls: 'quick-form-inline' });
        const dateInput = qForm.createEl('input', { type: 'date', attr: { id: 'aa-quick-date', 'aria-label': '交易日期' } }) as HTMLInputElement;
        const today = new Date();
        dateInput.value = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
        const amountInput = qForm.createEl('input', { type: 'number', attr: { placeholder: '金额', step: '0.01' } }) as HTMLInputElement;
        const currInput = qForm.createEl('select');
        ['CNY', 'JPY', 'USD', 'EUR', 'HKD', 'GBP'].forEach(c => { const o = currInput.createEl('option', { text: c, value: c }); if (c === this.plugin.settings.defaultInputCurrency) o.selected = true; });
        const catInput = qForm.createEl('input', { type: 'text', attr: { placeholder: '分类' } }) as HTMLInputElement;
        const pmInput = qForm.createEl('input', { type: 'text', attr: { placeholder: '支付方式' } }) as HTMLInputElement;
        const descInput = qForm.createEl('input', { type: 'text', attr: { placeholder: '描述' } }) as HTMLInputElement;
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

    private async renderGrid(dashboardGrid: HTMLElement, ctx: any) {
        const { rawStats, navRawStats, navLabel } = ctx;
        if (this.allStats.length === 0 || !rawStats) {
            const empty = dashboardGrid.createDiv({ cls: 'aa-empty-state' });
            empty.createEl('h2', { text: this.allStats.length === 0 ? '从第一笔记录开始' : '这个时间范围还没有记录' });
            empty.createEl('p', { text: '可以直接录入一笔支出，或用上方日期选择器查看其他月份。已有账单也可以通过 AI 收件箱提取，核对后入账。' });
            const add = empty.createEl('button', { text: '录入一笔支出', cls: 'mod-cta' });
            add.onclick = () => {
                const form = this.contentEl.querySelector('.quick-form-wrapper');
                form?.classList.remove('is-hidden');
                (form?.querySelector('input[type="number"]') as HTMLInputElement | null)?.focus();
            };
            return;
        }

        // Apply filters
        let statsForDisplay = rawStats ? this.getFilteredTransactions(rawStats) : this.buildStatsFromTransactions([], navLabel);
        const displayStats = await this.getConvertedStats(statsForDisplay);

        let navDisplayStats = displayStats;
        if (navRawStats) {
            const filteredNav = this.getFilteredTransactions(navRawStats);
            navDisplayStats = await this.getConvertedStats(filteredNav);
        }

        let summaryTitle = navLabel + ' 汇总';

        // Calculate Today/Week Stats (Global context)
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

        // --- Summary Board ---
        const summaryBoard = dashboardGrid.createEl('div', { cls: 'summary-board' });

        // 1. Metrics Panel
        const metricsPanel = summaryBoard.createEl('div', { cls: 'summary-panel metrics-panel' });
        metricsPanel.createEl('h3', { text: summaryTitle, cls: 'panel-title' });
        const metricsGrid = metricsPanel.createEl('div', { cls: 'metrics-grid' });

        const totalCard = this.createMetricCard(metricsGrid, '期间支出', this.formatAmount(displayStats.total), this.displayCurrency, 'total-card');
        totalCard.labelEl.id = 'aa-dynamic-total-label';
        totalCard.valEl.id = 'aa-dynamic-total-val';
        
        const countCard = this.createMetricCard(metricsGrid, '交易笔数', displayStats.transactions.length.toString(), '笔');
        countCard.labelEl.id = 'aa-dynamic-count-label';
        countCard.valEl.id = 'aa-dynamic-count-val';

        this.createMetricCard(metricsGrid, '今日支出', this.formatAmount(todayTotal), this.displayCurrency);
        this.createMetricCard(metricsGrid, '本周支出', this.formatAmount(weekTotal), this.displayCurrency);

        // 2. Insights Panel (Top Expenses)
        const insightsPanel = summaryBoard.createEl('div', { cls: 'summary-panel insights-panel' });
        insightsPanel.createEl('h3', { text: '主要支出', cls: 'panel-title' });

        const insightsGrid = insightsPanel.createEl('div', { cls: 'insights-grid-compact' });
        // Top 2 as requested
        const topCats = Object.entries(displayStats.categories).sort((a, b) => b[1] - a[1]).slice(0, 2);

        if (topCats.length > 0) {
            topCats.forEach(([cat, val], idx) => {
                const card = insightsGrid.createEl('div', { cls: 'insight-card-compact' });
                card.createEl('div', { text: cat, cls: 'insight-card-title' });
                card.createEl('div', { text: this.formatAmount(val), cls: 'insight-card-value' });
            });
        } else {
            insightsGrid.createEl('p', { text: '暂无数据', cls: 'no-data-text' });
        }

        if (this.currentTab === PanelTab.Transactions) {
            void this.renderTransactionDetailView(dashboardGrid, displayStats, navDisplayStats);
        } else if (this.currentTab === PanelTab.Charts) {
            const chartCard = dashboardGrid.createEl('div', { cls: 'dashboard-card chart-card' });
            const title = this.selectedPrimaryCategory ? `📝 ${this.selectedPrimaryCategory} 明细` : '🍕 支出分类占比';
            chartCard.createEl('h2', { text: title });

            if (this.selectedPrimaryCategory) {
                const backBtn = chartCard.createEl('button', { text: '🔙 返回主分类', cls: 'back-btn' });
                backBtn.onclick = () => { this.selectedPrimaryCategory = null; void this.render(); };
            }
            const canvasWrapper = chartCard.createEl('div', { cls: 'chart-container' });
            const canvas = canvasWrapper.createEl('canvas');
            this.renderCategoryChart(canvas, displayStats);

            const trendCard = dashboardGrid.createEl('div', { cls: 'dashboard-card trend-card' });
            trendCard.createEl('h2', { text: '📉 历史月度趋势' });
            const trendWrapper = trendCard.createEl('div', { cls: 'chart-container' });
            const trendCanvas = trendWrapper.createEl('canvas');
            void this.renderTrendChart(trendCanvas, this.allStats);

            const paymentCard = dashboardGrid.createEl('div', { cls: 'dashboard-card payment-card' });
            paymentCard.createEl('h2', { text: '💳 支付方式分布' });
            const paymentWrapper = paymentCard.createEl('div', { cls: 'chart-container' });
            const paymentCanvas = paymentWrapper.createEl('canvas');
            this.renderPaymentMethodChart(paymentCanvas, displayStats);

            // Contribution Chart (Multi-user)
            if (this.selectedUserId === 'all' && this.plugin.settings.users.length > 1) {
                const contribCard = dashboardGrid.createEl('div', { cls: 'dashboard-card contrib-card' });
                contribCard.createEl('h2', { text: '👥 成员贡献对比' });
                const contribWrapper = contribCard.createEl('div', { cls: 'chart-container' });
                const contribCanvas = contribWrapper.createEl('canvas');
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
        const card = parent.createEl('div', { cls: `metric-card ${cls}` });
        const labelEl = card.createEl('span', { text: label, cls: 'metric-label' });
        const valContainer = card.createEl('div', { cls: 'metric-value-container' });
        const valEl = valContainer.createEl('span', { text: value, cls: 'metric-value' });
        if (suffix) valContainer.createEl('span', { text: suffix, cls: 'metric-suffix' });
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
        } as MonthlyStats;
    }

    private async renderTransactionDetailView(parent: HTMLElement, stats: MonthlyStats, navStats: MonthlyStats) {
        const grid = parent.createEl('div', { cls: 'daily-view-grid' });

        // 1. Table Side (Transaction Details - Now on the left)
        const detailsCard = grid.createEl('div', { cls: 'dashboard-card transaction-details-card' });

        detailsCard.createEl('h2', { text: '交易明细', cls: 'ledger-section-title' });
        const analysis = grid.createEl('details', { cls: 'ledger-analysis' });
        analysis.createEl('summary', { text: '周期明细与分类分析' });
        const rightPanel = analysis.createDiv('daily-right-panel');

        // --- SCOPE-AWARE NAVIGATION (Right Panel) ---
        const navCard = rightPanel.createEl('div', { cls: 'dashboard-card daily-card' });
        const navTitle = this.chartScope === 'day' ? '每日开支' :
            this.chartScope === 'month' ? '月度开支' : '年度开支';
        navCard.createEl('h2', { text: navTitle });

        const navTable = navCard.createEl('table', { cls: 'daily-table' });
        const navThead = navTable.createEl('thead');
        const navHeaderRow = navThead.createEl('tr');

        const createNavSortHeader = (text: string, col: 'period' | 'amount') => {
            const th = navHeaderRow.createEl('th', { text });
            th.style.cursor = 'pointer';
            th.style.userSelect = 'none';
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
            const row = navTbody.createEl('tr', { cls: key === activeKey ? 'is-selected' : '' });
            row.style.cursor = 'pointer';
            row.createEl('td', { text: key });
            row.createEl('td', { text: `${this.formatAmount(amount)} ${this.displayCurrency}` });

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
        const chartCard = rightPanel.createEl('div', { cls: 'dashboard-card daily-chart-card' });
        const displayDate = activeKey;

        if (this.selectedSecondaryCategory && this.selectedDailyCategory) {
            chartCard.createEl('h2', { text: `📊 ${displayDate} - ${this.selectedDailyCategory} > ${this.selectedSecondaryCategory}` });
            const backBtn = chartCard.createEl('button', { text: '🔙 返回 ' + this.selectedDailyCategory, cls: 'back-btn' });
            backBtn.onclick = () => {
                this.selectedSecondaryCategory = null;
                void this.render();
            };
        } else if (this.selectedDailyCategory) {
            chartCard.createEl('h2', { text: `📊 ${displayDate} - ${this.selectedDailyCategory}` });
            const backBtn = chartCard.createEl('button', { text: '🔙 返回全部分类', cls: 'back-btn' });
            backBtn.onclick = () => {
                this.selectedDailyCategory = null;
                this.selectedSecondaryCategory = null;
                void this.render();
            };
        } else {
            chartCard.createEl('h2', { text: displayDate ? `📊 ${displayDate} 分类统计` : '📊 每日明细' });
        }

        if (displayDate) {
            const canvasWrapper = chartCard.createEl('div', { cls: 'chart-container daily-chart-container' });
            const canvas = canvasWrapper.createEl('canvas');
            this.renderDailyCategoryChart(canvas, navStats, displayDate);


            let filteredTransactions: any[] = [];
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
                const batchBar = detailsCard.createEl('div', { cls: 'batch-actions-bar', attr: { style: 'margin-bottom: 10px; display: none; align-items: center; gap: 10px; padding: 8px; background: var(--background-secondary); border-radius: 4px;' } });
                const batchCount = batchBar.createEl('span', { text: '已选择 0 项' });
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
                        batchBar.style.display = 'flex';
                    } else {
                        batchBar.style.display = 'none';
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

                    const panel = detailsCard.createEl('div', { cls: 'batch-aa-panel info-panel', attr: { style: 'margin-top: 10px; padding: 10px; border: 1px dashed var(--text-accent);' } });
                    const detailTable = detailsCard.querySelector('.daily-table');
                    if (detailTable) detailsCard.insertBefore(panel, detailTable);

                    panel.createEl('h4', { text: `批量分账 (${selectedSet.size} 笔)`, attr: { style: 'margin: 0 0 10px 0;' } });

                    const userChecks: Record<string, HTMLInputElement> = {};
                    const usersContainer = panel.createEl('div', { attr: { style: 'display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 10px;' } });

                    this.plugin.settings.users.forEach(u => {
                        const label = usersContainer.createEl('label', { attr: { style: 'display: flex; align-items: center; gap: 4px;' } });
                        const chk = label.createEl('input', { type: 'checkbox' });
                        chk.checked = true;
                        label.createEl('span', { text: u.name });
                        userChecks[u.id] = chk;
                    });

                    const actionContainer = panel.createEl('div', { attr: { style: 'display: flex; justify-content: flex-end; gap: 8px;' } });
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

                const detailTable = detailsCard.createEl('table', { cls: 'daily-table' });
                const detailThead = detailTable.createEl('thead');
                const detailHeaderRow = detailThead.createEl('tr');

                // Header Checkbox
                const checkTh = detailHeaderRow.createEl('th', { cls: 'checkbox-col hide-mobile', attr: { style: 'width: 30px;', 'data-hide': 'mobile' } });
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
                    if (width) th.style.width = width;
                    if (col !== 'action') {
                        th.style.cursor = 'pointer';
                        th.style.userSelect = 'none';
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
                createSortHeader('金额', 'amount');
                createSortHeader('支付方式', 'paymentMethod', undefined, 'hide-mobile').setAttribute('data-hide', 'mobile');
                detailHeaderRow.createEl('th', { text: '操作', cls: 'hide-mobile', attr: { 'data-hide': 'mobile' } });

                const detailTbody = detailTable.createEl('tbody');
                for (const tx of filteredTransactions) {
                    const row = detailTbody.createEl('tr');

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
                    if (this.plugin.settings.users.length > 0) {
                        const userId = tx.userId || 'default';
                        // Only show badge if multiple users exist or it's not the default view
                        // Easier: always show if configured users > 0
                        const user = this.plugin.settings.users.find(u => u.id === userId);
                        if (user) {
                            descTd.createEl('span', {
                                text: user.name.charAt(0).toUpperCase(),
                                cls: 'user-badge',
                                attr: {
                                    style: `background-color: ${user.color || '#888'}; color: #fff; padding: 2px 5px; border-radius: 4px; font-size: 0.8em; margin-right: 5px; vertical-align: middle;`,
                                    title: user.name
                                }
                            });
                        }
                    }
                    descTd.createEl('span', { text: tx.description });

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

                    const amountTd = row.createEl('td', { text: `${this.formatAmount(displayAmt)} ${displayCur}` });
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
                    const aaBtn = actionsCell.createEl('button', { cls: 'icon-btn', attr: { 'aria-label': 'AA 分账' } });
                    setIcon(aaBtn, 'users');
                    if (tx.description.includes('(AA)')) {
                        aaBtn.disabled = true;
                        aaBtn.style.opacity = '0.5';
                    }

                    aaBtn.onclick = () => {
                        const existing = actionsCell.querySelector('.inline-aa-panel');
                        if (existing) { existing.remove(); return; }

                        const ownerId = tx.userId || 'default';
                        const panel = actionsCell.createEl('div', { cls: 'inline-aa-panel info-panel', attr: { style: 'position: absolute; right: 60px; z-index: 100; min-width: 320px; background: var(--background-secondary); border: 1px solid var(--background-modifier-border); padding: 12px; border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,0.3);' } });
                        panel.createEl('h4', { text: `发起分账 (总金额: ${tx.amount})`, attr: { style: 'margin: 0 0 10px 0;' } });

                        const userChecks: Record<string, HTMLInputElement> = {};
                        const userInputs: Record<string, HTMLInputElement> = {};

                        const usersContainer = panel.createEl('div', { attr: { style: 'display: flex; flex-direction: column; gap: 8px; margin-bottom: 15px;' } });
                        
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
                            const row = usersContainer.createEl('div', { attr: { style: 'display: flex; align-items: center; justify-content: space-between; gap: 10px;' } });
                            
                            const label = row.createEl('label', { attr: { style: 'display: flex; align-items: center; gap: 4px; cursor: pointer; flex: 1;' } });
                            const chk = label.createEl('input', { type: 'checkbox' });
                            chk.checked = true; // default all checked
                            label.createEl('span', { text: u.name + (isOwner ? ' (付款方)' : '') });
                            userChecks[u.id] = chk;

                            const input = row.createEl('input', { type: 'number', attr: { style: 'width: 80px;', step: '0.01', min: '0' } });
                            userInputs[u.id] = input;

                            if (isOwner) {
                                input.readOnly = true;
                                input.style.opacity = '0.7';
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

                        const actionContainer = panel.createEl('div', { attr: { style: 'display: flex; justify-content: flex-end; gap: 8px;' } });
                        
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
                    const editBtn = actionsCell.createEl('button', { cls: 'icon-btn', attr: { 'aria-label': '编辑' } });
                    setIcon(editBtn, 'pencil');
                    editBtn.onclick = () => {
                        new EditTransactionModal(this.app, tx, this.plugin, () => {
                            void this.refresh();
                        }).open();
                    };

                    // Open note link
                    const openBtn = actionsCell.createEl('button', { cls: 'icon-btn', attr: { 'aria-label': '在新标签页打开源文件' } });
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

                // --- Inline Quick Add Row ---
                const addRow = detailTbody.createEl('tr', { cls: 'quick-add-row' });
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
                const saveBtn = actionsCell.createEl('button', { cls: 'icon-btn', attr: { 'aria-label': '快速添加' } });
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
                        exchangeRate: rate,
                        paymentMethod: payment
                    }]);

                    new Notice('✅ 账目已添加');
                    await this.refresh();
                };

                saveBtn.onclick = handleAdd;
                [descInput, catInput, amountInput, payInput].forEach(input => {
                    input.onkeydown = (e) => { if (e.key === 'Enter') void handleAdd(); };
                });
            } else {
                detailsCard.createEl('p', { text: '暂无交易记录' });
            }
        } else {
            chartCard.createEl('p', { text: '点击左侧记录查看详情' });
        }
    }

    private renderDailyCategoryChart(canvas: HTMLCanvasElement, stats: MonthlyStats, date: string) {
        const base = this.plugin.settings.baseCurrency;
        const target = this.displayCurrency;

        // Scope-aware filtering
        let scopedTransactions: any[] = [];
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
            const textColor = this.getObsidianColor('--text-normal');
            new Chart(canvas, {
                type: 'pie',
                data: { labels, datasets: [{ data: values, backgroundColor: ['#ff6384', '#36a2eb', '#ffce56', '#4bc0c0', '#9966ff', '#ff9f40'], borderColor: this.getObsidianColor('--background-secondary'), borderWidth: 2 }] },
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

    private getObsidianColor(variable: string): string {
        return getComputedStyle(document.body || document.documentElement).getPropertyValue(variable).trim();
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

        const textColor = this.getObsidianColor('--text-normal');

        new Chart(canvas, {
            type: 'doughnut',
            data: {
                labels: labels,
                datasets: [{
                    data: data,
                    backgroundColor: [
                        '#ff6384', '#36a2eb', '#ffce56', '#4bc0c0', '#9966ff', '#ff9f40', '#c9cbcf', '#00aba9'
                    ],
                    borderColor: this.getObsidianColor('--background-secondary'),
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

        const textColor = this.getObsidianColor('--text-normal');

        new Chart(canvas, {
            type: 'pie',
            data: {
                labels: labels,
                datasets: [{
                    data: data,
                    backgroundColor: [
                        '#4bc0c0', '#ff6384', '#36a2eb', '#ffce56', '#9966ff', '#ff9f40', '#c9cbcf', '#00aba9'
                    ],
                    borderColor: this.getObsidianColor('--background-secondary'),
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
                                const total = (context.dataset.data as number[]).reduce((a, b) => a + b, 0);
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
            // Fallback colors
            return '#cccccc';
        });

        const textColor = this.getObsidianColor('--text-normal');

        new Chart(canvas, {
            type: 'pie',
            data: {
                labels: labels,
                datasets: [{
                    data: data,
                    backgroundColor: colors,
                    borderColor: this.getObsidianColor('--background-secondary'),
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
                                const total = (context.dataset.data as number[]).reduce((a, b) => a + b, 0);
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

        const textColor = this.getObsidianColor('--text-normal');
        const gridColor = this.getObsidianColor('--background-modifier-border');
        const accentColor = this.getObsidianColor('--text-accent');

        new Chart(canvas, {
            type: 'bar',
            data: {
                labels: labels,
                datasets: [{
                    label: `支出金额 (${this.displayCurrency})`,
                    data: data,
                    backgroundColor: accentColor + '99',
                    borderColor: accentColor,
                    borderWidth: 1
                }]
            },
            options: {
                responsive: true,
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
                    legend: { labels: { color: textColor } }
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


