import { App, Notice, PluginSettingTab, Setting, SettingDefinitionItem, SettingGroupItem, SettingPage } from "obsidian";
import { RecurringExpense } from "./services/planning";
import type { LedgerNames } from "./services/ledgerFiles";
import type { TransactionData } from "./services/AIService";
import { aiLang, isLocalAgent } from "./ai/kit";
import type { AiSlot, ModelCacheData } from "./vendor/rex-ai-kit/index";
import { renderAiSettings } from "./vendor/rex-ai-kit/settingsUI";
import { tr } from "./i18n";
import { watchSettingGroups } from "./settingGroups";
import AccountingPlugin from "./main";

export interface UserProfile {
	id: string;
	name: string;
	folder: string; // Report folder
	inboxFolder?: string; // Dedicated processing folder
	color: string;
}

/** One AI service in the fallback list. The key stays in Obsidian's Keychain; only its name is stored. */
export interface AiService {
	id: string;
	/** Shown in the list and while waiting; empty uses the provider's name. */
	name: string;
	enabled: boolean;
	/** Whether the model reads images. Receipts in image form skip services that do not; programs on this computer never do. */
	vision: boolean;
	ai: AiSlot & { grantExpiry?: string };
}

/** What the AI read, kept until it is reviewed, so closing the dialog loses nothing. */
export interface PendingDraft {
	id: string;
	/** File name or label shown in the list. */
	source: string;
	/** Inbox file the draft came from; it is archived once the draft is entered. */
	sourcePath?: string;
	/** SHA-256 of the input; the same input reuses its draft instead of calling the AI again. */
	hash: string;
	userId: string;
	kind: 'image' | 'text' | 'recurring';
	archive: boolean;
	appendArchive: boolean;
	createdAt: string;
	rows: TransactionData[];
}

export interface AccountingSettings {
	baseCurrency: string;
	aiServices: AiService[];
	/** Model lists fetched by Check or Refresh, so opening the settings needs no request. */
	modelCache?: ModelCacheData;
	financeFolderPath: string; // Used as default/fallback
	magicFolderPath: string;
	archiveFolderPath: string;
	/** File name prefixes, fixed at first start so a later language change does not split the ledgers. */
	ledgerNames?: LedgerNames;
	defaultInputCurrency: string;
	// Multi-user
	users: UserProfile[];
	currentUser: string; // ID
	// Layout
	sidebarWidth: number;
	// Daily journal
	dailyJournalEnabled: boolean;
	dailyJournalFolderPath: string;
	dailyJournalFilePattern: string; // e.g. YYYY-MM-DD
	/** Added to the cssclasses of the ledgers and archive pages the plugin writes. Empty adds none. */
	noteCssClass: string;
	/** The period total on the dashboard in Didot italic: the plugin's one signature detail. */
	serifNumbers: boolean;
	// Planning
	/** One budget per line, "分类 金额", in the report currency. */
	budgetText: string;
	recurring: RecurringExpense[];
	drafts: PendingDraft[];
}

export const DEFAULT_SETTINGS: AccountingSettings = {
	baseCurrency: 'CNY',
	aiServices: [],
	financeFolderPath: 'Finances',
	magicFolderPath: 'Finances/Inbox',
	archiveFolderPath: 'Finances/Archive',
	defaultInputCurrency: 'CNY',
	users: [
		{ id: 'default', name: tr('Me', '我'), folder: 'Finances', color: '#36a2eb' }
	],
	currentUser: 'default',
	sidebarWidth: 400,
	dailyJournalEnabled: false,
	dailyJournalFolderPath: 'Daily',
	dailyJournalFilePattern: 'YYYY-MM-DD',
	noteCssClass: '',
	serifNumbers: true,
	budgetText: '',
	recurring: [],
	drafts: []
}

/** A new service starts on OpenAI's small model, which reads receipts well for a fraction of a cent. */
export function newService(): AiService {
	return { id: Date.now().toString(36), name: '', enabled: true, vision: true, ai: { provider: 'openai', model: 'gpt-6-luna' } };
}

