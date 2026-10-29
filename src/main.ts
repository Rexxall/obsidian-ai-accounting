import { Notice, Plugin, TFile, TFolder, TAbstractFile, arrayBufferToBase64, WorkspaceLeaf, normalizePath } from 'obsidian';
import { DEFAULT_SETTINGS, AccountingSettings, AccountingSettingTab } from "./settings";
import { FXService } from "./services/FXService";
import { AIService } from "./services/AIService";
import { DataService } from "./services/DataService";
import { DashboardView, VIEW_TYPE_DASHBOARD } from "./DashboardView";

import { ReviewImportModal } from "./modals/ReviewImportModal";
import { migrateSettings } from './services/migrate';
import { recurringDrafts } from "./services/planning";
import { TransactionRecord } from "./services/DataService";
import { TransactionData, failureMessage } from "./services/AIService";
import { ReviewSource } from "./modals/ReviewImportModal";
import { PendingDraft } from "./settings";
import { TaskProgress } from "./ai/progress";
import { AiError } from "./ai/providers";
import { tr } from "./i18n";

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

				const files = folder.children.filter(f =>
					f instanceof TFile &&
					f.extension === 'md' &&
					/^\d{4}-\d{2}$/.test(f.basename)
				) as TFile[];

				new Notice(tr(`Updating charts in ${files.length} monthly reports…`, `正在更新 ${files.length} 份月报的图表…`));

				for (const file of files) {
					await this.dataService.updateMonthlyFileVisuals(file);
				}

				new Notice(tr('Charts updated in every monthly report.', '月报图表已全部更新。'));
			}
		});

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

	/**
	 * Write reviewed rows to the monthly ledgers (and daily notes when enabled).
	 * Each row keeps a stable ID, so writing the same rows again adds nothing.
	 */
	async saveTransactions(rows: TransactionData[], userId: string, idFor: (row: TransactionData, index: number) => string): Promise<string[]> {
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
			await this.saveTransactions(reviewed, userId, row => row.id || '');
		} catch (error) {
			// Nothing is written when a rate is missing: every row is converted before the first write.
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
		const isImage = ['jpg', 'jpeg', 'png', 'webp'].includes(ext);
		if (!isImage && !['md', 'txt'].includes(ext)) return;
		this.processingFiles.add(processingPath);
		try {
			const content = isImage ? arrayBufferToBase64(await this.app.vault.readBinary(file)) : await this.app.vault.read(file);
			const hash = await sha256(content);
			// The same receipt reuses its draft instead of being sent to the AI again.
			let draft = this.settings.drafts.find(d => d.hash === hash);
			if (!draft) {
				const userId = this.determineUserForFile(file, isImage ? '' : content);
				const rows = await this.recognize(file.name, content, isImage, ext === 'jpg' ? 'image/jpeg' : `image/${ext}`,
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

	/** Sends the input to the AI with a progress notice. Null when cancelled or failed (the notice offers Retry). */
	private async recognize(name: string, content: string, isImage: boolean, mimeType: string, retry: () => void): Promise<TransactionData[] | null> {
		const progress = new TaskProgress(tr(`Reading ${name}`, `识别 ${name}`), 'aa');
		progress.step(tr('Preparing…', '准备中…'), 1, 3);
		try {
			const rows = await this.aiService.processInput(content, isImage, mimeType, {
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
		else if (file) preview = { text: (await this.app.vault.read(file)).slice(0, 1200) };
		const result = await new ReviewImportModal(this.app, draft.rows, userName, draft.source, preview, tr('AI draft', 'AI 草稿'), {
			duplicates: await this.findDuplicates(draft.rows),
			onDiscard: async () => { await this.discardDraft(draft.id); new Notice(tr('Draft discarded. The original file is kept.', '已丢弃草稿，原始文件保留。')); },
			onKeep: async rows => { draft.rows = rows; await this.saveSettings(); }
		}).review();
		if (!result) return;
		let months: string[];
		try {
			months = await this.saveTransactions(result, draft.userId, (_row, index) => `${draft.hash.slice(0, 32)}-${index}`);
		} catch (error) {
			// Nothing is written when a rate is missing: every row is converted before the first write.
			new Notice(`${(error as Error).message} ${tr('The draft is kept.', '草稿已保留。')}`, 8000);
			return;
		}
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

	private async appendContentToArchiveMonthly(months: string[], sourceFile: TFile, rawContent: string) {
		if (!this.settings.archiveFolderPath) return;
		const folderPath = this.settings.archiveFolderPath;
		if (!this.app.vault.getAbstractFileByPath(folderPath)) {
			await this.app.vault.createFolder(folderPath);
		}
		for (const m of months) {
			const filePath = `${folderPath}/${m}.md`;
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
		if (imported || movedKeys || legacyShape) await this.saveData(this.settings);
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
