import { Modal, Notice, Plugin, Setting, TFile, getLinkpath, TFolder, TAbstractFile, arrayBufferToBase64, WorkspaceLeaf, normalizePath } from 'obsidian';
import { DEFAULT_SETTINGS, AccountingSettings, AccountingSettingTab } from "./settings";
import { FXService } from "./services/FXService";
import { ManualRateModal, MissingRate } from "./modals/ManualRateModal";
import { AIService } from "./services/AIService";
import { DataService } from "./services/DataService";
import { DashboardView, VIEW_TYPE_DASHBOARD } from "./DashboardView";

import { ReviewImportModal } from "./modals/ReviewImportModal";
import { migrateSettings } from './services/migrate';
import { recurringDrafts } from "./services/planning";
import { TransactionRecord } from "./services/DataService";
import { CategoryQuestion, TRANSFER_CATEGORY, TransactionData, failureMessage } from "./services/AIService";
import { ReviewSource } from "./modals/ReviewImportModal";
import { IMAGE_TYPES, MAX_NOTE_IMAGES, embeddedImageLinks } from "./services/embeds";
import { defaultLedgerNames, monthOf, monthPath, rewriteLinkTargets } from "./services/ledgerFiles";
import { ChatImage } from "./ai/providers";
import { PendingDraft } from "./settings";
import { TaskProgress } from "./ai/progress";
import { AiError } from "./ai/providers";
import { isZh, tr } from "./i18n";
import { decodeStatement, readStatement } from "./services/statement";
import { Origin, fromHistory, learn } from "./services/categorize";
import { registerBasesViewWhenReady } from "./basesSupport";
import { LEDGER_VIEW_ID, ledgerViewRegistration } from "./LedgerBasesView";

async function sha256(text: string): Promise<string> {
	return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), byte => byte.toString(16).padStart(2, '0')).join('');
}

const OLD_PLUGIN_ID = 'ai-accounting-plugin';

export default class AccountingPlugin extends Plugin {
	private processingFiles = new Set<string>();
	settings: AccountingSettings;
	fxService: FXService;
	aiService: AIService;
	dataService: DataService;