/** Reads a value by a dotted path such as "recurring.0.amount". */
function readPath(root: unknown, path: string): unknown {
	return path.split('.').reduce<unknown>((value, part) => (value && typeof value === 'object' ? (value as Record<string, unknown>)[part] : undefined), root);
}

function writePath(root: object, path: string, value: unknown) {
	const parts = path.split('.');
	const last = parts.pop();
	const target = parts.reduce<unknown>((obj, part) => (obj && typeof obj === 'object' ? (obj as Record<string, unknown>)[part] : undefined), root);
	if (last && target && typeof target === 'object') (target as Record<string, unknown>)[last] = value;
}

const text = (value: unknown) => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '');

const KIT_CLS = 'ap ap-settings';
/** Marks each group's last row so the kit rounds its lower corners where Obsidian lays rows out flat under their headings. */
/** Sub-pages render outside the tab's container, so their groups carry the kit classes themselves. */
function kitPage<K extends string>(items: SettingDefinitionItem<K>[]): SettingDefinitionItem<K>[] {
	const out: SettingDefinitionItem<K>[] = [];
	let loose: SettingGroupItem<K>[] = [];
	const flush = () => {
		if (loose.length) out.push({ type: 'group', cls: KIT_CLS, items: loose });
		loose = [];
	};
	for (const item of items) {
		if ('type' in item && (item.type === 'group' || item.type === 'list')) {
			flush();
			out.push({ ...item, cls: [item.cls, KIT_CLS].filter(Boolean).join(' ') });
		} else {
			loose.push(item as SettingGroupItem<K>);
		}
	}
	flush();
	return out;
}

export class AccountingSettingTab extends PluginSettingTab {
	plugin: AccountingPlugin;
	constructor(app: App, plugin: AccountingPlugin) {
		super(app, plugin);
		this.plugin = plugin;
		this.containerEl.addClass('aa-settings', 'ap', 'ap-settings');
		plugin.register(() => this.hide());
	}

	private stopGroups: (() => void) | null = null;

	/** Marks group edges while the tab is open; started on every display, stopped on hide and unload. */
	private watchGroups(): void {
		if (this.stopGroups) return;
		this.stopGroups = watchSettingGroups(this.containerEl);
	}

