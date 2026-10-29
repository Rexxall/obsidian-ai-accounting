import { App, Notice, PluginSettingTab, Setting, SettingDefinitionItem, requestUrl } from "obsidian";
import { RecurringExpense } from "./services/planning";
import AccountingPlugin from "./main";

export interface UserProfile {
	id: string;
	name: string;
	folder: string; // Report folder
	inboxFolder?: string; // Dedicated processing folder
	color: string;
}

/** 单个 OpenAI 兼容 API Endpoint 配置 */
export interface ApiEndpoint {
	id: string;
	name: string;        // 显示名称，如 "OpenAI", "本地 Ollama"
	endpoint: string;    // 如 https://api.openai.com/v1
	/** Before 0.5.0 the key was stored here; migrated into secret storage on load. */
	apiKey: string;
	/** Name of the secret in Obsidian's secret storage. */
	apiKeySecret?: string;
	model: string;
	enabled: boolean;    // 是否启用（可快速禁用某个）
}

export interface AccountingSettings {
	baseCurrency: string;
	aiProvider: 'gemini' | 'openai';
	/** Name of the secret in Obsidian's secret storage that holds the Gemini key. */
	geminiSecretName: string;
	// Before 0.5.0; migrated into secret storage on load.
	geminiApiKey: string;
	geminiModel: string;
	// 旧字段保留以兼容迁移
	openaiApiKey: string;
	openaiModel: string;
	openaiEndpoint: string;
	// 新多 endpoint 列表（openai 兼容模式使用此列表）
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
}

