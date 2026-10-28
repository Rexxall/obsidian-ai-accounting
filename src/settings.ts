import { App, PluginSettingTab, SecretComponent, Setting, requestUrl } from "obsidian";
import { RecurringExpense, parseBudgets } from "./services/planning";
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

export class AccountingSettingTab extends PluginSettingTab {
	plugin: AccountingPlugin;

	constructor(app: App, plugin: AccountingPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass('aa-settings', 'ap', 'ap-settings');
		const s = this.plugin.settings;
		const save = async () => { await this.plugin.saveSettings(); };

		// General settings come first, without a heading.
		new Setting(containerEl)
			.setName('报表币种')
			.setDesc('报表金额统一换算为这个币种，预算也按它填写。')
			.addText(text => text
				.setPlaceholder('CNY')
				.setValue(s.baseCurrency)
				.onChange(async value => { s.baseCurrency = value.trim().toUpperCase(); await save(); }));
		new Setting(containerEl)
			.setName('默认输入币种')
			.setDesc('录入时没有注明币种，就使用这个默认值。')
			.addText(text => text
				.setPlaceholder('CNY')
				.setValue(s.defaultInputCurrency)
				.onChange(async value => { s.defaultInputCurrency = value.trim().toUpperCase(); await save(); }));
		new Setting(containerEl)
			.setName('票据收件箱')
			.setDesc('放进这个文件夹的图片和文本会立即发给 AI 服务识别，核对后入账；配了多个服务时，一个失败就换下一个，同一张票据可能发给几家服务。留空即关闭。')
			.addText(text => text
				.setPlaceholder('Finances/Inbox')
				.setValue(s.magicFolderPath)
				.onChange(async value => { s.magicFolderPath = value.trim(); await save(); }));
		new Setting(containerEl)
			.setName('处理后归档文件夹')
			.setDesc('处理完成后把原文件移入此文件夹。留空则移到回收站。')
			.addText(text => text
				.setPlaceholder('Finances/Archive')
				.setValue(s.archiveFolderPath)
				.onChange(async value => { s.archiveFolderPath = value.trim(); await save(); }));

		this.renderBudgets(containerEl);
		this.renderRecurring(containerEl);
		this.renderMembers(containerEl);
		this.renderAi(containerEl);

		new Setting(containerEl).setName('日记同步').setHeading();
		new Setting(containerEl)
			.setName('同步到日记')
			.setDesc('把当天的交易记录追加到对应日记。')
			.addToggle(toggle => toggle
				.setValue(s.dailyJournalEnabled)
				.onChange(async value => { s.dailyJournalEnabled = value; await save(); }));
		new Setting(containerEl)
			.setName('日记文件夹')
			.addText(text => text
				.setPlaceholder('Daily')
				.setValue(s.dailyJournalFolderPath)
				.onChange(async value => { s.dailyJournalFolderPath = value.trim(); await save(); }));
		new Setting(containerEl)
			.setName('日记文件名格式')
			.setDesc('用 YYYY、MM、DD 表示年、月、日。')
			.addText(text => text
				.setPlaceholder('YYYY-MM-DD')
				.setValue(s.dailyJournalFilePattern)
				.onChange(async value => { s.dailyJournalFilePattern = value.trim(); await save(); }));
	}

	private renderBudgets(containerEl: HTMLElement) {
		const s = this.plugin.settings;
		new Setting(containerEl).setName('月度预算').setHeading();
		const parsed = () => {
			const budgets = parseBudgets(s.budgetText);
			const count = Object.keys(budgets.categories).length;
			return count === 0 && !budgets.total ? '还没有设置预算。' : `已识别 ${count} 个分类${budgets.total ? '和总预算' : ''}。`;
		};
		const setting = new Setting(containerEl)
			.setName('预算')
			.setDesc(parsed())
			.addTextArea(text => {
				text.inputEl.rows = 5;
				text.setPlaceholder('总计 150000\n餐饮 40000\n交通 12000')
					.setValue(s.budgetText)
					.onChange(async value => {
						s.budgetText = value;
						setting.setDesc(parsed());
						await this.plugin.saveSettings();
						this.plugin.refreshDashboards();
					});
			});
		containerEl.createDiv({ cls: 'setting-item-description aa-settings-note', text: '每行一个一级分类和金额（报表币种），写“总计”设整月总预算。账本页会显示本月用了多少，超过 80% 变橙色，超出变红色。' });
	}