	hide(): void {
		this.stopGroups?.();
		this.stopGroups = null;
		super.hide();
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		this.watchGroups();
		const s = this.plugin.settings;
		return [
			{ name: tr('Report currency', '报表币种'), desc: tr('Amounts in reports are converted to this currency; budgets use it too.', '报表金额统一换算为这个币种，预算也按它填写。'), control: { type: 'text', key: 'baseCurrency', placeholder: DEFAULT_SETTINGS.baseCurrency } },
			{ name: tr('Default input currency', '默认输入币种'), desc: tr('Used when an entry does not name a currency.', '录入时没有注明币种，就使用这个默认值。'), control: { type: 'text', key: 'defaultInputCurrency', placeholder: DEFAULT_SETTINGS.defaultInputCurrency } },
			{ name: tr('Receipt inbox', '票据收件箱'), desc: tr('Images, text and the images a note embeds are sent to your AI service right away, and to the next service if one fails. Leave empty to turn it off.', '放进来的图片、文本和笔记里嵌入的图片会立即发给 AI 服务，一个失败时还会发给下一个。留空即关闭。'), aliases: ['inbox'], control: { type: 'folder', key: 'magicFolderPath', placeholder: DEFAULT_SETTINGS.magicFolderPath } },
			{ name: tr('Archive folder', '处理后归档文件夹'), desc: tr('Inbox files move here once their draft is entered. Leave empty to move them to the trash.', '草稿入账后，把原文件移入此文件夹。留空则移到回收站。'), control: { type: 'folder', key: 'archiveFolderPath', placeholder: DEFAULT_SETTINGS.archiveFolderPath } },
			{ name: tr('Note CSS class', '笔记样式类'), desc: tr("Added to the cssclasses of each ledger and archive page so a CSS snippet in your vault can style it; the plugin ships no style for it. Leave empty to add none.", '写进每篇账本和归档页的 cssclasses，让库里的 CSS 片段给它换样子；插件本身不带这个样式。留空就不加。'), aliases: ['css', 'cssclasses'], control: { type: 'text', key: 'noteCssClass', placeholder: tr('For example ledger-note', '例如 ledger-note') } },
			{ name: tr('Serif numbers', '数字用衬线'), desc: tr('The total for the period in Didot italic; Georgia where Didot is not installed.', '期间支出的合计用 Didot 斜体；没装 Didot 的系统用 Georgia。'), aliases: ['font', 'Didot', '字体', '衬线'], control: { type: 'toggle', key: 'serifNumbers' } },
			{
				type: 'list',
				heading: tr('AI services', 'AI 服务'),
				emptyState: tr('No AI service yet. Add one to read receipts and notes; the ledger, charts and manual entry work without it. OpenAI, Anthropic and Gemini come first; DeepSeek, Qwen, Kimi, Zhipu, OpenRouter, SiliconFlow and local models are there too.', '还没有 AI 服务。加一个就能识别票据和笔记；账本、图表和手动记账不需要它。OpenAI、Anthropic、Gemini 排在最前，也有 DeepSeek、通义、Kimi、智谱、OpenRouter、硅基流动和本地模型。'),
				addItem: { name: tr('Add service', '添加服务'), action: () => {
					s.aiServices.push(newService());
					void this.saveAndUpdate();
				} },
				onReorder: (from, to) => {
					const [moved] = s.aiServices.splice(from, 1);
					if (moved) s.aiServices.splice(to, 0, moved);
					void this.saveAndUpdate();
				},
				onDelete: index => { s.aiServices.splice(index, 1); void this.saveAndUpdate(); },
				items: s.aiServices.map((svc, i) => ({
					type: 'page' as const,
					name: `${i + 1}. ${this.serviceName(svc)}`,
					desc: this.serviceSummary(svc),
					status: () => (svc.enabled && !this.plugin.ai.hasKey(svc.ai) ? 'warning' : null),
					page: () => new AiServicePage(this, svc)
				}))
			},
			{
				type: 'group',
				heading: tr('Monthly budget', '月度预算'),
				items: [
					{ name: tr('Budget', '预算'), desc: tr('One top-level category and amount per line, in the report currency; "总计" sets the whole month. The ledger shows how much is used: orange past 80%, red when over.', '每行一个一级分类和金额（报表币种），写“总计”设整月总预算。账本页会显示本月用了多少，超过 80% 变橙色，超出变红色。'), aliases: ['budget'], control: { type: 'textarea', key: 'budgetText', placeholder: '总计 150000\n餐饮 40000\n交通 12000' } }
				]
			},
			{
				type: 'list',
				heading: tr('Recurring expenses', '固定支出'),
				emptyState: tr('Rent, phone, subscriptions and other monthly costs. Run "Add this month\'s recurring expenses" or use the button on the ledger, review, and enter them at once; a month is never added twice.', '房租、话费、订阅等每月都有的支出。运行命令“添加本月固定支出”或在账本页点按钮，核对后一次入账；同一个月不会重复。'),
				addItem: { name: tr('Add recurring expense', '添加固定支出'), action: () => {
					s.recurring.push({ id: Date.now().toString(36), description: '', category: '', amount: 0, currency: s.defaultInputCurrency, paymentMethod: '', day: 1, enabled: true });
					void this.saveAndUpdate();
				} },
				onDelete: index => { s.recurring.splice(index, 1); void this.saveAndUpdate(); },
				items: s.recurring.map((item, i) => ({
					type: 'page' as const,
					name: item.description || tr(`Recurring expense ${i + 1}`, `固定支出 ${i + 1}`),
					desc: !item.enabled ? tr('Off', '已停用') : item.amount > 0 ? tr(`Day ${item.day} of each month · ${item.amount} ${item.currency}`, `每月 ${item.day} 日 · ${item.amount} ${item.currency}`) : tr('Takes effect once it has an amount', '填写金额后生效'),
					items: kitPage([
						{ name: tr('On', '启用'), control: { type: 'toggle', key: `recurring.${i}.enabled` } },
						{ name: tr('Description', '内容'), control: { type: 'text', key: `recurring.${i}.description`, placeholder: tr('Rent', '房租') } },
						{ name: tr('Category', '分类'), control: { type: 'text', key: `recurring.${i}.category`, placeholder: '居家生活 / 房租' } },
						{ name: tr('Amount', '金额'), control: { type: 'number', key: `recurring.${i}.amount`, min: 0, step: 'any' } },
						{ name: tr('Currency', '币种'), control: { type: 'text', key: `recurring.${i}.currency` } },
						{ name: tr('Day of month', '每月扣款日'), desc: tr('Short months use their last day.', '短月份按当月最后一天。'), control: { type: 'number', key: `recurring.${i}.day`, min: 1, max: 31, step: 1 } },
						{ name: tr('Payment method', '支付方式'), control: { type: 'text', key: `recurring.${i}.paymentMethod` } }
					])
				}))
			},
			{
				type: 'list',
				heading: tr('Members and ledgers', '成员与账本'),
				addItem: { name: tr('Add member', '添加成员'), action: () => {
					s.users.push({ id: Date.now().toString(), name: tr('New member', '新成员'), folder: `${s.financeFolderPath}/${tr('New member', '新成员')}`, color: '#ff9f40' });
					void this.saveAndUpdate();
				} },
				onDelete: index => {
					if (s.users.length <= 1) { new Notice(tr('Keep at least one member.', '至少要保留一位成员。')); return; }
					const [removed] = s.users.splice(index, 1);
					const first = s.users[0];
					if (removed && s.currentUser === removed.id && first) s.currentUser = first.id;
					void this.saveAndUpdate();
				},
				items: s.users.map((user, i) => ({
					type: 'page' as const,
					name: user.name || tr(`Member ${i + 1}`, `成员 ${i + 1}`),
					desc: [i === 0 ? tr('Default member', '默认成员') : '', user.folder].filter(Boolean).join(' · '),
					items: kitPage([
						{ name: tr('Name', '名字'), control: { type: 'text', key: `users.${i}.name` } },
						{ name: tr('Colour', '颜色'), control: { type: 'color', key: `users.${i}.color` } },
						{ name: tr('Ledger folder', '账本文件夹'), control: { type: 'folder', key: `users.${i}.folder` } },
						{ name: tr('Own inbox', '专用收件箱'), desc: tr('Files put here, with the images a note embeds, are sent to your AI service right away and recorded under this member.', '放进来的文件连同笔记里嵌入的图片会立即发给 AI 服务，记在这位成员名下。'), control: { type: 'folder', key: `users.${i}.inboxFolder` } }
					])
				}))
			},
			{
				type: 'group',
				heading: tr('Daily notes', '日记同步'),
				items: [
					{ name: tr('Copy to daily notes', '同步到日记'), desc: tr('Appends each day\'s entries to that day\'s note.', '把当天的交易记录追加到对应日记。'), control: { type: 'toggle', key: 'dailyJournalEnabled' } },
					{ name: tr('Daily notes folder', '日记文件夹'), control: { type: 'folder', key: 'dailyJournalFolderPath' } },
					{ name: tr('File name format', '日记文件名格式'), desc: tr('The same date format as your daily notes plugin.', '和日记插件的日期格式一致，例如年月日中间用短横线。'), control: { type: 'text', key: 'dailyJournalFilePattern', placeholder: DEFAULT_SETTINGS.dailyJournalFilePattern } }
				]
			}
		];
	}

