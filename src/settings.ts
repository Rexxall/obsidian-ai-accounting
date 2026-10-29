import { App, Notice, PluginSettingTab, Setting, SettingDefinitionItem } from "obsidian";
import { RecurringExpense } from "./services/planning";
import type { TransactionData } from "./services/AIService";
import { DEFAULT_PROVIDER, ProviderId, TEST_COST_NOTE, presetFor, presets, listModels, testConnection, describeFailure, AiError } from "./ai/providers";
import { tr } from "./i18n";
import AccountingPlugin from "./main";

export interface UserProfile {
	id: string;
	name: string;
	folder: string; // Report folder
	inboxFolder?: string; // Dedicated processing folder
	color: string;
}

/** One AI service. Gemini uses its own API; every other service speaks the OpenAI chat format. */
export interface ApiEndpoint {
	id: string;
	name: string;
	provider: ProviderId;
	endpoint: string;
	/** Before 0.5.0 the key was stored here; migrated into secret storage on load. */
	apiKey: string;
	/** Name of the secret in Obsidian's secret storage. */
	apiKeySecret?: string;
	model: string;
	enabled: boolean;
	/** Whether the model reads images. Receipts in image form skip services that do not. */
	vision: boolean;
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
	apiEndpoints: ApiEndpoint[];
	financeFolderPath: string; // Used as default/fallback
	magicFolderPath: string;
	archiveFolderPath: string;
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
	// Planning
	/** One budget per line, "分类 金额", in the report currency. */
	budgetText: string;
	recurring: RecurringExpense[];
	drafts: PendingDraft[];
}

export const DEFAULT_SETTINGS: AccountingSettings = {
	baseCurrency: 'CNY',
	apiEndpoints: [],
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
	budgetText: '',
	recurring: [],
	drafts: []
}