	private renderRecurring(containerEl: HTMLElement) {
		const s = this.plugin.settings;
		new Setting(containerEl)
			.setName('固定支出')
			.setHeading()
			.addExtraButton(button => button
				.setIcon('plus')
				.setTooltip('添加固定支出')
				.onClick(async () => {
					s.recurring.push({ id: Date.now().toString(36), description: '', category: '', amount: 0, currency: s.defaultInputCurrency, paymentMethod: '', day: 1, enabled: true });
					await this.plugin.saveSettings();
					this.display();
				}));
		containerEl.createDiv({ cls: 'setting-item-description aa-settings-note', text: '房租、话费、订阅等每月都有的支出。运行命令“添加本月固定支出”或在账本页点按钮，核对后一次入账；同一个月不会重复。' });
		if (s.recurring.length === 0) return;
		const list = containerEl.createDiv({ cls: 'aa-settings-list' });
		s.recurring.forEach((item, index) => {
			const card = list.createDiv({ cls: `aa-settings-card${item.enabled ? '' : ' is-off'}` });
			new Setting(card)
				.setName(item.description || `固定支出 ${index + 1}`)
				.setDesc(item.amount > 0 ? `每月 ${item.day} 日 · ${item.amount} ${item.currency}` : '填写金额后生效')
				.addToggle(toggle => toggle
					.setTooltip('启用')
					.setValue(item.enabled)
					.onChange(async value => { item.enabled = value; card.toggleClass('is-off', !value); await this.plugin.saveSettings(); }))
				.addExtraButton(button => button
					.setIcon('trash-2')
					.setTooltip('删除')
					.onClick(async () => { s.recurring.splice(index, 1); await this.plugin.saveSettings(); this.display(); }));
			const fields = new Setting(card).setClass('aa-settings-fields');
			fields.addText(text => text.setPlaceholder('内容，如 房租').setValue(item.description).onChange(async v => { item.description = v.trim(); await this.plugin.saveSettings(); }));
			fields.addText(text => text.setPlaceholder('分类，如 住房 / 房租').setValue(item.category).onChange(async v => { item.category = v.trim(); await this.plugin.saveSettings(); }));
			fields.addText(text => {
				text.inputEl.type = 'number';
				text.inputEl.min = '0';
				text.setPlaceholder('金额').setValue(item.amount ? String(item.amount) : '').onChange(async v => { item.amount = Math.max(0, Number(v) || 0); await this.plugin.saveSettings(); });
			});
			fields.addText(text => text.setPlaceholder('币种').setValue(item.currency).onChange(async v => { item.currency = v.trim().toUpperCase(); await this.plugin.saveSettings(); }));
			fields.addText(text => {
				text.inputEl.type = 'number';
				text.inputEl.min = '1';
				text.inputEl.max = '31';
				text.setPlaceholder('扣款日').setValue(String(item.day)).onChange(async v => { item.day = Math.min(31, Math.max(1, Math.floor(Number(v)) || 1)); await this.plugin.saveSettings(); });
			});
			fields.addText(text => text.setPlaceholder('支付方式').setValue(item.paymentMethod).onChange(async v => { item.paymentMethod = v.trim(); await this.plugin.saveSettings(); }));
			// Placeholders disappear once a field is filled, so each input also carries its name.
			['内容', '分类', '金额', '币种', '每月扣款日', '支付方式'].forEach((label, i) => {
				const input = fields.controlEl.querySelectorAll('input')[i];
				input?.setAttrs({ 'aria-label': label, title: label });
			});
		});
	}

	private renderMembers(containerEl: HTMLElement) {
		const s = this.plugin.settings;
		new Setting(containerEl)
			.setName('成员与账本')
			.setHeading()
			.addExtraButton(button => button
				.setIcon('plus')
				.setTooltip('添加成员')
				.onClick(async () => {
					s.users.push({ id: Date.now().toString(), name: '新成员', folder: 'Finances/New', color: '#ff9f40' });
					await this.plugin.saveSettings();
					this.display();
				}));
		containerEl.createDiv({ cls: 'setting-item-description aa-settings-note', text: '每位成员有自己的账本文件夹，可另设专用收件箱；放进专用收件箱的文件同样会立即发给 AI 服务。第一位是默认成员。' });
		s.users.forEach((user, index) => {
			const row = new Setting(containerEl)
				.setClass('aa-member-row')
				.setName(user.name || `成员 ${index + 1}`)
				.addColorPicker(picker => picker.setValue(user.color || '#cccccc').onChange(async v => { user.color = v; await this.plugin.saveSettings(); }))
				.addText(text => text.setPlaceholder('名字').setValue(user.name).onChange(async v => { user.name = v; await this.plugin.saveSettings(); }))
				.addText(text => text.setPlaceholder('账本文件夹').setValue(user.folder).onChange(async v => { user.folder = v.trim(); await this.plugin.saveSettings(); }))
				.addText(text => text.setPlaceholder('专用收件箱（可选）').setValue(user.inboxFolder || '').onChange(async v => { user.inboxFolder = v.trim(); await this.plugin.saveSettings(); }));
			if (s.users.length > 1) {
				row.addExtraButton(button => button
					.setIcon('trash-2')
					.setTooltip('删除成员（账本文件保留）')
					.onClick(async () => {
						s.users.splice(index, 1);
						const first = s.users[0];
						if (s.currentUser === user.id && first) s.currentUser = first.id;
						await this.plugin.saveSettings();
						this.display();
					}));
			}
		});
	}

	private secretSetting(containerEl: HTMLElement, name: string, desc: string, value: string, onChange: (value: string) => Promise<void>) {
		return new Setting(containerEl)
			.setName(name)
			.setDesc(desc)
			.addComponent(el => new SecretComponent(this.app, el)
				.setValue(value)
				.onChange(async v => { await onChange(v ?? ''); }));
	}

