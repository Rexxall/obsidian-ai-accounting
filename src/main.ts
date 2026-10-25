import { Notice, Plugin, TFile, TFolder, TAbstractFile, arrayBufferToBase64, WorkspaceLeaf } from 'obsidian';
import { DEFAULT_SETTINGS, AccountingSettings, AccountingSettingTab } from "./settings";
import { FXService } from "./services/FXService";
import { AIService } from "./services/AIService";
import { DataService } from "./services/DataService";
import { DashboardView, VIEW_TYPE_DASHBOARD } from "./DashboardView";

import { ReviewImportModal } from "./modals/ReviewImportModal";

export default class AccountingPlugin extends Plugin {
	private processingFiles = new Set<string>();
	settings: AccountingSettings;
	fxService: FXService;
	aiService: AIService;
	dataService: DataService;

	async onload() {
		await this.loadSettings();

		this.fxService = new FXService(this.app, this.manifest.dir!);
		this.aiService = new AIService(this.settings);
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
			name: 'Scan Magic Inbox Now',
			callback: () => this.scanInbox()
		});

		this.addCommand({
			id: 'open-accounting-dashboard',
			name: 'Open Financial Dashboard',
			callback: () => this.activateView()
		});

		this.addCommand({
			id: 'process-current-note',
			name: 'Process Current Note for Bookkeeping',
			callback: () => this.processCurrentNote()
		});

		this.addCommand({
			id: 'open-dashboard-new-pane',
			name: 'Open Financial Dashboard in New Pane',
			callback: () => this.openNewDashboard()
		});

		this.addCommand({
			id: 'regenerate-all-visuals',
			name: 'Regenerate All Monthly Report Visuals',
			callback: async () => {
				const folder = this.app.vault.getAbstractFileByPath(this.settings.financeFolderPath);
				if (!(folder instanceof TFolder)) {
					new Notice('Finance folder not found');
					return;
				}

				const files = folder.children.filter(f =>
					f instanceof TFile &&
					f.extension === 'md' &&
					/^\d{4}-\d{2}$/.test(f.basename)
				) as TFile[];

				new Notice(`🔄 Regenerating visuals for ${files.length} reports...`);

				for (const file of files) {
					await this.dataService.updateMonthlyFileVisuals(file);
				}

				new Notice('✅ All monthly report visuals regenerated!');
			}
		});

		this.addCommand({
			id: 'sync-historical-to-daily-journal',
			name: 'Sync Historical Transactions to Daily Journal',
			callback: async () => {
				await this.syncHistoricalToDailyJournal();
			}
		});

		this.registerEvent(
			this.app.workspace.on('editor-menu', (menu, editor, view) => {
				menu.addItem((item) => {
					item
						.setTitle('Process for Bookkeeping')
						.setIcon('coins')
						.onClick(async () => {
							await this.processCurrentNote();
						});
				});
			})
		);

		this.addSettingTab(new AccountingSettingTab(this.app, this));

		this.addRibbonIcon('pie-chart', 'Accounting Dashboard', () => {
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

	private async syncHistoricalToDailyJournal() {
		if (!this.settings.dailyJournalEnabled) {
			new Notice('Daily Journal Append is disabled');
			return;
		}
		const notice = new Notice('开始同步历史账目到日记...', 0);
		const stats = await this.dataService.getAllData();
		const dailyMap: Record<string, any[]> = {};
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
		new Notice(`同步完成，共处理 ${total} 条交易，涉及 ${dates.length} 天。`);
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
			const files = (folder as any).children || [];
			for (const file of files) {
				if (file instanceof TFile) {
					await this.processMagicFile(file);
				}
			}
			new Notice('Scan complete.');
		} else {
			new Notice(`Magic Inbox folder not found: ${this.settings.magicFolderPath}`);
		}
	}

	async processCurrentNote() {
		const file = this.app.workspace.getActiveFile();
		if (file) {
			await this.processMagicFile(file, false, true);
		} else {
			new Notice('No active note found.');
		}
	}

	async processMagicFile(file: TFile, shouldArchive: boolean = true, appendToArchiveMonthly: boolean = false) {
		const processingPath = file.path;
		if (this.processingFiles.has(processingPath)) return;
		this.processingFiles.add(processingPath);
		const processingNotice = new Notice(`Processing: ${file.name}`, 0); // Persistent during processing

		try {
			let content: string;
			let isImage = false;

			if (['jpg', 'jpeg', 'png', 'webp'].includes(file.extension.toLowerCase())) {
				const buffer = await this.app.vault.readBinary(file);
				content = arrayBufferToBase64(buffer);
				isImage = true;
			} else if (['md', 'txt'].includes(file.extension.toLowerCase())) {
				content = await this.app.vault.read(file);
			} else {
				processingNotice.hide();
				return; // Unsupported file type
			}

			// Identify Target User Early for Notification
			const userId = this.determineUserForFile(file, isImage ? '' : content);
			const targetUser = this.settings.users.find(u => u.id === userId);
			const userName = targetUser ? targetUser.name : '未知用户';
			processingNotice.setMessage(`正在处理 [${userName}] 的账单: ${file.name}`);

			const extracted = await this.aiService.processInput(content, isImage);
            if (!extracted.length) { processingNotice.hide(); return; }
            processingNotice.hide();
            const dataArray = await new ReviewImportModal(this.app, extracted, userName, file.name,
                isImage ? { imageSrc: this.app.vault.getResourcePath(file) } : { text: content.slice(0, 1200) },
                !!this.settings.paperStyle).review();
            if (!dataArray) return;
            const sourceHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content))), byte => byte.toString(16).padStart(2, '0')).join('');
			if (dataArray && dataArray.length > 0) {
				// Group by month to avoid multiple file writes for the same report
				const batches: Record<string, any[]> = {};
				const dailyMap: Record<string, any[]> = {};

				for (const [index, data] of dataArray.entries()) {
                    const yearMonth = data.date.slice(0, 7);
                    const dateStr = data.date;
                    const id = `${sourceHash}-${index}`;

					if (!batches[yearMonth]) batches[yearMonth] = [];
					if (!dailyMap[dateStr]) dailyMap[dateStr] = [];

					const baseAmount = await this.fxService.convert(data.amount, data.currency, this.settings.baseCurrency, data.date);
					const rate = await this.fxService.getExchangeRate(data.currency, this.settings.baseCurrency, data.date);

					const batch = batches[yearMonth];
					if (batch) {
						batch.push({ ...data, id, baseAmount, rate });
					}
					const daily = dailyMap[dateStr];
					if (daily) {
						daily.push({ ...data, id, baseAmount, rate });
					}
				}

				// Process each month batch (按月份降序处理)
				const months = Object.keys(batches).sort((a, b) => b.localeCompare(a));
				for (const month of months) {
					const txs = batches[month] || [];
					await this.dataService.appendBatchToMonthlyReport(month, txs, userId);
				}
				if (this.settings.dailyJournalEnabled) {
					const dates = Object.keys(dailyMap).sort((a, b) => a.localeCompare(b));
					for (const d of dates) {
						const txs = dailyMap[d] || [];
						await this.dataService.appendToDailyNote(d, txs, userId);
					}
				}

				processingNotice.hide(); // Success: hide processing notice
				new Notice(`成功处理 [${userName}] 的 ${dataArray.length} 笔交易。`);
				this.refreshDashboards();

				if (shouldArchive) {
					await this.archiveFile(file);
				}
				if (appendToArchiveMonthly && !isImage) {
					await this.appendContentToArchiveMonthly(months.length > 0 ? months : [this.getCurrentYearMonth()], file, content);
				}
			} else {
				processingNotice.hide();
				new Notice(`No transactions found in: ${file.name}`);
			}
		} catch (error) {
			processingNotice.hide();
			console.error('Accounting Processor Error:', error);
			new Notice(`处理未完成：${(error as Error).message}。原始文件已保留。`, 8000);
		} finally {
            this.processingFiles.delete(processingPath);
            processingNotice.hide();
        }
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
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<AccountingSettings>);
		// Gemini 1.5 models were retired; move the old default to the current one.
		if (this.settings.geminiModel === 'gemini-1.5-flash') this.settings.geminiModel = DEFAULT_SETTINGS.geminiModel;
	}

	async saveSettings() {
		await this.saveData(this.settings);
		// Refresh AI Service with new settings
		this.aiService = new AIService(this.settings);
	}
}
