import { App, PluginSettingTab, Setting, requestUrl } from "obsidian";
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
	apiKey: string;
	model: string;
	enabled: boolean;    // 是否启用（可快速禁用某个）
}

export interface AccountingSettings {
	baseCurrency: string;
	aiProvider: 'gemini' | 'openai';
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
	// Appearance
	paperStyle: boolean;
}

export const DEFAULT_SETTINGS: AccountingSettings = {
	baseCurrency: 'CNY',
	aiProvider: 'gemini',
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
	paperStyle: false
}

export class AccountingSettingTab extends PluginSettingTab {
	plugin: AccountingPlugin;

	constructor(app: App, plugin: AccountingPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
        this.renderSettingsBody();
        const root = this.containerEl;
        root.addClass('plugin-settings-workspace');
        const nav = root.createDiv({ cls: 'plugin-settings-jump' });
        const label = nav.createEl('label', { text: '快速定位' });
        const select = label.createEl('select', { attr: { 'aria-label': '跳转到设置分组' } });
        select.createEl('option', { text: '选择设置分组…', value: '' });
        const sections = Array.from(root.querySelectorAll('h2'));
        sections.forEach((section, index) => {
            select.createEl('option', { text: section.textContent || '设置', value: String(index) });
        });
        select.addEventListener('change', () => {
            if (select.value === '') return;
            const target = sections[Number(select.value)];
            if (target) {
                target.setAttribute('tabindex', '-1');
                target.scrollIntoView({ block: 'start' });
                (target as HTMLElement).focus({ preventScroll: true });
            }
        });
        root.prepend(nav);
    }