	getControlValue(key: string): unknown {
		return readPath(this.plugin.settings, key);
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		const s = this.plugin.settings;
		const field = key.split('.').pop() ?? key;
		let next: unknown = value;
		if (field === 'baseCurrency' || field === 'defaultInputCurrency' || field === 'currency') next = text(value).trim().toUpperCase();
		else if (field === 'amount') next = Math.max(0, Number(value) || 0);
		else if (field === 'day') next = Math.min(31, Math.max(1, Math.floor(Number(value)) || 1));
		else if (typeof value === 'string' && field !== 'budgetText' && field !== 'name') next = value.trim();
		writePath(s, key, next);
		await this.plugin.saveSettings();
		if (field === 'budgetText' || field === 'serifNumbers') this.plugin.refreshDashboards();
		// Names and summaries show on list entries.
		if (['name', 'description', 'amount', 'day', 'currency', 'enabled', 'folder'].includes(field)) this.update();
	}

	private async saveAndUpdate() {
		await this.plugin.saveSettings();
		this.update();
	}

	serviceName(svc: AiService): string {
		return svc.name || this.plugin.ai.provider(svc.ai).name;
	}

	private serviceSummary(svc: AiService): string {
		if (!svc.enabled) return tr('Off', '已停用');
		const reads = isLocalAgent(svc.ai.provider) ? tr('text only, never receipts in images', '只读文字，不识图片票据') : svc.vision ? tr('reads images', '能识图') : tr('text only', '只读文字');
		const noKey = this.plugin.ai.hasKey(svc.ai) ? '' : tr('no key selected', '还没选密钥');
		return [noKey, svc.name ? this.plugin.ai.provider(svc.ai).name : '', svc.ai.model, reads].filter(Boolean).join(' · ');
	}

