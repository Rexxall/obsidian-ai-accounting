import { tableCells, recordId, renderTransaction, locateTransaction, validateTransaction, newRecordId, encodeCell } from "./ledger";
import { App, TFile, TFolder, Notice } from 'obsidian';
import { AccountingSettings } from '../settings';

export interface TransactionRecord {
    id?: string;
    sourceRow?: string;
    sourceLine?: number;
    sourcePath?: string;
    date: string;
    description: string;
    category: string;
    amount: number;
    currency: string;
    rate: number;
    baseAmount: number;
    paymentMethod?: string;
    userId?: string;
}

export interface MonthlyStats {
    month: string;
    total: number;
    categories: Record<string, number>;
    secondaryCategories: Record<string, Record<string, number>>;
    dailyStats: Record<string, number>;
    paymentMethods: Record<string, number>;
    transactions: TransactionRecord[];
    userId?: string;
}

export class DataService {
    private fileCache: Map<string, { mtime: number, data: MonthlyStats }> = new Map();

    constructor(private app: App, private settings: AccountingSettings) { }

    async getAllData(): Promise<MonthlyStats[]> {
        const stats: MonthlyStats[] = [];

        // Identify all folders to scan: default/legacy (financeFolderPath) AND defined users
        // Use a set to avoid duplicates if specific users map to the same folder
        const tasks: { folderPath: string, userId: string }[] = [];

        // 1. Scan configured users
        for (const user of this.settings.users) {
            tasks.push({ folderPath: user.folder, userId: user.id });
        }

        // 2. Scan legacy folder if not covered (optional, but good for safety)
        // If users array is empty, we must fallback to settings.financeFolderPath (handled by default user in DEFAULT_SETTINGS)

        for (const task of tasks) {
            const folder = this.app.vault.getAbstractFileByPath(task.folderPath);
            if (!(folder instanceof TFolder)) continue;

            const files = folder.children.filter(f => f instanceof TFile && f.extension === 'md' && /^\d{4}-\d{2}$/.test(f.basename)) as TFile[];
            files.sort((a, b) => b.basename.localeCompare(a.basename));

            for (const file of files) {
                const fileStats = await this.parseMonthlyFile(file, task.userId);
                stats.push(fileStats);
            }
        }

        return stats;
    }

    async getYearlyStats(year: string): Promise<MonthlyStats> {
        // NOTE: This aggregates EVERYTHING. Dashboard might want to filter first.
        const allStats = await this.getAllData();
        const yearStats = allStats.filter(s => s.month.startsWith(year));

        const yearly: MonthlyStats = {
            month: `${year} 全年`,
            total: 0,
            categories: {},
            secondaryCategories: {},
            dailyStats: {},
            paymentMethods: {},
            transactions: []
        };

        for (const m of yearStats) {
            yearly.total += m.total;
            yearly.transactions.push(...m.transactions);

            for (const [cat, val] of Object.entries(m.categories)) {
                yearly.categories[cat] = (yearly.categories[cat] || 0) + val;
            }

            for (const [cat, secondaries] of Object.entries(m.secondaryCategories)) {
                if (!yearly.secondaryCategories[cat]) yearly.secondaryCategories[cat] = {};
                for (const [sec, val] of Object.entries(secondaries)) {
                    yearly.secondaryCategories[cat][sec] = (yearly.secondaryCategories[cat][sec] || 0) + val;
                }
            }

            for (const [date, val] of Object.entries(m.dailyStats)) {
                yearly.dailyStats[date] = (yearly.dailyStats[date] || 0) + val;
            }

            for (const [method, val] of Object.entries(m.paymentMethods)) {
                yearly.paymentMethods[method] = (yearly.paymentMethods[method] || 0) + val;
            }
        }
        return yearly;
    }