    renderSettingsBody(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('h2', { text: '外观' });

		new Setting(containerEl)
			.setName('纸墨风格（Paper & ink style）')
			.setDesc('纸色底、细墨线、衬线数字，强调色用暗红和青绿。关闭时跟随 Obsidian 主题。')
			.addToggle(toggle => toggle
				.setValue(!!this.plugin.settings.paperStyle)
				.onChange(async (value) => {
					this.plugin.settings.paperStyle = value;
					await this.plugin.saveSettings();
					this.plugin.refreshDashboards();
				}));

		containerEl.createEl('h2', { text: '币种与文件存储' });

		new Setting(containerEl)
			.setName('报表币种')
			.setDesc('报表金额统一换算为这个币种。')
			.addText(text => text
				.setPlaceholder('CNY')
				.setValue(this.plugin.settings.baseCurrency)
				.onChange(async (value) => {
					this.plugin.settings.baseCurrency = value.toUpperCase();
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('默认输入币种')
			.setDesc('录入时没有注明币种，就使用这个默认值。')
			.addText(text => text
				.setPlaceholder('CNY')
				.setValue(this.plugin.settings.defaultInputCurrency)
				.onChange(async (value) => {
					this.plugin.settings.defaultInputCurrency = value.toUpperCase();
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('票据收件箱')
			.setDesc('监测这个文件夹中的新图片和文本，自动识别并记账。')
			.addText(text => text
				.setPlaceholder('Finances/Inbox')
				.setValue(this.plugin.settings.magicFolderPath)
				.onChange(async (value) => {
					this.plugin.settings.magicFolderPath = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('处理后归档文件夹')
			.setDesc('处理完成后把原文件移入此文件夹。注意：留空会改为删除原文件。')
			.addText(text => text
				.setPlaceholder('Finances/Archive')
				.setValue(this.plugin.settings.archiveFolderPath)
				.onChange(async (value) => {
					this.plugin.settings.archiveFolderPath = value;
					await this.plugin.saveSettings();
				}));

		// Daily journal settings
		containerEl.createEl('h2', { text: '日记同步' });
		new Setting(containerEl)
			.setName('同步到日记')
			.setDesc('把当天的交易记录追加到对应日记。')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.dailyJournalEnabled)
				.onChange(async (value) => {
					this.plugin.settings.dailyJournalEnabled = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('日记文件夹')
			.setDesc('存放每日笔记的文件夹。')
			.addText(text => text
				.setPlaceholder('Daily')
				.setValue(this.plugin.settings.dailyJournalFolderPath)
				.onChange(async (value) => {
					this.plugin.settings.dailyJournalFolderPath = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('日记文件名格式')
			.setDesc('使用 YYYY、MM、DD 表示年、月、日。')
			.addText(text => text
				.setPlaceholder('YYYY-MM-DD')
				.setValue(this.plugin.settings.dailyJournalFilePattern)
				.onChange(async (value) => {
					this.plugin.settings.dailyJournalFilePattern = value;
					await this.plugin.saveSettings();
				}));

		// Multi-user Settings
		containerEl.createEl('h2', { text: '成员与账本' });
		containerEl.createEl('p', { text: '为每位成员指定独立账本文件夹。列表中的第一位成员为默认成员。' });

		this.plugin.settings.users.forEach((user, index) => {
			const div = containerEl.createEl('div', { cls: 'user-setting-row', attr: { style: 'display: flex; gap: 10px; margin-bottom: 10px; align-items: center;' } });

			// Name
			new Setting(div)
				.setName(`User ${index + 1}`)
				.setClass('user-setting-item')
				.addText(text => text
					.setPlaceholder('Name')
					.setValue(user.name)
					.onChange(async (value) => {
						user.name = value;
						await this.plugin.saveSettings();
					}));

			// Folder (Raw input for now)
			const folderInput = div.createEl('input', { type: 'text', placeholder: 'Folder Path' });
			folderInput.value = user.folder;
			folderInput.onchange = async () => {
				user.folder = folderInput.value;
				await this.plugin.saveSettings();
			};

			// Color
			const colorInput = div.createEl('input', { type: 'color' });
			colorInput.value = user.color || '#cccccc';
			colorInput.onchange = async () => {
				user.color = colorInput.value;
				await this.plugin.saveSettings();
			};

			// Inbox Folder (Optional)
			const inboxInput = div.createEl('input', { type: 'text', placeholder: 'Inbox (Optional)' });
			inboxInput.value = user.inboxFolder || '';
			inboxInput.onchange = async () => {
				user.inboxFolder = inboxInput.value;
				await this.plugin.saveSettings();
			};

			// Delete Button
			if (this.plugin.settings.users.length > 1) {
				const btn = div.createEl('button', { text: 'X' });
				btn.onclick = async () => {
					this.plugin.settings.users.splice(index, 1);
					// Reset current user if deleted
					const firstUser = this.plugin.settings.users[0];
					if (this.plugin.settings.currentUser === user.id && firstUser) {
						this.plugin.settings.currentUser = firstUser.id;
					}
					await this.plugin.saveSettings();
					this.display();
				};
			}
		});

		new Setting(containerEl)
			.addButton(btn => btn
				.setButtonText('Add User')
				.onClick(async () => {
					this.plugin.settings.users.push({
						id: Date.now().toString(),
						name: 'New User',
						folder: 'Finances/NewUser',
						color: '#ff9f40'
					});
					await this.plugin.saveSettings();
					this.display();
				}));


		containerEl.createEl('h2', { text: 'AI 识别与模型' });

		new Setting(containerEl)
			.setName('AI Provider')
			.setDesc('Choose your AI engine.')
			.addDropdown(dropdown => dropdown
				.addOption('gemini', 'Google Gemini')
				.addOption('openai', 'OpenAI / Custom (支持多 Endpoint Fallback)')
				.setValue(this.plugin.settings.aiProvider)
				.onChange(async (value: 'gemini' | 'openai') => {
					this.plugin.settings.aiProvider = value;
					await this.plugin.saveSettings();
					this.display();
				}));

		if (this.plugin.settings.aiProvider === 'gemini') {
			new Setting(containerEl)
				.setName('Gemini API Key')
				.setDesc('Get your key from Google AI Studio.')
				.addText(text => {
					text.inputEl.type = 'password';
					text.setPlaceholder('Enter Gemini Key')
					.setValue(this.plugin.settings.geminiApiKey)
					.onChange(async (value) => {
						this.plugin.settings.geminiApiKey = value;
						await this.plugin.saveSettings();
					});
				});

			new Setting(containerEl)
				.setName('Gemini Model')
				.setDesc('e.g., gemini-1.5-flash, gemini-1.5-pro.')
				.addText(text => text
					.setPlaceholder('gemini-1.5-flash')
					.setValue(this.plugin.settings.geminiModel)
					.onChange(async (value) => {
						this.plugin.settings.geminiModel = value;
						await this.plugin.saveSettings();
					}));
		} else {
			// ── OpenAI 多 Endpoint 管理 ──
			this.renderApiEndpointsSection(containerEl);
		}
	}

	/**
	 * 渲染多 API Endpoint 管理区域
	 * 支持动态增删，拖拽排序（通过上下按钮），以及启用/禁用单个 endpoint
	 */
	private renderApiEndpointsSection(containerEl: HTMLElement): void {
		const s = this.plugin.settings;

		// 首次使用时，将旧的单一配置迁移进列表
		if (s.apiEndpoints.length === 0 && (s.openaiApiKey || s.openaiEndpoint)) {
			s.apiEndpoints.push({
				id: 'migrated-default',
				name: 'OpenAI (迁移)',
				endpoint: s.openaiEndpoint || 'https://api.openai.com/v1',
				apiKey: s.openaiApiKey || '',
				model: s.openaiModel || 'gpt-4o',
				enabled: true,
			});
			void this.plugin.saveSettings();
		}

		const headerSetting = new Setting(containerEl)
			.setName('API Endpoints（按顺序 Fallback）')
			.setDesc('调用时按顺序尝试，一个失败立即切换到下一个。排在前面的优先级更高。');

		headerSetting.addButton(btn => btn
			.setButtonText('＋ 新增 Endpoint')
			.setCta()
			.onClick(async () => {
				s.apiEndpoints.push({
					id: Date.now().toString(),
					name: '新 Endpoint',
					endpoint: 'https://api.openai.com/v1',
					apiKey: '',
					model: 'gpt-4o',
					enabled: true,
				});
				await this.plugin.saveSettings();
				this.display();
			}));

		const endpointsContainer = containerEl.createDiv({ cls: 'api-endpoints-list' });

		if (s.apiEndpoints.length === 0) {
			endpointsContainer.createEl('p', {
				text: '暂无 Endpoint，点击上方按钮添加。',
				attr: { style: 'color: var(--text-muted); font-size: 0.85em; margin: 8px 0;' }
			});
			return;
		}

		s.apiEndpoints.forEach((ep, index) => {
			const card = endpointsContainer.createDiv({
				cls: 'api-endpoint-card',
				attr: {
					style: [
						'border: 1px solid var(--background-modifier-border)',
						'border-radius: 8px',
						'padding: 12px 14px',
						'margin-bottom: 10px',
						`opacity: ${ep.enabled ? '1' : '0.5'}`,
						'transition: opacity 0.2s',
					].join('; ')
				}
			});

			// ── 标题行：序号 + 启用开关 + 上下移 + 删除 ──
			const titleRow = card.createDiv({
				attr: { style: 'display: flex; align-items: center; gap: 8px; margin-bottom: 10px;' }
			});
			titleRow.createEl('span', {
				text: `#${index + 1}`,
				attr: {
					style: 'font-weight: 600; color: var(--text-accent); min-width: 24px; font-size: 0.9em;'
				}
			});

			// 名称输入
			const nameInput = titleRow.createEl('input', {
				type: 'text',
				attr: {
					placeholder: '显示名称（如 OpenAI / 本地 Ollama）',
					style: 'flex: 1; font-weight: 500;'
				}
			}) as HTMLInputElement;
			nameInput.value = ep.name;
			nameInput.onchange = async () => { ep.name = nameInput.value; await this.plugin.saveSettings(); };

			// 启用开关
			const toggleLabel = titleRow.createEl('label', {
				attr: { style: 'display: flex; align-items: center; gap: 4px; cursor: pointer; font-size: 0.82em; color: var(--text-muted);' }
			});
			const toggleInput = toggleLabel.createEl('input', { type: 'checkbox' }) as HTMLInputElement;
			toggleInput.checked = ep.enabled;
			toggleLabel.appendText(ep.enabled ? '已启用' : '已禁用');
			toggleInput.onchange = async () => {
				ep.enabled = toggleInput.checked;
				toggleLabel.lastChild!.textContent = ep.enabled ? '已启用' : '已禁用';
				card.style.opacity = ep.enabled ? '1' : '0.5';
				await this.plugin.saveSettings();
			};

			// 上移
			const upBtn = titleRow.createEl('button', { text: '↑', attr: { title: '上移（优先级+1）' } });
			upBtn.disabled = index === 0;
			upBtn.onclick = async () => {
				if (index === 0) return;
				const tmp = s.apiEndpoints[index - 1]!;
				s.apiEndpoints[index - 1] = s.apiEndpoints[index]!;
				s.apiEndpoints[index] = tmp;
				await this.plugin.saveSettings();
				this.display();
			};

			// 下移
			const downBtn = titleRow.createEl('button', { text: '↓', attr: { title: '下移（优先级-1）' } });
			downBtn.disabled = index === s.apiEndpoints.length - 1;
			downBtn.onclick = async () => {
				if (index === s.apiEndpoints.length - 1) return;
				const tmp = s.apiEndpoints[index + 1]!;
				s.apiEndpoints[index + 1] = s.apiEndpoints[index]!;
				s.apiEndpoints[index] = tmp;
				await this.plugin.saveSettings();
				this.display();
			};

			// 删除
			const delBtn = titleRow.createEl('button', {
				text: '✕',
				attr: { title: '删除此 Endpoint', style: 'color: var(--text-error);' }
			});
			delBtn.onclick = async () => {
				s.apiEndpoints.splice(index, 1);
				await this.plugin.saveSettings();
				this.display();
			};

			// ── 详细字段行 ──
			const fieldsGrid = card.createDiv({
				attr: { style: 'display: grid; grid-template-columns: 1fr 1fr; gap: 8px;' }
			});

			const makeField = (parent: HTMLElement, label: string, placeholder: string, value: string, isSecret = false) => {
				const wrap = parent.createDiv();
				wrap.createEl('label', {
					text: label,
					attr: { style: 'font-size: 0.78em; color: var(--text-muted); display: block; margin-bottom: 3px;' }
				});
				const inp = wrap.createEl('input', {
					type: isSecret ? 'password' : 'text',
					attr: { placeholder, style: 'width: 100%; box-sizing: border-box;' }
				}) as HTMLInputElement;
				inp.value = value;
				return inp;
			};

			// Endpoint URL（跨两列）
			const endpointWrap = card.createDiv({ attr: { style: 'margin-bottom: 8px;' } });
			endpointWrap.createEl('label', {
				text: 'Endpoint URL',
				attr: { style: 'font-size: 0.78em; color: var(--text-muted); display: block; margin-bottom: 3px;' }
			});
			const endpointInput = endpointWrap.createEl('input', {
				type: 'text',
				attr: { placeholder: 'https://api.openai.com/v1', style: 'width: 100%; box-sizing: border-box;' }
			}) as HTMLInputElement;
			endpointInput.value = ep.endpoint;
			endpointInput.onchange = async () => { ep.endpoint = endpointInput.value.trim(); await this.plugin.saveSettings(); };

			// API Key & Model 两列
			const apiKeyInput = makeField(fieldsGrid, 'API Key', 'sk-... 或留空', ep.apiKey, true);
			apiKeyInput.onchange = async () => { ep.apiKey = apiKeyInput.value; await this.plugin.saveSettings(); };

			const modelInput = makeField(fieldsGrid, 'Model', 'gpt-4o / llama3 / ...', ep.model);
			modelInput.onchange = async () => { ep.model = modelInput.value.trim(); await this.plugin.saveSettings(); };

			// ── 底部：测试按钮 + 状态 ──
			const footerRow = card.createDiv({
				attr: { style: 'display: flex; align-items: center; gap: 8px; margin-top: 10px;' }
			});
			const statusSpan = footerRow.createEl('span', {
				attr: { style: 'font-size: 0.8em; color: var(--text-muted); flex: 1;' }
			});
			const testBtn = footerRow.createEl('button', { text: '🔍 测试连接' });
			testBtn.onclick = async () => {
				testBtn.disabled = true;
				statusSpan.textContent = '测试中...';
				statusSpan.style.color = 'var(--text-muted)';
				try {
					let url = (endpointInput.value || ep.endpoint).trim();
					if (url.endsWith('/')) url = url.slice(0, -1);
					const key = apiKeyInput.value || ep.apiKey;
					const model = modelInput.value || ep.model || 'gpt-4o';
					const resp = await requestUrl({
						url: `${url}/chat/completions`,
						method: 'POST',
						headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
						body: JSON.stringify({
							model,
							messages: [{ role: 'user', content: 'Reply with just: ok' }],
							max_tokens: 5,
						}),
						throw: false,
					});
					if (resp.status === 200) {
						statusSpan.textContent = '✅ 连接成功';
						statusSpan.style.color = 'var(--color-green)';
					} else {
						statusSpan.textContent = `❌ 失败 (${resp.status})`;
						statusSpan.style.color = 'var(--color-red)';
					}
				} catch (e) {
					statusSpan.textContent = `❌ 网络错误: ${(e as Error).message}`;
					statusSpan.style.color = 'var(--color-red)';
				} finally {
					testBtn.disabled = false;
				}
			};
		});
	}
}