	/** Saves a service changed on its own page and refreshes the list entry. */
	async saveService(): Promise<void> {
		await this.saveAndUpdate();
	}
}

/**
 * One service's page: the shared "AI service" group (provider, Keychain key with Check, model list),
 * then this plugin's own rows. Nothing is requested until the user presses Check or Refresh.
 */
class AiServicePage extends SettingPage {
	private ui: { destroy(): void } | null = null;
	private stopGroups: (() => void) | null = null;

	constructor(private tab: AccountingSettingTab, private svc: AiService) {
		super();
		this.title = tab.serviceName(svc);
	}

	display(): void {
		const el = this.containerEl;
		this.ui?.destroy();
		el.empty();
		el.addClass('aa-settings', 'ap', 'ap-settings');
		const svc = this.svc;
		const local = isLocalAgent(svc.ai.provider);
		this.ui = renderAiSettings(el, {
			app: this.tab.app,
			client: this.tab.plugin.ai,
			slot: svc.ai,
			scene: 'cheap',
			lang: aiLang(),
			// Claude Code and Codex read text only: they can file statement rows, never read a receipt photo.
			allowLocalAgents: true,
			onChange: async slot => {
				const wasLocal = isLocalAgent(svc.ai.provider);
				svc.ai = slot;
				if (isLocalAgent(slot.provider)) svc.vision = false;
				else if (wasLocal) svc.vision = true;
				await this.tab.saveService();
				if (wasLocal !== isLocalAgent(slot.provider)) this.display();
			}
		});
		new Setting(el).setName(tr('This service', '这个服务')).setHeading();
		new Setting(el)
			.setName(tr('On', '启用'))
			.setDesc(tr('When one service fails, the same receipt goes to the next one on.', '一个服务失败时，同一张票据会发给下一个启用的服务。'))
			.addToggle(t => t.setValue(svc.enabled).onChange(async v => { svc.enabled = v; await this.tab.saveService(); }));
		if (local) {
			new Setting(el)
				.setName(tr('Reads images', '能识图'))
				.setDesc(tr('Programs on this computer read text only. They file statement rows; receipt photos go to the next service.', '本机程序只读文字：可以给账单分类，图片票据会交给下一个服务。'));
		} else {
			new Setting(el)
				.setName(tr('Reads images', '能识图'))
				.setDesc(tr('Turn off for a model that does not accept pictures. Image receipts skip services that cannot read them.', '模型不收图片时关掉。图片票据会跳过不能识图的服务。'))
				.addToggle(t => t.setValue(svc.vision).onChange(async v => { svc.vision = v; await this.tab.saveService(); }));
		}
		new Setting(el)
			.setName(tr('Name', '名称'))
			.setDesc(tr('Shown in the list and while waiting. Leave empty to use the provider’s name.', '显示在列表和等待提示里。留空就用服务商名。'))
			.addText(t => t.setPlaceholder(this.tab.plugin.ai.provider(svc.ai).name).setValue(svc.name).onChange(async v => { svc.name = v.trim(); await this.tab.saveService(); }));
		this.stopGroups?.();
		this.stopGroups = watchSettingGroups(el);
	}

	hide(): void {
		this.ui?.destroy();
		this.ui = null;
		this.stopGroups?.();
		this.stopGroups = null;
		super.hide();
	}
}