export const DEFAULT_SETTINGS: AccountingSettings = {
	baseCurrency: 'CNY',
	aiProvider: 'gemini',
	geminiSecretName: '',
	geminiApiKey: '',
	geminiModel: 'gemini-2.5-flash',
	openaiApiKey: '',
	openaiModel: 'gpt-4o',
	openaiEndpoint: 'https://api.openai.com/v1',
	apiEndpoints: [],
	financeFolderPath: 'Finances',
	magicFolderPath: 'Finances/Inbox',
	archiveFolderPath: 'Finances/Archive',
	defaultInputCurrency: 'CNY',
	users: [
		{ id: 'default', name: '我', folder: 'Finances', color: '#36a2eb' }
	],
	currentUser: 'default',
	sidebarWidth: 400,
	dailyJournalEnabled: false,
	dailyJournalFolderPath: 'Daily',
	dailyJournalFilePattern: 'YYYY-MM-DD',
	budgetText: '',
	recurring: []
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

	constructor(app: App, plugin: AccountingPlugin) {
		super(app, plugin);
		this.plugin = plugin;
		this.containerEl.addClass('aa-settings', 'ap', 'ap-settings');
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		const s = this.plugin.settings;
		return [
			{ name: '报表币种', desc: '报表金额统一换算为这个币种，预算也按它填写。', control: { type: 'text', key: 'baseCurrency', placeholder: DEFAULT_SETTINGS.baseCurrency } },
			{ name: '默认输入币种', desc: '录入时没有注明币种，就使用这个默认值。', control: { type: 'text', key: 'defaultInputCurrency', placeholder: DEFAULT_SETTINGS.defaultInputCurrency } },
			{ name: '票据收件箱', desc: '放进这个文件夹的图片和文本会立即发给 AI 服务识别，核对后入账；配了多个服务时，一个失败就换下一个，同一张票据可能发给几家服务。留空即关闭。', aliases: ['inbox'], control: { type: 'folder', key: 'magicFolderPath', placeholder: DEFAULT_SETTINGS.magicFolderPath } },
			{ name: '处理后归档文件夹', desc: '处理完成后把原文件移入此文件夹。留空则移到回收站。', control: { type: 'folder', key: 'archiveFolderPath', placeholder: DEFAULT_SETTINGS.archiveFolderPath } },
			{
				type: 'group',
				heading: '月度预算',
				items: [
					{ name: '预算', desc: '每行一个一级分类和金额（报表币种），写“总计”设整月总预算。账本页会显示本月用了多少，超过 80% 变橙色，超出变红色。', aliases: ['budget'], control: { type: 'textarea', key: 'budgetText', placeholder: '总计 150000\n餐饮 40000\n交通 12000' } }
				]
			},
			{
				type: 'list',
				heading: '固定支出',
				emptyState: '房租、话费、订阅等每月都有的支出。运行命令“添加本月固定支出”或在账本页点按钮，核对后一次入账；同一个月不会重复。',
				addItem: { name: '添加固定支出', action: () => {
					s.recurring.push({ id: Date.now().toString(36), description: '', category: '', amount: 0, currency: s.defaultInputCurrency, paymentMethod: '', day: 1, enabled: true });
					void this.saveAndUpdate();
				} },
				onDelete: index => { s.recurring.splice(index, 1); void this.saveAndUpdate(); },
				items: s.recurring.map((item, i) => ({
					type: 'page' as const,
					name: item.description || `固定支出 ${i + 1}`,
					desc: !item.enabled ? '已停用' : item.amount > 0 ? `每月 ${item.day} 日 · ${item.amount} ${item.currency}` : '填写金额后生效',
					items: [
						{ name: '启用', control: { type: 'toggle', key: `recurring.${i}.enabled` } },
						{ name: '内容', control: { type: 'text', key: `recurring.${i}.description`, placeholder: '房租' } },
						{ name: '分类', control: { type: 'text', key: `recurring.${i}.category`, placeholder: '住房 / 房租' } },
						{ name: '金额', control: { type: 'number', key: `recurring.${i}.amount`, min: 0, step: 'any' } },
						{ name: '币种', control: { type: 'text', key: `recurring.${i}.currency` } },
						{ name: '每月扣款日', desc: '短月份按当月最后一天。', control: { type: 'number', key: `recurring.${i}.day`, min: 1, max: 31, step: 1 } },
						{ name: '支付方式', control: { type: 'text', key: `recurring.${i}.paymentMethod` } }
					]
				}))
			},
			{
				type: 'list',
				heading: '成员与账本',
				addItem: { name: '添加成员', action: () => {
					s.users.push({ id: Date.now().toString(), name: '新成员', folder: `${s.financeFolderPath}/新成员`, color: '#ff9f40' });
					void this.saveAndUpdate();
				} },
				onDelete: index => {
					if (s.users.length <= 1) { new Notice('至少要保留一位成员。'); return; }
					const [removed] = s.users.splice(index, 1);
					const first = s.users[0];
					if (removed && s.currentUser === removed.id && first) s.currentUser = first.id;
					void this.saveAndUpdate();
				},
				items: s.users.map((user, i) => ({
					type: 'page' as const,
					name: user.name || `成员 ${i + 1}`,
					desc: [i === 0 ? '默认成员' : '', user.folder].filter(Boolean).join(' · '),
					items: [
						{ name: '名字', control: { type: 'text', key: `users.${i}.name` } },
						{ name: '颜色', control: { type: 'color', key: `users.${i}.color` } },
						{ name: '账本文件夹', control: { type: 'folder', key: `users.${i}.folder` } },
						{ name: '专用收件箱', desc: '可不填。放进这里的文件同样会立即发给 AI 服务，并记到这位成员名下。', control: { type: 'folder', key: `users.${i}.inboxFolder` } }
					]
				}))
			},
			{
				type: 'group',
				heading: 'AI 识别',
				items: [
					{ name: '服务', desc: '票据和文本由哪个 AI 读取。只在你处理票据、或文件放进收件箱时发送内容。', control: { type: 'dropdown', key: 'aiProvider', options: { gemini: 'Google Gemini', openai: 'OpenAI 兼容接口（可设多个备用）' } } },
					{ name: 'Gemini API 密钥', desc: '选择或新建一个存在 Obsidian 密钥库里的密钥，其他插件也能共用。可在 Google AI Studio 获取。', visible: () => s.aiProvider === 'gemini', control: { type: 'secret', key: 'geminiSecretName' } },
					{ name: 'Gemini 模型', visible: () => s.aiProvider === 'gemini', control: { type: 'text', key: 'geminiModel', placeholder: DEFAULT_SETTINGS.geminiModel } }
				]
			},
			{
				type: 'list',
				heading: '接口列表',
				visible: () => s.aiProvider === 'openai',
				emptyState: '还没有接口。按顺序尝试，前一个失败就换下一个。',
				addItem: { name: '添加接口', action: () => {
					s.apiEndpoints.push({ id: Date.now().toString(36), name: '新接口', endpoint: DEFAULT_SETTINGS.openaiEndpoint, apiKey: '', model: DEFAULT_SETTINGS.openaiModel, enabled: true });
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
					name: `${i + 1}. ${ep.name || ep.endpoint}`,
					desc: ep.enabled ? ep.model : '已停用',
					items: [
						{ name: '启用', control: { type: 'toggle', key: `apiEndpoints.${i}.enabled` } },
						{ name: '名称', control: { type: 'text', key: `apiEndpoints.${i}.name`, placeholder: '本地模型' } },
						{ name: '地址', control: { type: 'text', key: `apiEndpoints.${i}.endpoint`, placeholder: DEFAULT_SETTINGS.openaiEndpoint } },
						{ name: '模型', control: { type: 'text', key: `apiEndpoints.${i}.model`, placeholder: DEFAULT_SETTINGS.openaiModel } },
						{ name: '密钥', desc: '本地模型可以不填。', control: { type: 'secret', key: `apiEndpoints.${i}.apiKeySecret` } },
						{ name: '测试连接', desc: '发一条很短的请求，看接口能不能用。', render: (setting: Setting) => this.renderTest(setting, ep) }
					]
				}))
			},
			{
				type: 'group',
				heading: '日记同步',
				items: [
					{ name: '同步到日记', desc: '把当天的交易记录追加到对应日记。', control: { type: 'toggle', key: 'dailyJournalEnabled' } },
					{ name: '日记文件夹', control: { type: 'folder', key: 'dailyJournalFolderPath' } },
					{ name: '日记文件名格式', desc: '和日记插件的日期格式一致，例如年月日中间用短横线。', control: { type: 'text', key: 'dailyJournalFilePattern', placeholder: DEFAULT_SETTINGS.dailyJournalFilePattern } }
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
		else if (field === 'aiProvider') next = value === 'openai' ? 'openai' : 'gemini';
		else if (field === 'geminiModel') next = text(value).trim() || DEFAULT_SETTINGS.geminiModel;
		else if (typeof value === 'string' && field !== 'budgetText' && field !== 'name') next = value.trim();
		writePath(s, key, next);
		await this.plugin.saveSettings();
		if (field === 'budgetText') this.plugin.refreshDashboards();
		// Names and summaries show on list entries, and the provider decides which rows are shown.
		if (['aiProvider', 'name', 'description', 'amount', 'day', 'currency', 'enabled', 'model', 'folder', 'endpoint'].includes(field)) this.update();
	}

	private async saveAndUpdate() {
		await this.plugin.saveSettings();
		this.update();
	}

	private renderTest(setting: Setting, ep: ApiEndpoint) {
		setting.addButton(button => button.setButtonText('测试').onClick(async () => {
			button.setDisabled(true);
			setting.setDesc('测试中…');
			try {
				const key = ep.apiKeySecret ? this.app.secretStorage.getSecret(ep.apiKeySecret) ?? '' : '';
				const resp = await requestUrl({
					url: `${ep.endpoint.replace(/\/+$/, '')}/chat/completions`,
					method: 'POST',
					headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
					body: JSON.stringify({ model: ep.model || DEFAULT_SETTINGS.openaiModel, messages: [{ role: 'user', content: 'Reply with just: ok' }], max_tokens: 5 }),
					throw: false
				});
				setting.setDesc(resp.status === 200 ? '连接成功。' : `失败（HTTP ${resp.status}）。`);
			} catch (error) {
				setting.setDesc(`网络错误：${(error as Error).message}`);
			} finally {
				button.setDisabled(false);
			}
		}));
	}
}