export function newEndpoint(provider: ProviderId = DEFAULT_PROVIDER): ApiEndpoint {
	const preset = presetFor(provider);
	return { id: Date.now().toString(36), name: preset.name, provider, endpoint: preset.baseUrl, apiKey: '', model: preset.model, enabled: true, vision: preset.vision };
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

export class AccountingSettingTab extends PluginSettingTab {
	plugin: AccountingPlugin;
	/** Model lists fetched in this session, by entry id. */
	private modelLists = new Map<string, string[]>();

	constructor(app: App, plugin: AccountingPlugin) {
		super(app, plugin);
		this.plugin = plugin;
		this.containerEl.addClass('aa-settings', 'ap', 'ap-settings');
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		const s = this.plugin.settings;
		const providerOptions = Object.fromEntries(presets().map(p => [p.id, p.name]));
		return [
			{ name: tr('Report currency', '报表币种'), desc: tr('Amounts in reports are converted to this currency; budgets use it too.', '报表金额统一换算为这个币种，预算也按它填写。'), control: { type: 'text', key: 'baseCurrency', placeholder: DEFAULT_SETTINGS.baseCurrency } },
			{ name: tr('Default input currency', '默认输入币种'), desc: tr('Used when an entry does not name a currency.', '录入时没有注明币种，就使用这个默认值。'), control: { type: 'text', key: 'defaultInputCurrency', placeholder: DEFAULT_SETTINGS.defaultInputCurrency } },
			{ name: tr('Receipt inbox', '票据收件箱'), desc: tr('Images and text put in this folder are sent to your AI service right away; the result waits as a draft until you review it. With several services, a failed one hands over to the next, so one receipt may reach more than one service. Leave empty to turn it off.', '放进这个文件夹的图片和文本会立即发给 AI 服务识别，结果先存成草稿，核对后才入账；配了多个服务时，一个失败就换下一个，同一张票据可能发给几家服务。留空即关闭。'), aliases: ['inbox'], control: { type: 'folder', key: 'magicFolderPath', placeholder: DEFAULT_SETTINGS.magicFolderPath } },
			{ name: tr('Archive folder', '处理后归档文件夹'), desc: tr('Inbox files move here once their draft is entered. Leave empty to move them to the trash.', '草稿入账后，把原文件移入此文件夹。留空则移到回收站。'), control: { type: 'folder', key: 'archiveFolderPath', placeholder: DEFAULT_SETTINGS.archiveFolderPath } },
			{
				type: 'list',
				heading: tr('AI services', 'AI 服务'),
				emptyState: tr('No AI service yet. Add one to read receipts and notes; the ledger, charts and manual entry work without it. DeepSeek is the default; Qwen, SiliconFlow, Kimi, Zhipu, Gemini, OpenAI and local models are also available.', '还没有 AI 服务。加一个就能识别票据和笔记；账本、图表和手动记账不需要它。默认 DeepSeek，也可以选通义、硅基流动、Kimi、智谱、Gemini、OpenAI 或本地模型。'),
				addItem: { name: tr('Add service', '添加服务'), action: () => {
					s.apiEndpoints.push(newEndpoint());
					void this.saveAndUpdate();
				} },
				onReorder: (from, to) => {
					const [moved] = s.apiEndpoints.splice(from, 1);
					if (moved) s.apiEndpoints.splice(to, 0, moved);
					void this.saveAndUpdate();
				},
				onDelete: index => { s.apiEndpoints.splice(index, 1); void this.saveAndUpdate(); },
				items: s.apiEndpoints.map((ep, i) => ({
					type: 'page' as const,
					name: `${i + 1}. ${ep.name || presetFor(ep.provider).name}`,
					desc: !ep.enabled ? tr('Off', '已停用') : [ep.model, ep.vision ? tr('reads images', '能识图') : tr('text only', '只读文字')].filter(Boolean).join(' · '),
					items: [
						{ name: tr('On', '启用'), desc: tr('Services are tried top to bottom; a failed one hands over to the next.', '从上到下依次尝试，前一个失败就换下一个。'), control: { type: 'toggle', key: `apiEndpoints.${i}.enabled` } },
						{ name: tr('Service', '服务商'), desc: tr('Choosing a service fills in its address and a suggested model.', '选好服务商会自动填上地址和推荐模型。'), control: { type: 'dropdown', key: `apiEndpoints.${i}.provider`, options: providerOptions } },
						{ name: tr('Address', '接口地址'), desc: tr('Change it only for a proxy, another region or a local server.', '只有用代理、其他地区或本地服务时才需要改。'), control: { type: 'text', key: `apiEndpoints.${i}.endpoint`, placeholder: presetFor(ep.provider).baseUrl } },
						{ name: tr('Model', '模型'), desc: tr('Type a model name, or fetch the list below.', '直接填模型名，或在下面取模型列表。'), control: { type: 'text', key: `apiEndpoints.${i}.model`, placeholder: presetFor(ep.provider).model } },
						{ name: tr('Model list', '模型列表'), desc: tr('Asks the service which models this key can use. Free.', '向服务商查询这个密钥能用的模型，不收费。'), render: (setting: Setting) => this.renderModelList(setting, ep, i) },
						{ name: tr('Reads images', '能识图'), desc: tr('Turn on only if the model accepts pictures. Image receipts skip services that cannot read them.', '模型支持图片时才打开。图片票据会跳过不能识图的服务。'), control: { type: 'toggle', key: `apiEndpoints.${i}.vision` } },
						{ name: tr('API key', 'API 密钥'), desc: this.keyDesc(ep), control: { type: 'secret', key: `apiEndpoints.${i}.apiKeySecret` } },
						{ name: tr('Test connection', '测试连接'), desc: TEST_COST_NOTE(), render: (setting: Setting) => this.renderTest(setting, ep) }
					]
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
					items: [
						{ name: tr('On', '启用'), control: { type: 'toggle', key: `recurring.${i}.enabled` } },
						{ name: tr('Description', '内容'), control: { type: 'text', key: `recurring.${i}.description`, placeholder: tr('Rent', '房租') } },
						{ name: tr('Category', '分类'), control: { type: 'text', key: `recurring.${i}.category`, placeholder: '居家生活 / 房租' } },
						{ name: tr('Amount', '金额'), control: { type: 'number', key: `recurring.${i}.amount`, min: 0, step: 'any' } },
						{ name: tr('Currency', '币种'), control: { type: 'text', key: `recurring.${i}.currency` } },
						{ name: tr('Day of month', '每月扣款日'), desc: tr('Short months use their last day.', '短月份按当月最后一天。'), control: { type: 'number', key: `recurring.${i}.day`, min: 1, max: 31, step: 1 } },
						{ name: tr('Payment method', '支付方式'), control: { type: 'text', key: `recurring.${i}.paymentMethod` } }
					]
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
					items: [
						{ name: tr('Name', '名字'), control: { type: 'text', key: `users.${i}.name` } },
						{ name: tr('Colour', '颜色'), control: { type: 'color', key: `users.${i}.color` } },
						{ name: tr('Ledger folder', '账本文件夹'), control: { type: 'folder', key: `users.${i}.folder` } },
						{ name: tr('Own inbox', '专用收件箱'), desc: tr('Optional. Files put here are also sent to the AI service right away, and recorded under this member.', '可不填。放进这里的文件同样会立即发给 AI 服务，并记到这位成员名下。'), control: { type: 'folder', key: `users.${i}.inboxFolder` } }
					]
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
		if (field === 'provider') {
			// A new service brings its own address, model and image support.
			const ep = readPath(s, key.slice(0, key.lastIndexOf('.'))) as ApiEndpoint | undefined;
			const preset = presetFor(text(value));
			if (ep) {
				const oldName = presetFor(ep.provider).name;
				Object.assign(ep, { endpoint: preset.baseUrl, model: preset.model, vision: preset.vision });
				if (!ep.name || ep.name === oldName) ep.name = preset.name;
				this.modelLists.delete(ep.id);
			}
			next = preset.id;
		}
		writePath(s, key, next);
		await this.plugin.saveSettings();
		if (field === 'budgetText') this.plugin.refreshDashboards();
		// Names and summaries show on list entries.
		if (['provider', 'name', 'description', 'amount', 'day', 'currency', 'enabled', 'model', 'folder', 'endpoint', 'vision', 'apiKeySecret'].includes(field)) this.update();
	}

	private async saveAndUpdate() {
		await this.plugin.saveSettings();
		this.update();
	}

	private keyDesc(ep: ApiEndpoint): DocumentFragment {
		const preset = presetFor(ep.provider);
		const frag = new DocumentFragment();
		frag.appendText(tr('Stored in Obsidian\'s secret storage on this device, not in the plugin\'s settings file, so it does not sync; enter it again on each device. ', '存在本机 Obsidian 的密钥库里，不在插件设置文件中，所以不会随库同步，换设备要重新选一次。'));
		if (preset.keyOptional) frag.appendText(tr('Local servers may not need one.', '本地服务可以不填。'));
		else if (preset.keyUrl) frag.createEl('a', { text: tr(`Get a ${preset.name} key`, `获取 ${preset.name} 密钥`), href: preset.keyUrl });
		return frag;
	}

	private target(ep: ApiEndpoint) {
		return { provider: ep.provider, baseUrl: ep.endpoint || presetFor(ep.provider).baseUrl, model: ep.model, apiKey: this.plugin.secret(ep.apiKeySecret || '') };
	}

	private renderModelList(setting: Setting, ep: ApiEndpoint, index: number) {
		const models = this.modelLists.get(ep.id);
		if (models?.length) {
			setting.addDropdown(dropdown => {
				const options: Record<string, string> = { '': tr('Choose a model…', '选择模型…') };
				for (const m of models) options[m] = m;
				dropdown.addOptions(options).setValue(models.includes(ep.model) ? ep.model : '').onChange(value => {
					if (value) void this.setControlValue(`apiEndpoints.${index}.model`, value);
				});
			});
		}
		setting.addButton(button => button.setButtonText(models ? tr('Fetch again', '重新获取') : tr('Fetch list', '获取列表')).onClick(async () => {
			button.setDisabled(true);
			setting.setDesc(tr('Asking the service…', '正在查询…'));
			try {
				const list = await listModels(this.target(ep));
				this.modelLists.set(ep.id, list);
				this.update();
			} catch (error) {
				setting.setDesc(error instanceof AiError ? error.message : describeFailure('network'));
				button.setDisabled(false);
			}
		}));
	}

	private renderTest(setting: Setting, ep: ApiEndpoint) {
		let diagnostics = '';
		let copyEl: HTMLElement | undefined;
		setting.addButton(button => button.setButtonText(tr('Test', '测试')).onClick(async () => {
			button.setDisabled(true);
			setting.setDesc(tr('Testing…', '测试中…'));
			const result = await testConnection(this.target(ep), `${this.plugin.manifest.name} ${this.plugin.manifest.version}`);
			diagnostics = result.diagnostics;
			setting.setDesc(result.message);
			setting.descEl.toggleClass('mod-warning', !result.ok);
			if (result.models?.length) this.modelLists.set(ep.id, result.models);
			copyEl?.toggle(true);
			button.setDisabled(false);
		}));
		setting.addExtraButton(extra => {
			copyEl = extra.extraSettingsEl;
			extra.setIcon('copy').setTooltip(tr('Copy diagnostics (no key, no ledger content)', '复制诊断信息（不含密钥和账目）')).onClick(() => {
				void navigator.clipboard.writeText(diagnostics).then(() => new Notice(tr('Diagnostics copied. They contain no key and no ledger content.', '诊断信息已复制，不含密钥和账目内容。')));
			});
		});
		copyEl?.toggle(false);
	}
}