	private renderAi(containerEl: HTMLElement) {
		const s = this.plugin.settings;
		new Setting(containerEl).setName('AI 识别').setHeading();
		new Setting(containerEl)
			.setName('服务')
			.setDesc('票据和文本由哪个 AI 读取。只在你处理票据时发送内容。')
			.addDropdown(dropdown => dropdown
				.addOption('gemini', 'Google Gemini')
				.addOption('openai', 'OpenAI 兼容接口（可设多个备用）')
				.setValue(s.aiProvider)
				.onChange(async value => {
					s.aiProvider = value === 'openai' ? 'openai' : 'gemini';
					await this.plugin.saveSettings();
					this.display();
				}));

		if (s.aiProvider === 'gemini') {
			this.secretSetting(containerEl, 'Gemini API 密钥', '选择或新建一个存在 Obsidian 密钥库里的密钥，其他插件也能共用。可在 Google AI Studio 获取。', s.geminiSecretName, async v => {
				s.geminiSecretName = v;
				await this.plugin.saveSettings();
			});
			new Setting(containerEl)
				.setName('Gemini 模型')
				.addText(text => text
					.setPlaceholder('gemini-2.5-flash')
					.setValue(s.geminiModel)
					.onChange(async value => { s.geminiModel = value.trim() || DEFAULT_SETTINGS.geminiModel; await this.plugin.saveSettings(); }));
			return;
		}

		new Setting(containerEl)
			.setName('接口列表')
			.setDesc('按顺序尝试，前一个失败就换下一个。')
			.addButton(button => button
				.setButtonText('添加接口')
				.onClick(async () => {
					s.apiEndpoints.push({ id: Date.now().toString(36), name: '新接口', endpoint: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o', enabled: true });
					await this.plugin.saveSettings();
					this.display();
				}));
		const list = containerEl.createDiv({ cls: 'aa-settings-list' });
		if (s.apiEndpoints.length === 0) list.createDiv({ cls: 'setting-item-description', text: '还没有接口。' });
		s.apiEndpoints.forEach((ep, index) => {
			const card = list.createDiv({ cls: `aa-settings-card${ep.enabled ? '' : ' is-off'}` });
			const move = async (to: number) => {
				const [item] = s.apiEndpoints.splice(index, 1);
				if (item) s.apiEndpoints.splice(to, 0, item);
				await this.plugin.saveSettings();
				this.display();
			};
			new Setting(card)
				.setName(`${index + 1}. ${ep.name || ep.endpoint}`)
				.addToggle(toggle => toggle
					.setTooltip('启用')
					.setValue(ep.enabled)
					.onChange(async value => { ep.enabled = value; card.toggleClass('is-off', !value); await this.plugin.saveSettings(); }))
				.addExtraButton(button => button.setIcon('arrow-up').setTooltip('提前').setDisabled(index === 0).onClick(() => void move(index - 1)))
				.addExtraButton(button => button.setIcon('arrow-down').setTooltip('延后').setDisabled(index === s.apiEndpoints.length - 1).onClick(() => void move(index + 1)))
				.addExtraButton(button => button.setIcon('trash-2').setTooltip('删除').onClick(async () => {
					s.apiEndpoints.splice(index, 1);
					await this.plugin.saveSettings();
					this.display();
				}));
			new Setting(card).setName('名称').addText(text => text.setPlaceholder('如 OpenAI、本地 Ollama').setValue(ep.name).onChange(async v => { ep.name = v; await this.plugin.saveSettings(); }));
			new Setting(card).setName('地址').addText(text => text.setPlaceholder('https://api.openai.com/v1').setValue(ep.endpoint).onChange(async v => { ep.endpoint = v.trim(); await this.plugin.saveSettings(); }));
			new Setting(card).setName('模型').addText(text => text.setPlaceholder('gpt-4o').setValue(ep.model).onChange(async v => { ep.model = v.trim(); await this.plugin.saveSettings(); }));
			this.secretSetting(card, '密钥', '本地模型可以不填。', ep.apiKeySecret || '', async v => { ep.apiKeySecret = v; await this.plugin.saveSettings(); });
			const test = new Setting(card).setName('测试连接');
			test.addButton(button => button.setButtonText('测试').onClick(async () => {
				button.setDisabled(true);
				test.setDesc('测试中…');
				try {
					const key = ep.apiKeySecret ? this.app.secretStorage.getSecret(ep.apiKeySecret) ?? '' : ep.apiKey;
					const resp = await requestUrl({
						url: `${ep.endpoint.replace(/\/+$/, '')}/chat/completions`,
						method: 'POST',
						headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
						body: JSON.stringify({ model: ep.model || 'gpt-4o', messages: [{ role: 'user', content: 'Reply with just: ok' }], max_tokens: 5 }),
						throw: false
					});
					test.setDesc(resp.status === 200 ? '连接成功。' : `失败（HTTP ${resp.status}）。`);
				} catch (error) {
					test.setDesc(`网络错误：${(error as Error).message}`);
				} finally {
					button.setDisabled(false);
				}
			}));
		});
	}
}