    public async parseMonthlyFile(file: TFile, userId: string = 'default'): Promise<MonthlyStats> {
        // Check cache first
        const cache = this.fileCache.get(file.path);
        if (cache && cache.mtime === file.stat.mtime) {
            // NOTE: If userId changes for a file, cache might be stale regarding userId, but typically folders don't change owners.
            // We can strictly update the cached userId just in case.
            cache.data.userId = userId;
            cache.data.transactions.forEach(t => t.userId = userId);
            return cache.data;
        }

        const content = await this.app.vault.read(file);
        const month = file.basename;
        const transactions: TransactionRecord[] = [];
        const categories: Record<string, number> = {};
        const secondaryCategories: Record<string, Record<string, number>> = {};
        const dailyStats: Record<string, number> = {};
        const paymentMethods: Record<string, number> = {};
        let total = 0;

        // Row format: | Date | Description | Category | Original | Currency | Rate | Base | PaymentMethod |
        const rows = content.split('\n');
        const tableRows = rows.filter(row => row.trim().startsWith('|') && !row.includes('--|--') && !row.includes('| 日期 | 描述'));

        for (const [sourceLine, row] of rows.entries()) {
            if (!tableRows.includes(row)) continue;
            const cols = tableCells(row);
            if (cols.length >= 7) {
                const record: TransactionRecord = {
                    id: recordId(row),
                    sourceRow: row,
                    sourceLine,
                    sourcePath: file.path,
                    date: cols[0] || '',
                    description: cols[1] || '',
                    category: cols[2] || '',
                    amount: parseFloat((cols[3] || '0').replace(/,/g, '')),
                    currency: cols[4] || '',
                    rate: parseFloat(cols[5] || '1'),
                    baseAmount: parseFloat((cols[6] || '0').replace(/,/g, '')),
                    paymentMethod: cols[7] || '未分类',
                    userId: userId
                };

                if (/^\d{4}-\d{2}-\d{2}$/.test(record.date) && Number.isFinite(record.amount) && Number.isFinite(record.baseAmount)) {
                    transactions.push(record);
                    total += record.baseAmount;

                    // Group by Date
                    dailyStats[record.date] = (dailyStats[record.date] || 0) + record.baseAmount;

                    // Group by Primary and Secondary Category
                    const parts = record.category.split(/[/>:：]/);
                    const primary = (parts[0] || '其他支出').trim() || '其他支出';
                    const secondary = (parts[1] || '一般').trim() || '一般';

                    categories[primary] = (categories[primary] || 0) + record.baseAmount;

                    if (!secondaryCategories[primary]) secondaryCategories[primary] = {};
                    secondaryCategories[primary][secondary] = (secondaryCategories[primary][secondary] || 0) + record.baseAmount;

                    // Group by Payment Method
                    const method = record.paymentMethod || '未分类';
                    paymentMethods[method] = (paymentMethods[method] || 0) + record.baseAmount;
                }
            }
        }

        const stats: MonthlyStats = {
            month,
            total,
            categories,
            secondaryCategories,
            dailyStats,
            paymentMethods,
            transactions,
            userId
        };

        // Save to cache
        this.fileCache.set(file.path, { mtime: file.stat.mtime, data: stats });

        return stats;
    }

    public async updateMonthlyFileVisuals(file: TFile) {
        let content = await this.app.vault.read(file);
        const originalContent = content;
        this.fileCache.delete(file.path);
        const stats = await this.parseMonthlyFile(file);
        if (await this.app.vault.read(file) !== originalContent) throw new Error("账本已变化，请刷新后更新报表。");

        // Define Delimiters
        const startMarker = '%% BEGIN_AI_ANALYSIS %%';
        const endMarker = '%% END_AI_ANALYSIS %%';

        const analysisHeader = '## 📈 支出深度分析 (AI 自动生成)';
        const analysisBody = this.generateAnalysisSection(stats);
        const fullAnalysisBlock = `\n${startMarker}\n${analysisHeader}\n${analysisBody}\n${endMarker}\n`;

        // Check for existing block
        const startIndex = content.indexOf(startMarker);
        const endIndex = content.indexOf(endMarker);

        if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
            // Replace existing block
            content = content.slice(0, startIndex) + fullAnalysisBlock.trim() + content.slice(endIndex + endMarker.length);
        } else {
            // New block, insert before table or at end
            const tableStart = content.indexOf('\n| 日期 |');
            if (tableStart !== -1) {
                content = content.slice(0, tableStart) + '\n' + fullAnalysisBlock + content.slice(tableStart);
            } else {
                content += '\n' + fullAnalysisBlock;
            }
        }

        // Ensure table header exists
        const currency = this.settings.baseCurrency;
        const tableHeader = `| 日期 | 描述 | 分类 | 原始金额 | 币种 | 汇率 (${currency}) | 本币金额 (${currency}) | 支付方式 |\n| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |`;