	async onload() {
		await this.loadSettings();

		this.fxService = new FXService(this.app, this.manifest.dir!);
		this.aiService = new AIService(this.settings, name => this.secret(name));
		this.dataService = new DataService(this.app, this.settings);


		this.registerView(
			VIEW_TYPE_DASHBOARD,
			(leaf) => new DashboardView(leaf, this)
		);
		registerBasesViewWhenReady(this, LEDGER_VIEW_ID, () => ledgerViewRegistration(this));

		// Magic Folder(s) Listener. Obsidian also fires 'create' for every existing file while the vault
		// loads, so listen only after layout is ready; leftover inbox files are handled by "Scan Magic Inbox Now".
		this.app.workspace.onLayoutReady(() => this.registerEvent(
			this.app.vault.on('create', (file: TAbstractFile) => {
				if (!(file instanceof TFile)) return;

				// Check default magic folder
				if (this.settings.magicFolderPath && file.path.startsWith(this.settings.magicFolderPath.replace(/\/$/, '') + '/')) {
					void this.processMagicFile(file);
					return;
				}

				// Check user dedicated inbox folders
				for (const user of this.settings.users) {
					if (user.inboxFolder && file.path.startsWith(user.inboxFolder.replace(/\/$/, '') + '/')) {
						void this.processMagicFile(file);
						return;
					}
				}
			})
		));

		this.addCommand({
			id: 'scan-magic-inbox',
			name: tr('Scan inbox now', '立即扫描收件箱'),
			callback: () => void this.scanInbox()
		});

		this.addCommand({
			id: 'open-accounting-dashboard',
			name: tr('Open dashboard', '打开账本'),
			callback: () => void this.activateView()
		});

		this.addCommand({
			id: 'process-current-note',
			name: tr('Read the current note into the ledger', '识别当前笔记并记账'),
			callback: () => void this.processCurrentNote()
		});

		this.addCommand({
			id: 'open-dashboard-new-pane',
			name: tr('Open dashboard in a new pane', '在新窗格打开账本'),
			callback: () => void this.openNewDashboard()
		});

		this.addCommand({
			id: 'regenerate-all-visuals',
			name: tr('Regenerate charts in all monthly reports', '重新生成所有月报的图表'),
			callback: async () => {
				const folder = this.app.vault.getAbstractFileByPath(this.settings.financeFolderPath);
				if (!(folder instanceof TFolder)) {
					new Notice(tr('Ledger folder not found.', '找不到账本文件夹。'));
					return;
				}

				const files = folder.children.filter((f): f is TFile => f instanceof TFile && f.extension === 'md' && this.dataService.ledgerMonth(f) !== null);

				new Notice(tr(`Updating charts in ${files.length} monthly reports…`, `正在更新 ${files.length} 份月报的图表…`));

				for (const file of files) {
					await this.dataService.updateMonthlyFileVisuals(file);
				}

				new Notice(tr('Charts updated in every monthly report.', '月报图表已全部更新。'));
			}
		});

		this.addCommand({
			id: 'rename-monthly-ledgers',
			name: tr('Rename monthly ledgers so they do not clash with monthly notes', '给月账本改名，不再和月记同名'),
			callback: () => void this.renameBareLedgers()
		});

		this.addCommand({
			id: 'import-statement',
			name: tr('Import a bank or payment app statement (CSV)', '导入银行或支付软件账单（CSV）'),
			callback: () => this.pickStatement()
		});

		this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
			if (!(file instanceof TFile) || !['csv', 'tsv', 'txt'].includes(file.extension.toLowerCase())) return;
			menu.addItem(item => item
				.setTitle(tr('Accounting: import this statement', '记账：导入这份账单'))
				.setIcon('coins')
				.onClick(async () => this.importStatement(file.name, await this.app.vault.readBinary(file))));
		}));

		this.addCommand({
			id: 'add-recurring-expenses',
			name: tr("Add this month's recurring expenses", '添加本月固定支出'),
			callback: () => void this.addRecurringForMonth()
		});

		this.addCommand({
			id: 'sync-historical-to-daily-journal',
			name: tr('Copy past transactions to daily notes', '把历史账目同步到日记'),
			callback: async () => {
				await this.syncHistoricalToDailyJournal();
			}
		});

		this.registerEvent(
			this.app.workspace.on('editor-menu', (menu, editor, view) => {
				menu.addItem((item) => {
					item
						.setTitle(tr('Accounting: read this note', '记账：识别这篇笔记'))
						.setIcon('coins')
						.onClick(async () => {
							await this.processCurrentNote();
						});
				});
			})
		);

		this.addSettingTab(new AccountingSettingTab(this.app, this));

		this.addRibbonIcon('pie-chart', tr('Open accounting dashboard', '打开记账面板'), () => {
			void this.activateView();
		});

		this.registerObsidianProtocolHandler('ai-accounting', async (params) => {
			if (params.action === 'dashboard-new-tab') {
				const leaf = this.app.workspace.getLeaf('tab');
				await leaf.setViewState({
					type: VIEW_TYPE_DASHBOARD,
					active: true,
				});
				void this.app.workspace.revealLeaf(leaf);
			} else {
				await this.activateView();
			}
		});
	}

	/** Makes sure every currency and date has a rate, asking for the ones that cannot be fetched. False when cancelled. */
	async ensureRates(rows: { currency: string; date: string }[]): Promise<boolean> {
		const base = this.settings.baseCurrency;
		const missing: MissingRate[] = [];
		const seen = new Set<string>();
		for (const row of rows) {
			const key = `${row.currency}|${row.date}`;
			if (seen.has(key)) continue;
			seen.add(key);
			if (await this.fxService.tryExchangeRate(row.currency, base, row.date) === null) {
				missing.push({ currency: row.currency, date: row.date, hint: this.fxService.lastKnownRate(row.currency, base) });
			}
		}
		if (missing.length === 0) return true;
		const rates = await new ManualRateModal(this.app, missing, base).ask();
		if (!rates) return false;
		for (const [i, m] of missing.entries()) await this.fxService.setManualRate(m.currency, base, m.date, rates[i] ?? 0);
		return true;
	}

	/**
	 * Write reviewed rows to the monthly ledgers (and daily notes when enabled).
	 * Each row keeps a stable ID, so writing the same rows again adds nothing.
	 * Null when the user cancels entering a missing exchange rate; nothing is written then.
	 */
	async saveTransactions(rows: TransactionData[], userId: string, idFor: (row: TransactionData, index: number) => string): Promise<string[] | null> {
		if (!(await this.ensureRates(rows))) return null;
		const batches: Record<string, TransactionRecord[]> = {};
		const dailyMap: Record<string, TransactionRecord[]> = {};
		for (const [index, data] of rows.entries()) {
			const baseAmount = await this.fxService.convert(data.amount, data.currency, this.settings.baseCurrency, data.date);
			const rate = await this.fxService.getExchangeRate(data.currency, this.settings.baseCurrency, data.date);
			const record: TransactionRecord = { ...data, id: data.id || idFor(data, index), baseAmount, rate };
			(batches[data.date.slice(0, 7)] ??= []).push(record);
			(dailyMap[data.date] ??= []).push(record);
		}
		const months = Object.keys(batches).sort((a, b) => b.localeCompare(a));
		for (const month of months) await this.dataService.appendBatchToMonthlyReport(month, batches[month] || [], userId);
		if (this.settings.dailyJournalEnabled) {
			for (const date of Object.keys(dailyMap).sort()) await this.dataService.appendToDailyNote(date, dailyMap[date] || [], userId);
		}
		return months;
	}

	/** Recurring expenses of this month that are not in the ledger yet, checked in the review dialog first. */
	async addRecurringForMonth(month = this.getCurrentYearMonth()) {
		const stats = await this.dataService.getAllData();
		const known = new Set(stats.flatMap(s => s.transactions.map(t => t.id)).filter((id): id is string => !!id));
		const drafts = recurringDrafts(this.settings.recurring, month, known);
		if (drafts.length === 0) {
			new Notice(this.settings.recurring.some(r => r.enabled) ? tr(`Recurring expenses for ${month} are all entered.`, `${month} 的固定支出都已入账。`) : tr('No recurring expenses yet. Add them in settings → Recurring expenses.', '还没有固定支出。可在设置 → 固定支出里添加。'));
			return;
		}
		const userId = this.settings.currentUser || this.settings.users[0]?.id || 'default';
		const userName = this.settings.users.find(u => u.id === userId)?.name || '';
		const reviewed = await new ReviewImportModal(this.app, drafts, userName, tr(`${month} recurring`, `${month} 固定支出`), {}, tr('Recurring draft', '固定支出草稿')).review();
		if (!reviewed?.length) return;
		try {
			if (!(await this.saveTransactions(reviewed, userId, row => row.id || ''))) return;
		} catch (error) {
			new Notice((error as Error).message, 7000);
			return;
		}
		new Notice(tr(`Entered ${reviewed.length} recurring expense(s).`, `已入账 ${reviewed.length} 笔固定支出。`));
		this.refreshDashboards();
	}

	private async syncHistoricalToDailyJournal() {
		if (!this.settings.dailyJournalEnabled) {
			new Notice(tr('Turn on "Copy to daily notes" in settings first.', '请先在设置里打开“同步到日记”。'));
			return;
		}
		const notice = new Notice(tr('Copying past entries to daily notes…', '开始同步历史账目到日记...'), 0);
		const stats = await this.dataService.getAllData();
		const dailyMap: Record<string, TransactionRecord[]> = {};
		let total = 0;
		for (const s of stats) {
			for (const tx of s.transactions) {
				const d = (tx.date || '').slice(0, 10);
				if (!d) continue;
				if (!dailyMap[d]) dailyMap[d] = [];
				dailyMap[d].push(tx);
				total += 1;
			}
		}
		const dates = Object.keys(dailyMap).sort((a, b) => a.localeCompare(b));
		for (const d of dates) {
			const txs = dailyMap[d] || [];
			if (txs.length > 0) {
				await this.dataService.appendToDailyNote(d, txs);
			}
		}
		notice.hide();
		new Notice(tr(`Done: ${total} entries over ${dates.length} days.`, `同步完成，共处理 ${total} 条交易，涉及 ${dates.length} 天。`));
	}

	async activateView() {
		const { workspace } = this.app;

		let leaf: WorkspaceLeaf | null = null;
		const leaves = workspace.getLeavesOfType(VIEW_TYPE_DASHBOARD);

		if (leaves.length > 0) {
			leaf = leaves[0] as WorkspaceLeaf;
		} else {
			// 在主笔记区域（Root Split）新建一个标签页
			leaf = workspace.getLeaf('tab');
			await leaf.setViewState({
				type: VIEW_TYPE_DASHBOARD,
				active: true,
			});
		}

		if (leaf) {
			void workspace.revealLeaf(leaf);
		}
	}

	async openNewDashboard() {
		const { workspace } = this.app;

		// Create a new leaf (split pane)
		const leaf = workspace.getLeaf('split');

		await leaf.setViewState({
			type: VIEW_TYPE_DASHBOARD,
			active: true,
		});

		void workspace.revealLeaf(leaf);
	}

	async scanInbox() {
		const folder = this.app.vault.getAbstractFileByPath(this.settings.magicFolderPath);
		if (folder instanceof TFile) {
			await this.processMagicFile(folder);
		} else if (folder) {
			// It's a folder, iterate its children
			const files = folder instanceof TFolder ? folder.children : [];
			for (const file of files) {
				if (file instanceof TFile) {
					await this.processMagicFile(file);
				}
			}
			new Notice(tr('Scan complete.', '扫描完成。'));
		} else {
			new Notice(tr(`Inbox folder not found: ${this.settings.magicFolderPath}`, `找不到收件箱文件夹：${this.settings.magicFolderPath}`));
		}
	}

	async processCurrentNote() {
		const file = this.app.workspace.getActiveFile();
		if (file) {
			await this.processMagicFile(file, false, true);
		} else {
			new Notice(tr('Open a note first.', '请先打开一篇笔记。'));
		}
	}

	async processMagicFile(file: TFile, shouldArchive: boolean = true, appendToArchiveMonthly: boolean = false) {
		const processingPath = file.path;
		if (this.processingFiles.has(processingPath)) return;
		const ext = file.extension.toLowerCase();
		const isImage = ext in IMAGE_TYPES;
		if (!isImage && !['md', 'txt'].includes(ext)) return;
		this.processingFiles.add(processingPath);
		try {
			const text = isImage ? '' : await this.app.vault.read(file);
			// An image file is sent as it is; a note goes with the images it embeds.
			const imageFiles = isImage ? [file] : this.embeddedImages(file, text);
			const images: ChatImage[] = [];
			for (const image of imageFiles) images.push({ data: arrayBufferToBase64(await this.app.vault.readBinary(image)), mimeType: IMAGE_TYPES[image.extension.toLowerCase()] ?? 'image/jpeg' });
			const hash = await sha256([text, ...images.map(image => image.data)].join('\n'));
			// The same receipt reuses its draft instead of being sent to the AI again.
			let draft = this.settings.drafts.find(d => d.hash === hash);
			if (!draft) {
				const userId = this.determineUserForFile(file, text);
				const rows = await this.recognize(file.name, text, images,
					() => void this.processMagicFile(file, shouldArchive, appendToArchiveMonthly));
				if (!rows) return;
				if (rows.length === 0) {
					new Notice(tr(`No transactions found in ${file.name}. The file was left as it is.`, `${file.name} 里没有找到交易，文件保持原样。`));
					return;
				}
				draft = {
					id: hash.slice(0, 16), source: file.name, sourcePath: file.path, hash, userId, kind: isImage ? 'image' : 'text',
					archive: shouldArchive, appendArchive: appendToArchiveMonthly && !isImage, createdAt: new Date().toISOString(), rows
				};
				this.settings.drafts.push(draft);
				await this.saveSettings();
				this.refreshDashboards();
			}
			await this.reviewDraft(draft);
		} catch (error) {
			console.error('AI Accounting: could not process the file.', error);
			new Notice(tr(`Not finished: ${(error as Error).message}. The original file is kept.`, `处理未完成：${(error as Error).message}。原始文件已保留。`), 8000);
		} finally {
			this.processingFiles.delete(processingPath);
		}
	}

	/** Image files a note embeds, resolved from its folder; at most MAX_NOTE_IMAGES, with a notice when more are left out. */
	embeddedImages(note: TFile, text: string, notify = true): TFile[] {
		const files: TFile[] = [];
		for (const link of embeddedImageLinks(text)) {
			const target = this.app.metadataCache.getFirstLinkpathDest(link, note.path) ?? this.app.vault.getFileByPath(normalizePath(link));
			if (target && !files.includes(target)) files.push(target);
		}
		if (notify && files.length > MAX_NOTE_IMAGES) new Notice(tr(`${note.name} embeds ${files.length} images; the first ${MAX_NOTE_IMAGES} are read.`, `${note.name} 里有 ${files.length} 张图片，只读前 ${MAX_NOTE_IMAGES} 张。`));
		return files.slice(0, MAX_NOTE_IMAGES);
	}

	/** Asks for a statement file from outside the vault; a CSV inside the vault is imported from its file menu. */
	private pickStatement() {
		const input = activeDocument.body.createEl('input', { attr: { type: 'file', accept: '.csv,.tsv,.txt,text/csv' }, cls: 'aa-hidden-input' });
		input.addEventListener('change', () => {
			const file = input.files?.[0];
			input.remove();
			if (file) void file.arrayBuffer().then(bytes => this.importStatement(file.name, bytes));
		});
		input.click();
	}

	/**
	 * Reads a statement on this device, files each row by how the same shop was filed before, asks the AI service only
	 * about the rows left over, and opens the review. Nothing is written until the review is confirmed.
	 */
	async importStatement(name: string, bytes: ArrayBuffer) {
		const statement = readStatement(decodeStatement(bytes), this.settings.defaultInputCurrency);
		if (!statement.rows.length) {
			new Notice(statement.income
				? tr(`${name} has only income (${statement.income} rows); the ledger records spending.`, `${name} 里只有收入（${statement.income} 笔），账本只记支出。`)
				: tr(`No transactions found in ${name}. Export the statement as CSV with a date and an amount column.`, `${name} 里没找到交易。请导出带日期和金额两列的 CSV 账单。`), 8000);
			return;
		}

		const history = (await this.dataService.getAllData()).flatMap(month => month.transactions.map(tx => ({ description: tx.description, category: tx.category })));
		const memory = learn(history);
		const origins: Origin[] = [];
		const rows: TransactionData[] = statement.rows.map((row, index) => {
			const known = row.hint === TRANSFER_CATEGORY ? `${TRANSFER_CATEGORY} / ${tr('Own accounts', '自己账户之间')}` : fromHistory(row.description, memory);
			origins[index] = known ? 'history' : 'none';
			return { date: row.date, description: row.description, category: known ?? '', amount: row.amount, currency: row.currency, paymentMethod: row.paymentMethod };
		});

		const questions: CategoryQuestion[] = statement.rows.flatMap((row, i) => origins[i] === 'none' ? [{ i, text: row.description, amount: row.amount, currency: row.currency, ...(row.hint ? { hint: row.hint } : {}) }] : []);
		let aiNote = '';
		if (questions.length && this.aiService.services(false).length) {
			const progress = new TaskProgress(tr(`Filing ${questions.length} rows from ${name}`, `给 ${name} 的 ${questions.length} 笔分类`), 'aa');
			progress.step(tr('Asking for categories…', '请 AI 建议分类…'), 1, 2);
			try {
				const suggested = await this.aiService.suggestCategories(questions, memory.categories, {
					token: progress.token,
					onAttempt: service => progress.step(tr(`Waiting for ${service}…`, `等待 ${service} 回复…`), 2, 2)
				});
				for (const [i, category] of suggested) {
					const row = rows[i];
					if (row && !row.category) { row.category = category; origins[i] = 'ai'; }
				}
				progress.close();
			} catch (error) {
				if (progress.cancelled || (error instanceof AiError && error.kind === 'cancelled')) aiNote = tr('AI suggestions were cancelled.', '已取消 AI 建议。');
				else { progress.close(); aiNote = `${tr('No AI suggestions:', '没拿到 AI 建议：')} ${failureMessage(error)}`; }
			}
		} else if (questions.length) {
			aiNote = tr('No AI service is set up, so the rest are left for you.', '没设置 AI 服务，剩下的留给你选。');
		}

		const count = (origin: Origin) => origins.filter(o => o === origin).length;
		const sourceName = { alipay: tr('Alipay', '支付宝'), wechat: tr('WeChat Pay', '微信支付'), bank: tr('Bank', '银行'), card: tr('Card', '信用卡'), generic: 'CSV' }[statement.source];
		const summary = [
			tr(`${sourceName} statement · ${rows.length} to enter`, `${sourceName}账单 · ${rows.length} 笔待入账`),
			...(count('history') ? [tr(`Filed as before in your ledger: ${count('history')}`, `按你以前的记账分类：${count('history')} 笔`)] : []),
			...(count('ai') ? [tr(`Suggested by AI, marked below: ${count('ai')}`, `AI 建议（下面有标记）：${count('ai')} 笔`)] : []),
			...(count('none') ? [tr(`For you to choose: ${count('none')}`, `等你选：${count('none')} 笔`)] : []),
			...(statement.income ? [tr(`Income left out: ${statement.income}`, `收入未导入：${statement.income} 笔`)] : []),
			...(statement.skipped ? [tr(`Closed, failed or unreadable rows left out: ${statement.skipped}`, `关闭、失败或读不出的：${statement.skipped} 笔`)] : []),
			...(aiNote ? ['', aiNote] : [])
		].join('\n');

		const userId = this.settings.currentUser || this.settings.users[0]?.id || 'default';
		const userName = this.settings.users.find(u => u.id === userId)?.name || '';
		const suggested = new Map(rows.flatMap((row, i) => origins[i] === 'ai' ? [[i, row.category] as [number, string]] : []));
		const reviewed = await new ReviewImportModal(this.app, rows, userName, name, { text: summary }, tr('Statement draft', '账单草稿'), {
			duplicates: await this.findDuplicates(rows),
			suggested
		}).review();
		if (!reviewed?.length) return;
		try {
			if (!(await this.saveTransactions(reviewed, userId, row => `csv-${statementRowId(row)}`))) return;
		} catch (error) {
			new Notice((error as Error).message, 7000);
			return;
		}
		new Notice(tr(`Entered ${reviewed.length} transaction(s) from ${name}.`, `已从 ${name} 入账 ${reviewed.length} 笔。`));
		this.refreshDashboards();
	}

	/** Sends the input to the AI with a progress notice. Null when cancelled or failed (the notice offers Retry). */
	private async recognize(name: string, text: string, images: ChatImage[], retry: () => void): Promise<TransactionData[] | null> {
		const progress = new TaskProgress(tr(`Reading ${name}`, `识别 ${name}`), 'aa');
		progress.step(tr('Preparing…', '准备中…'), 1, 3);
		try {
			const rows = await this.aiService.processInput(text, images, {
				token: progress.token,
				onAttempt: (service, index, total) => progress.step(total > 1
					? tr(`Waiting for ${service} (service ${index} of ${total})…`, `等待 ${service} 回复（第 ${index}/${total} 个服务）…`)
					: tr(`Waiting for ${service}…`, `等待 ${service} 回复…`), 2, 3)
			});
			progress.step(tr('Making the draft…', '整理草稿…'), 3, 3);
			progress.close();
			return rows;
		} catch (error) {
			if (progress.cancelled || (error instanceof AiError && error.kind === 'cancelled')) return null;
			// Without a service there is nothing to retry; the next step is the settings.
			const setup = error instanceof AiError && (error.detail === 'no-service' || error.detail === 'no-vision' || error.kind === 'no-key');
			if (setup) progress.fail(failureMessage(error), () => this.openSettings(), tr('Open settings', '打开设置'));
			else progress.fail(failureMessage(error), retry);
			return null;
		}
	}

	/** Same date, currency and amount as a row already in the ledger: index → that row's description. */
	async findDuplicates(rows: TransactionData[]): Promise<Map<number, string>> {
		const found = new Map<number, string>();
		const existing = (await this.dataService.getAllData()).flatMap(s => s.transactions);
		rows.forEach((row, index) => {
			const match = existing.find(tx => tx.date === row.date && tx.currency === row.currency && Math.abs(tx.amount - Number(row.amount)) < 0.005 && (!row.id || tx.id !== row.id));
			if (match) found.set(index, match.description || match.category);
		});
		return found;
	}

	/** Opens a saved draft for review; it stays saved until it is entered or discarded. */
	async reviewDraft(draft: PendingDraft) {
		const userName = this.settings.users.find(u => u.id === draft.userId)?.name || '';
		const file = draft.sourcePath ? this.app.vault.getFileByPath(draft.sourcePath) : null;
		let preview: ReviewSource = {};
		if (file && draft.kind === 'image') preview = { imageSrc: this.app.vault.getResourcePath(file) };
		else if (file) {
			const text = await this.app.vault.read(file);
			const image = this.embeddedImages(file, text, false)[0];
			preview = image ? { imageSrc: this.app.vault.getResourcePath(image) } : { text: text.slice(0, 1200) };
		}
		const result = await new ReviewImportModal(this.app, draft.rows, userName, draft.source, preview, tr('AI draft', 'AI 草稿'), {
			duplicates: await this.findDuplicates(draft.rows),
			onDiscard: async () => { await this.discardDraft(draft.id); new Notice(tr('Draft discarded. The original file is kept.', '已丢弃草稿，原始文件保留。')); },
			onKeep: async rows => { draft.rows = rows; await this.saveSettings(); }
		}).review();
		if (!result) return;
		let months: string[] | null;
		try {
			months = await this.saveTransactions(result, draft.userId, (_row, index) => `${draft.hash.slice(0, 32)}-${index}`);
		} catch (error) {
			new Notice(`${(error as Error).message} ${tr('The draft is kept.', '草稿已保留。')}`, 8000);
			return;
		}
		if (!months) return;
		await this.discardDraft(draft.id);
		new Notice(tr(`Entered ${result.length} transaction(s)${userName ? ` for ${userName}` : ''}.`, `已入账 ${result.length} 笔${userName ? `（${userName}）` : ''}。`));
		if (file && draft.appendArchive) await this.appendContentToArchiveMonthly(months.length > 0 ? months : [this.getCurrentYearMonth()], file, await this.app.vault.read(file));
		if (file && draft.archive) await this.archiveFile(file);
	}

	openSettings() {
		const setting = (this.app as typeof this.app & { setting?: { open(): void; openTabById(id: string): void } }).setting;
		setting?.open();
		setting?.openTabById(this.manifest.id);
	}

	async discardDraft(id: string) {
		this.settings.drafts = this.settings.drafts.filter(d => d.id !== id);
		await this.saveSettings();
		this.refreshDashboards();
	}

	/** Open dashboards cache the ledger; reload them after writing new rows or switching the style. */
	refreshDashboards() {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_DASHBOARD)) {
			if (leaf.view instanceof DashboardView) void leaf.view.refresh();
		}
	}

	private getCurrentYearMonth(): string {
		const now = new Date();
		return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
	}

	/** Ledgers and source archives still named "YYYY-MM", with the name each would get; ones whose new name is taken are left out. */
	bareLedgerRenames(): { file: TFile; to: string }[] {
		const names = this.settings.ledgerNames ?? defaultLedgerNames(isZh());
		const folders = new Map<string, string>();
		for (const folder of [this.settings.financeFolderPath, ...this.settings.users.map(user => user.folder)]) if (folder) folders.set(folder, names.ledger);
		if (this.settings.archiveFolderPath) folders.set(this.settings.archiveFolderPath, names.archive);
		const plan: { file: TFile; to: string }[] = [];
		for (const [path, prefix] of folders) {
			const folder = this.app.vault.getFolderByPath(path);
			for (const child of folder?.children ?? []) {
				if (!(child instanceof TFile) || child.extension !== 'md' || monthOf(child.basename, '') === null) continue;
				const to = `${path}/${prefix}${child.basename}.md`;
				if (!this.app.vault.getAbstractFileByPath(to)) plan.push({ file: child, to });
			}
		}
		return plan;
	}

	/**
	 * Link rewrites a rename plan needs, per note. A link written with a folder (`[[Finances/2026-01]]`) clearly means
	 * the ledger and follows it. A bare `[[2026-01]]` is left alone while another file of that name remains, such as a
	 * monthly note: that is the file it should have meant all along.
	 */
	linkRewritesFor(plan: { file: TFile; to: string }[]): { rewrites: Map<TFile, Map<string, string>>; kept: number } {
		const moving = new Map(plan.map(item => [item.file, item.to.slice(item.to.lastIndexOf('/') + 1, -3)]));
		const staying = (basename: string) => this.app.vault.getMarkdownFiles().some(f => f.basename === basename && !moving.has(f));
		const rewrites = new Map<TFile, Map<string, string>>();
		let kept = 0;
		for (const source of this.app.vault.getMarkdownFiles()) {
			const cache = this.app.metadataCache.getFileCache(source);
			for (const ref of [...(cache?.links ?? []), ...(cache?.embeds ?? []), ...(cache?.frontmatterLinks ?? [])]) {
				const linkpath = getLinkpath(ref.link).replace(/\.md$/i, '');
				const dest = this.app.metadataCache.getFirstLinkpathDest(linkpath, source.path);
				const newBase = dest ? moving.get(dest) : undefined;
				if (!dest || newBase === undefined) continue;
				const slash = linkpath.lastIndexOf('/');
				if (slash < 0 && staying(dest.basename)) {
					kept++;
					continue;
				}
				const map = rewrites.get(source) ?? new Map<string, string>();
				map.set(linkpath, `${linkpath.slice(0, slash + 1)}${newBase}`);
				rewrites.set(source, map);
			}
		}
		return { rewrites, kept };
	}

	/** Renames old "YYYY-MM" ledgers after a confirmation and points the links that meant them at the new names. */
	async renameBareLedgers() {
		const plan = this.bareLedgerRenames();
		if (plan.length === 0) {
			new Notice(tr('Every monthly ledger already has its new name.', '月账本都已经是新文件名。'));
			return;
		}
		const { rewrites, kept } = this.linkRewritesFor(plan);
		const linkCount = [...rewrites.values()].reduce((sum, map) => sum + map.size, 0);
		const confirmed = await new Promise<boolean>(resolve => {
			const modal = new Modal(this.app);
			let done = false;
			modal.modalEl.addClass('aa-modal', 'ap', 'ap-modal');
			modal.setTitle(tr(`Rename ${plan.length} files`, `改名 ${plan.length} 个文件`));
			if (linkCount > 0) modal.contentEl.createEl('p', { cls: 'ap-sub', text: tr(`${linkCount} links in ${rewrites.size} notes follow the new names.`, `${rewrites.size} 篇笔记里的 ${linkCount} 处链接跟着改。`) });
			if (kept > 0) modal.contentEl.createEl('p', { cls: 'ap-sub', text: tr(`${kept} links written like [[${plan[0]?.file.basename ?? ''}]] stay with the other note of that name, such as a monthly note.`, `${kept} 处只写 [[${plan[0]?.file.basename ?? ''}]] 的链接不改，留给同名的另一篇笔记（如月记）。`) });
			const list = modal.contentEl.createEl('ul', { cls: 'aa-rename-list' });
			for (const { file, to } of plan.slice(0, 12)) list.createEl('li', { text: `${file.path} → ${to.split('/').pop() ?? to}` });
			if (plan.length > 12) list.createEl('li', { text: tr(`and ${plan.length - 12} more`, `还有 ${plan.length - 12} 个`) });
			new Setting(modal.contentEl)
				.addButton(btn => btn.setButtonText(tr('Cancel', '取消')).onClick(() => modal.close()))
				.addButton(btn => btn.setButtonText(tr('Rename', '改名')).setCta().onClick(() => { done = true; modal.close(); }));
			modal.onClose = () => resolve(done);
			modal.open();
		});
		if (!confirmed) return;
		let renamed = 0;
		for (const { file, to } of plan) {
			try {
				// vault.rename leaves links alone; the ones that meant the ledger are rewritten below.
				await this.app.vault.rename(file, to);
				renamed++;
			} catch (error) {
				console.error(`AI Accounting: could not rename ${file.path}.`, error);
			}
		}
		for (const [source, map] of rewrites) await this.app.vault.process(source, text => rewriteLinkTargets(text, map));
		new Notice(renamed === plan.length ? tr(`Renamed ${renamed} files.`, `已改名 ${renamed} 个文件。`) : tr(`Renamed ${renamed} of ${plan.length} files; see the console for the rest.`, `改名了 ${renamed}／${plan.length} 个文件，其余见控制台。`), 7000);
		this.refreshDashboards();
	}

	private async appendContentToArchiveMonthly(months: string[], sourceFile: TFile, rawContent: string) {
		if (!this.settings.archiveFolderPath) return;
		const folderPath = this.settings.archiveFolderPath;
		if (!this.app.vault.getAbstractFileByPath(folderPath)) {
			await this.app.vault.createFolder(folderPath);
		}
		const prefix = (this.settings.ledgerNames ?? defaultLedgerNames(false)).archive;
		for (const m of months) {
			const filePath = monthPath(folderPath, m, prefix, path => this.app.vault.getAbstractFileByPath(path) instanceof TFile);
			let target = this.app.vault.getAbstractFileByPath(filePath);
			if (!(target instanceof TFile)) {
				target = await this.app.vault.create(filePath, `# ${m} Archive\n`);
			}
			if (target instanceof TFile) {
				let content = await this.app.vault.read(target);
				const body = this.stripFrontmatter(rawContent).trim();
				if (body.length === 0) continue;
				const headingDate = this.getHeadingDate(rawContent, sourceFile);
				const block = `\n\n## ${headingDate}\n\n${body}\n`;
				content += block;
				await this.app.vault.modify(target, content);
			}
		}
	}

	private stripFrontmatter(md: string): string {
		if (md.startsWith('---')) {
			const match = md.match(/^---\s*\n[\s\S]*?\n---\s*\n?/);
			if (match) {
				return md.slice(match[0].length);
			}
		}
		return md;
	}

	private getHeadingDate(md: string, file: TFile): string {
		const fmDate = this.extractDateFromFrontmatter(md);
		if (fmDate) {
			const d = new Date(fmDate);
			if (!isNaN(d.getTime())) {
				return this.formatDateYYYYMMDD(d);
			}
			const m = fmDate.match(/^(\d{4}-\d{2}-\d{2})/);
			if (m && m[1]) return m[1];
			return fmDate;
		}
		return this.formatDateYYYYMMDD(new Date(file.stat.mtime));
	}

	private extractDateFromFrontmatter(md: string): string | null {
		if (!md.startsWith('---')) return null;
		const m = md.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
		if (!m || !m[1]) return null;
		const fm = m[1];
		const d = fm.match(/^\s*date:\s*(.+)\s*$/m);
		if (!d || !d[1]) return null;
		return d[1].trim();
	}

	private formatDateYYYYMMDD(d: Date): string {
		const y = d.getFullYear();
		const m = String(d.getMonth() + 1).padStart(2, '0');
		const day = String(d.getDate()).padStart(2, '0');
		return `${y}-${m}-${day}`;
	}

	/**
	 * Logic to determine which user a file belongs to.
	 * 1. Dedicated Inbox Folder match
	 * 2. Subfolder under Magic Inbox named after user
	 * 3. H1 Heading match for User Name (Text only)
	 * 4. Fallback to settings.currentUser
	 */
	private determineUserForFile(file: TFile, firstLines: string): string {
		// 1. Dedicated Inbox Check
		for (const user of this.settings.users) {
			if (user.inboxFolder && file.path.startsWith(user.inboxFolder.replace(/\/$/, '') + '/')) {
				return user.id;
			}
		}

		// 2. Subfolder under Magic Inbox Check
		if (this.settings.magicFolderPath && file.path.startsWith(this.settings.magicFolderPath.replace(/\/$/, '') + '/')) {
			// Extract folder immediately under magic folder
			const subPath = file.path.substring(this.settings.magicFolderPath.length).replace(/^[\\/]/, '');
			const parts = subPath.split(/[\\/]/);
			if (parts.length > 1) {
				const folderName = parts[0];
				const user = this.settings.users.find(u => u.name === folderName || u.id === folderName);
				if (user) return user.id;
			}
		}

		// 3. H1 Heading Check (only if content is provided)
		if (firstLines) {
			const h1Match = firstLines.match(/^#\s+(.+)$/m);
			if (h1Match && h1Match[1]) {
				const h1Name = h1Match[1].trim();
				const user = this.settings.users.find(u => u.name === h1Name);
				if (user) return user.id;
			}
		}

		return this.settings.currentUser;
	}

	async archiveFile(file: TFile) {
		if (!this.settings.archiveFolderPath) {
			// Respect the user's "deleted files" setting instead of deleting permanently.
			await this.app.fileManager.trashFile(file);
			return;
		}

		const archivePath = `${this.settings.archiveFolderPath}/${file.name}`;

		// Ensure folder exists
		if (!this.app.vault.getAbstractFileByPath(this.settings.archiveFolderPath)) {
			await this.app.vault.createFolder(this.settings.archiveFolderPath);
		}

		// Handle name collisions
		let finalPath = archivePath;
		let i = 1;
		while (this.app.vault.getAbstractFileByPath(finalPath)) {
			finalPath = `${this.settings.archiveFolderPath}/${file.basename}_${i}.${file.extension}`;
			i++;
		}

		await this.app.fileManager.renameFile(file, finalPath);
	}



	onunload() {
	}

	async loadSettings() {
		let data = await this.loadData() as Partial<AccountingSettings> | null;
		const imported = !data ? await this.importFromOldId() : null;
		if (imported) data = imported;
		const legacyShape = !!data && 'aiProvider' in data;
		this.settings = migrateSettings(data, DEFAULT_SETTINGS);
		const movedKeys = this.moveKeysToSecretStorage();
		const namedLedgers = !this.settings.ledgerNames;
		this.settings.ledgerNames ??= defaultLedgerNames(isZh());
		if (imported || movedKeys || legacyShape || namedLedgers) await this.saveData(this.settings);
		if (imported) {
			this.app.workspace.onLayoutReady(() => new Notice(tr('AI Accounting: settings were imported from the old plugin. Once they look right, turn off and remove the old one under Community plugins.', '记账：已导入旧版插件的设置。确认无误后，可以在第三方插件里停用并删除旧版。'), 0));
		}
	}

	/**
	 * Until 0.4.0 the plugin id was "ai-accounting-plugin", so its settings live in
	 * that folder. Read them once when this id has no settings yet.
	 */
	private async importFromOldId(): Promise<Partial<AccountingSettings> | null> {
		if (this.manifest.id === OLD_PLUGIN_ID) return null;
		const path = normalizePath(`${this.app.vault.configDir}/plugins/${OLD_PLUGIN_ID}/data.json`);
		try {
			if (!(await this.app.vault.adapter.exists(path))) return null;
			const parsed: unknown = JSON.parse(await this.app.vault.adapter.read(path));
			return parsed && typeof parsed === 'object' ? parsed : null;
		} catch (error) {
			console.error('AI Accounting: could not read settings of the old plugin id.', error);
			return null;
		}
	}

	/** Plain-text keys from before 0.5.0 (Gemini's included, now an entry in the list) move into Obsidian's secret storage; settings keep only the names. */
	private moveKeysToSecretStorage(): boolean {
		const storage = this.app.secretStorage;
		const s = this.settings;
		let moved = false;
		const store = (preferred: string, fallback: string, key: string): string => {
			const existing = storage.getSecret(preferred);
			const name = !existing || existing === key ? preferred : fallback;
			storage.setSecret(name, key);
			moved = true;
			return name;
		};
		for (const ep of s.apiEndpoints) {
			if (!ep.apiKey || ep.apiKeySecret) continue;
			const id = ep.provider === 'gemini' ? 'gemini-api-key' : `ai-accounting-endpoint-${ep.id.toLowerCase().replace(/[^a-z0-9-]/g, '')}`;
			ep.apiKeySecret = store(id, `ai-accounting-endpoint-${ep.id.toLowerCase().replace(/[^a-z0-9-]/g, '')}-2`, ep.apiKey);
			ep.apiKey = '';
		}
		return moved;
	}

	secret(name: string): string {
		return (name && this.app.secretStorage.getSecret(name)) || '';
	}

	async saveSettings() {
		await this.saveData(this.settings);
		// Refresh AI Service with new settings
		this.aiService = new AIService(this.settings, name => this.secret(name));
	}
}

/** A short stable id for an imported row, so the same statement line gets the same id. */
function statementRowId(row: TransactionData): string {
	let hash = 2166136261;
	for (const ch of `${row.date}|${row.description}|${row.amount}|${row.currency}`) hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619) >>> 0;
	return hash.toString(36);
}