        if (!content.includes('| 日期 | 描述 |')) {
            // Find the end of AI analysis block
            const analysisEnd = content.indexOf(endMarker);
            if (analysisEnd !== -1) {
                const insertPos = analysisEnd + endMarker.length;
                content = content.slice(0, insertPos) + '\n\n' + tableHeader + '\n' + content.slice(insertPos);
            }
        }

        await this.app.vault.process(file, current => {
            if (current !== originalContent) throw new Error('账本已变化，请刷新后更新报表。');
            return content;
        });
        this.fileCache.delete(file.path);
        await this.app.fileManager.processFrontMatter(file, fm => {
            fm.total_expense = Number(stats.total.toFixed(2));
            fm.transaction_count = stats.transactions.length;
        });
    }

    private generateAnalysisSection(stats: MonthlyStats): string {
        const currency = this.settings.baseCurrency;

        // 1. Summary Callout (Rich version)
        let section = `\n> [!stats] 财务简报\n> - **本月总支出**: \`${stats.total.toFixed(2)} ${currency}\`\n> - **交易总笔数**: \`${stats.transactions.length}\` 笔\n> - **日均支出**: \`${(stats.total / (Object.keys(stats.dailyStats).length || 1)).toFixed(2)} ${currency}\`\n\n`;

        // 2. Mermaid Pie Chart
        section += `### 🍕 支出分类占比\n\n\`\`\`mermaid\npie title ${stats.month} 支出分布\n`;
        for (const [cat, val] of Object.entries(stats.categories)) {
            const cleanCat = cat.replace(/["]/g, '');
            section += `    "${cleanCat}" : ${val.toFixed(2)}\n`;
        }
        section += `\`\`\`\n\n`;

        // 3. Daily Trend Chart (Line Chart)
        const dailyEntries = Object.entries(stats.dailyStats).sort((a, b) => a[0].localeCompare(b[0]));
        if (dailyEntries.length > 1) {
            section += `### 📈 每日支出趋势\n\n\`\`\`mermaid\nxychart-beta\n    title "${stats.month} 每日支出"\n    x-axis [${dailyEntries.map(([d]) => '"' + (d.split('-')[2] || d) + '"').join(', ')}]\n    y-axis "金额 (${currency})" 0 --> ${Math.ceil(Math.max(...dailyEntries.map(([, v]) => v)) * 1.1)}\n    line [${dailyEntries.map(([, v]) => v.toFixed(2)).join(', ')}]\n\`\`\`\n\n`;
        }

        // 3.5 Payment Method Distribution
        if (Object.keys(stats.paymentMethods).length > 0) {
            section += `### 💳 支付方式分布\n\n\`\`\`mermaid\npie title ${stats.month} 支付方式占比\n`;
            for (const [method, val] of Object.entries(stats.paymentMethods)) {
                const cleanMethod = method.replace(/["]/g, '');
                section += `    "${cleanMethod}" : ${val.toFixed(2)}\n`;
            }
            section += `\`\`\`\n\n`;
        }

        // 4. Category Details with progress bars
        section += `### 📑 详细分类统计\n\n`;
        const sortedCats = Object.entries(stats.categories).sort((a, b) => b[1] - a[1]);

        for (const [cat, val] of sortedCats) {
            const percentage = ((val / stats.total) * 100).toFixed(1);
            // Simple visual bar using basic Markdown/HTML
            section += `**${cat}**\n- 金额: \`${val.toFixed(2)} ${currency}\` (${percentage}%)\n`;

            // Secondary categories sub-list
            const secondaries = stats.secondaryCategories[cat];
            if (secondaries) {
                const secList = Object.entries(secondaries)
                    .sort((a, b) => b[1] - a[1])
                    .map(([s, v]) => `\`${s}\`: ${v.toFixed(2)}`)
                    .join(' | ');
                section += `  > [!info] 细分: ${secList}\n`;
            }
            section += `\n`;
        }

        return section;
    }
    public async appendBatchToMonthlyReport(yearMonth: string, transactions: any[], userId?: string) {
        // Determine folder path
        let folderPath = this.settings.financeFolderPath;
        // Default to current user if not specified? Or strictly follow logic.
        // If userId is provided, look it up.
        if (userId) {
            const user = this.settings.users.find(u => u.id === userId);
            if (user) folderPath = user.folder;
        } else {
            // Fallback to current user if implicit?
            // For now, if undefined, use default path (legacy/global)
        }

        const filePath = `${folderPath}/${yearMonth}.md`;

        let file = this.app.vault.getAbstractFileByPath(filePath);
        if (!(file instanceof TFile)) {
            // Ensure folder exists
            if (!this.app.vault.getAbstractFileByPath(folderPath)) {
                await this.app.vault.createFolder(folderPath);
            }

            const initialContent = `---\ntotal_expense: 0\nbase_currency: ${this.settings.baseCurrency}\ntransaction_count: 0\n---\n\n# 📊 ${yearMonth} 财务概览\n\n| 日期 | 描述 | 分类 | 原始金额 | 币种 | 汇率 (${this.settings.baseCurrency}) | 本币金额 (${this.settings.baseCurrency}) | 支付方式 |\n| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |\n`;
            file = await this.app.vault.create(filePath, initialContent);
        }

        if (file instanceof TFile) {
            const prepared = transactions.map(data => ({ ...data, id: data.id || newRecordId() }));
            prepared.forEach(validateTransaction);
            await this.app.vault.process(file, current => {
                const knownIds = new Set(current.split('\n').map(recordId).filter(Boolean));
                const rows: string[] = [];
                for (const data of prepared) {
                    if (knownIds.has(data.id)) continue;
                    if (data.date.slice(0, 7) !== yearMonth) throw new Error('交易日期与月份不一致。');
                    rows.push(renderTransaction(data));
                    knownIds.add(data.id);
                }
                return rows.length ? current.trimEnd() + '\n' + rows.join('\n') + '\n' : current;
            });
            this.fileCache.delete(file.path);
            await this.updateMonthlyFileVisuals(file);
        }
    }

    public async appendToDailyNote(date: string, transactions: any[], userId?: string) {
        if (!this.settings.dailyJournalEnabled) return;
        const folderPath = this.settings.dailyJournalFolderPath;
        if (!folderPath) return;

        // Build filename from pattern
        const filename = this.buildDailyFilename(date);
        const filePath = `${folderPath}/${filename.endsWith('.md') ? filename : filename + '.md'}`;

        let file = this.app.vault.getAbstractFileByPath(filePath);
        if (!(file instanceof TFile)) {
            // Ensure folder exists
            if (!this.app.vault.getAbstractFileByPath(folderPath)) {
                await this.app.vault.createFolder(folderPath);
            }
            const initial = `# ${filename.replace(/\.md$/, '')}\n`;
            file = await this.app.vault.create(filePath, initial);
        }

        if (file instanceof TFile) {
            await this.app.vault.process(file, current => {
            let content = current;

            const currency = this.settings.baseCurrency;
            const tableHeaderLines: [string, string] = [
                `| 描述 | 原始金额 | 汇率 (${currency}) | 本币金额 (${currency}) | 支付方式 |`,
                `| :--- | :--- | :--- | :--- | :--- |`
            ];
            const tableHeaderStr = tableHeaderLines.join('\n');

            if (!transactions || transactions.length === 0) return current;

            // 1. Scan the entire file for existing transactions to build a deduplication set
            const existingKeys = new Set<string>();
            const rowScanRe = /^ *\|(.*)\|\s*$/gm;
            let rowMatch: RegExpExecArray | null;
            while ((rowMatch = rowScanRe.exec(content)) !== null) {
                const parts = (rowMatch[1] || '').split('|').map(s => s.trim());
                if (parts.length >= 5 && parts[0] !== '描述' && !(parts[0] || '').includes(':---')) {
                    const desc = (parts[0] || '').toLowerCase();
                    const amt = Number(parts[1] || '0').toFixed(2);
                    const method = (parts.length > 4 ? (parts[4] || '') : (parts[3] || '')).toLowerCase();
                    const key = `${desc}|${amt}|${method}`;
                    existingKeys.add(key);
                } else if (parts.length >= 8 && (parts[0] || '').match(/^\d{4}-\d{2}-\d{2}$/)) {
                    const desc = (parts[1] || '').toLowerCase();
                    const amt = Number(parts[3] || '0').toFixed(2);
                    const method = (parts[7] || '').toLowerCase();
                    const key = `${desc}|${amt}|${method}`;
                    existingKeys.add(key);
                }
            }

            // 2. Filter new transactions and prepare rows
            let newRows = "";
            let addedCount = 0;
            const pendingKeys = new Set<string>();

            for (const data of transactions) {
                const desc = String(data.description || '');
                const amt = Number(data.amount).toFixed(2);
                const method = String(data.paymentMethod || '未分类');
                const key = data.id || `${desc.toLowerCase()}|${amt}|${method.toLowerCase()}`;

                if ((data.id ? content.includes(`<!-- aa:${data.id} -->`) : existingKeys.has(key)) || pendingKeys.has(key)) continue;

                const row = `| ${encodeCell(desc)} | ${amt} | ${Number(data.rate).toFixed(6)} | ${Number(data.baseAmount).toFixed(2)} | ${encodeCell(method)} |${data.id ? ` <!-- aa:${data.id} -->` : ""}\n`;
                newRows += row;
                
                pendingKeys.add(key);
                addedCount++;
            }

            if (addedCount === 0 || !newRows) return current;

            // 3. Structured Injection
            const anchorRe = new RegExp("^\\s*##\\s+Daily Expenses\\s*$", "m");
            const anchorMatch = anchorRe.exec(content);

            if (anchorMatch) {
                // "## Daily Expenses" heading exists
                const anchorEnd = anchorMatch.index + anchorMatch[0].length;
                const rest = content.slice(anchorEnd);
                
                // Find next heading or end of file indicating section end
                const nextHeadingMatch = /^\s*##\s+.*$/m.exec(rest);
                const sectionEnd = nextHeadingMatch ? anchorEnd + nextHeadingMatch.index : content.length;

                let before = content.slice(0, anchorEnd);
                let section = content.slice(anchorEnd, sectionEnd);
                let after = content.slice(sectionEnd);

                if (section.includes('| 描述 |') || section.includes('| Description |')) {
                    // Table exists under heading, append rows
                    section = section.trimEnd() + '\n' + newRows;
                } else {
                    // Heading exists but no table, create table
                    section = section.trimEnd() + '\n\n' + tableHeaderStr + '\n' + newRows + '\n';
                }

                content = before + section + after;
            } else {
                // "## Daily Expenses" heading does NOT exist
                // Check if the table header itself exists anywhere
                const headerIdx = content.indexOf(tableHeaderLines[0] || '');
                if (headerIdx !== -1) {
                    // Table header exists but no heading. Just append after the header line (and separator line)
                    const alignLineIdx = content.indexOf(tableHeaderLines[1] || '', headerIdx);
                    if (alignLineIdx !== -1) {
                        const insertPos = alignLineIdx + (tableHeaderLines[1] || '').length;
                        // Insert rows directly after table header
                        content = content.slice(0, insertPos) + '\n' + newRows + content.slice(insertPos);
                    } else {
                        // Malformed header, just append the whole table at the end safely
                        content = content.trimEnd() + `\n\n## Daily Expenses\n\n${tableHeaderStr}\n${newRows}`;
                    }
                } else {
                    // No heading, no table header. Append everything at the end.
                    content = content.trimEnd() + `\n\n## Daily Expenses\n\n${tableHeaderStr}\n${newRows}`;
                }
            }

            return content;
            });
        }
    }



    private buildDailyFilename(date: string): string {
        const [year, month, day] = date.split("-");
        const pattern = this.settings.dailyJournalFilePattern || 'YYYY-MM-DD';
        return pattern
            .replace(/YYYY/g, String(year))
            .replace(/MM/g, String(month))
            .replace(/DD/g, String(day));
    }

    public async splitTransaction(originalTx: TransactionRecord, newTransactions: { userId: string, amount: number }[]) {
        // 1. Locate original file
        // We need to find which file contains this transaction.
        // Since we don't store file path in TransactionRecord store it? Or search.
        // Better: Dashboard passes the file path (via stats?) or we search.
        // Current architecture: record has date. We can deduce YYYY-MM. folder? 
        // If multiple users, we need to know WHOSE transaction it is.
        // DashbaordView knows the 'userId' of the transaction (it's in the record).

        let folderPath = this.settings.financeFolderPath;
        if (originalTx.userId && originalTx.userId !== 'default') {
            const user = this.settings.users.find(u => u.id === originalTx.userId);
            if (user) folderPath = user.folder;
        }

        const yearMonth = originalTx.date.slice(0, 7); // YYYY-MM
        const filePath = `${folderPath}/${yearMonth}.md`;
        const file = this.app.vault.getAbstractFileByPath(filePath);

        if (!(file instanceof TFile)) {
            console.error('Original file not found for split:', filePath);
            return;
        }

        let content = await this.app.vault.read(file);

        // 2. Locate the line.
        // We match strictly on Date, Description, Amount.
        // Note: Amount in file is string.
        const originalContent = content;
        const sourceIndex = locateTransaction(content.split('\n'), originalTx);

        // 3. Update Original Transaction
        // Calculate new amount for original user
        // Total - Sum(others)
        const totalSplitOut = newTransactions.reduce((acc, curr) => acc + curr.amount, 0);
        if (newTransactions.some(tx => !Number.isFinite(tx.amount) || tx.amount < 0) || totalSplitOut > originalTx.amount) {
            throw new Error('分账金额无效或超过原交易金额。');
        }
        const newOriginalAmount = originalTx.amount - totalSplitOut;

        // We need to re-calculate baseAmount.
        const rate = originalTx.rate;
        const newOriginalBase = newOriginalAmount * rate;

        const lines = content.split('\n');
        const updateIndex = sourceIndex;

        if (updateIndex === -1) return;

        let targetLine = lines[updateIndex];
        if (!targetLine) return; // Lint fix

        lines[updateIndex] = renderTransaction({
            ...originalTx, id: originalTx.id || newRecordId(),
            amount: newOriginalAmount, baseAmount: newOriginalBase,
            description: originalTx.description.endsWith(' (AA)') ? originalTx.description : originalTx.description + ' (AA)'
        });

        content = lines.join('\n');

        // Update Frontmatter (decrease total)
        // Actually, processFrontMatter is async and handles read/write.
        // But we are modifying content string manually.
        // Mixed approach is dangerous.
        // Better: Modify content string manually for frontmatter too.
        // simple regex for frontmatter?
        // Or assume DataService.regenerateVisuals will fix it?
        // updateMonthlyFileVisuals re-calculates EVERYTHING from parsed tables.
        // So we just need to save the table change!

        await this.app.vault.process(file, current => {
            if (current !== originalContent) throw new Error('原账目已变化，请刷新后分账。');
            return content;
        });
        this.fileCache.delete(file.path);

        // 4. Create New Transactions for other users
        for (const newTx of newTransactions) {
            const userBase = newTx.amount * rate;
            // Append to THEIR folder
            await this.appendBatchToMonthlyReport(
                yearMonth,
                [{
                    date: originalTx.date,
                    description: originalTx.description + ' (AA)',
                    category: originalTx.category,
                    amount: newTx.amount,
                    currency: originalTx.currency,
                    baseAmount: userBase,
                    rate: rate,
                    paymentMethod: originalTx.paymentMethod
                }],
                newTx.userId
            );
        }

        // 5. Trigger update for original file to fix charts/stats
        await this.updateMonthlyFileVisuals(file);
    }

    public async updateTransaction(oldTx: TransactionRecord, newTx: TransactionRecord) {
        validateTransaction(newTx);
        if (oldTx.date.slice(0, 7) !== newTx.date.slice(0, 7)) {
            throw new Error('跨月移动需要迁移两份账本。请先在目标月份录入，再核对删除原记录。');
        }
        const file = this.getLocationFile(oldTx);
        if (!file) throw new Error('未找到原账本。');
        await this.app.vault.process(file, current => {
            const lines = current.split('\n');
            const index = locateTransaction(lines, oldTx);
            lines[index] = renderTransaction({ ...newTx, id: oldTx.id || newRecordId() });
            return lines.join('\n');
        });
        this.fileCache.delete(file.path);
        await this.updateMonthlyFileVisuals(file);
    }

    public async deleteTransaction(targetTx: TransactionRecord) {
        const file = this.getLocationFile(targetTx);
        if (!file) throw new Error('未找到原账本。');
        await this.app.vault.process(file, current => {
            const lines = current.split('\n');
            lines.splice(locateTransaction(lines, targetTx), 1);
            return lines.join('\n');
        });
        this.fileCache.delete(file.path);
        await this.updateMonthlyFileVisuals(file);
    }

    public getLocationFile(tx: TransactionRecord): TFile | null {
        if (tx.sourcePath) {
            const source = this.app.vault.getAbstractFileByPath(tx.sourcePath);
            return source instanceof TFile ? source : null;
        }
        let folderPath = this.settings.financeFolderPath;
        if (tx.userId && tx.userId !== 'default') {
            const user = this.settings.users.find(u => u.id === tx.userId);
            if (user) folderPath = user.folder;
        }
        const yearMonth = tx.date.slice(0, 7);
        const filePath = `${folderPath}/${yearMonth}.md`;
        const file = this.app.vault.getAbstractFileByPath(filePath);
        return (file instanceof TFile) ? file : null;
    }

    private getLineRegex(tx: TransactionRecord): RegExp {
        const escapedDesc = tx.description.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const amountStr = tx.amount.toFixed(2);
        // Loose match on date, desc, amount to identify row
        return new RegExp(`^\\|\\s*${tx.date}\\s*\\|\\s*${escapedDesc}\\s*\\|.*\\|\\s*${amountStr}\\s*\\|`, 'm');
    }

    public async updateCategoryBatch(oldCategory: string, newCategory: string, year?: string) {
        // Find all files that might contain this category
        // If year is provided, filter by year.
        // Use getAllData logic to find files? faster to just scan folders.
        const tasks: { folderPath: string, userId: string }[] = [];
        for (const user of this.settings.users) {
            tasks.push({ folderPath: user.folder, userId: user.id });
        }
        // Legacy/Default
        if (tasks.length === 0 || !tasks.find(t => t.folderPath === this.settings.financeFolderPath)) {
            tasks.push({ folderPath: this.settings.financeFolderPath, userId: 'default' });
        }

        const uniqueFiles = new Set<TFile>();

        for (const task of tasks) {
            const folder = this.app.vault.getAbstractFileByPath(task.folderPath);
            if (!(folder instanceof TFolder)) continue;

            const files = folder.children.filter(f => f instanceof TFile && f.extension === 'md' && /^\d{4}-\d{2}$/.test(f.basename)) as TFile[];
            files.forEach(f => {
                if (year && !f.basename.startsWith(year)) return;
                uniqueFiles.add(f);
            });
        }

        let updateCount = 0;

        for (const file of uniqueFiles) {
            let content = await this.app.vault.read(file);
            let modified = false;

            // Regex approach is risky if category is subset of description. 
            // We should parse lines like in parseMonthlyFile.

            const lines = content.split('\n');
            const newLines: string[] = [];

            // Pattern: | Date | Desc | Category | Amount ...
            const tableRowRegex = /^\s*\|(.*)\|\s*$/;

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i] || ''; // Ensure string
                if (!tableRowRegex.test(line) || line.includes('---|---') || line.includes('| 日期 | 描述')) {
                    newLines.push(line);
                    continue;
                }

                // Split
                const realCols = line.split('|');
                if (realCols.length < 5) {
                    newLines.push(line);
                    continue;
                }

                // Assuming standard format: | Date | Description | Category | ...
                // Index 1: Date, Index 2: Description, Index 3: Category
                const catColIndex = 3;
                const rawCat = realCols[catColIndex];
                if (rawCat !== undefined) {
                    const currentCat = rawCat.trim();
                    if (currentCat === oldCategory || currentCat.startsWith(oldCategory + '/') || currentCat.startsWith(oldCategory + '>')) {
                        // Match! Replace.
                        // If exact match
                        if (currentCat === oldCategory) {
                            realCols[catColIndex] = ` ${newCategory} `;
                            modified = true;
                            updateCount++;
                        } else {
                            // Sub-category match? e.g. "Old/Sub" -> "New/Sub"
                            // If we strictly rename the primary category 'Old' to 'New'
                            // "Old" -> "New"
                            // "Old/A" -> "New/A"
                            if (currentCat.startsWith(oldCategory + '/') || currentCat.startsWith(oldCategory + '>') || currentCat.startsWith(oldCategory + '：') || currentCat.startsWith(oldCategory + ':')) {
                                const separator = currentCat.charAt(oldCategory.length);
                                const suffix = currentCat.slice(oldCategory.length + 1);
                                realCols[catColIndex] = ` ${newCategory}${separator}${suffix} `;
                                modified = true;
                                updateCount++;
                            }
                        }
                    }
                }
                newLines.push(realCols.join('|'));
            }

            if (modified) {
                await this.app.vault.process(file, current => {
                    if (current !== content) throw new Error('账本已变化，请刷新后重新分类。');
                    return newLines.join('\n');
                });
                // Invalidate cache
                this.fileCache.delete(file.path);
                // Trigger visual update
                await this.updateMonthlyFileVisuals(file);
            }
        }

        if (updateCount > 0) {
            new Notice(`Successfully updated ${updateCount} transactions from "${oldCategory}" to "${newCategory}"`);
        } else {
            new Notice(`No transactions found for category "${oldCategory}"`);
        }
    }
}
