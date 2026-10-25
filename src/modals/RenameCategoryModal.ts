import { Modal, App, Setting, Notice } from 'obsidian';
import AccountingPlugin from '../main';

export class RenameCategoryModal extends Modal {
    newCategoryName: string;

    constructor(app: App, private plugin: AccountingPlugin, private oldCategoryName: string, private onRename: () => void) {
        super(app);
        this.newCategoryName = oldCategoryName;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        this.modalEl.addClass('aa-modal');
        this.modalEl.toggleClass('rk-paper', !!this.plugin.settings.paperStyle);
        this.setTitle(`重命名分类：${this.oldCategoryName}`);

        new Setting(contentEl)
            .setName('新分类名称')
            .setDesc('所有相关的交易分类都将被更新')
            .addText(text => text
                .setValue(this.newCategoryName)
                .onChange(value => {
                    this.newCategoryName = value;
                }));

        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText('确认修改')
                .setCta()
                .onClick(async () => {
                    if (!this.newCategoryName || this.newCategoryName === this.oldCategoryName) {
                        new Notice('无变化');
                        this.close();
                        return;
                    }

                    new Notice(`正在批量修改分类: ${this.oldCategoryName} -> ${this.newCategoryName}...`);
                    await this.plugin.dataService.updateCategoryBatch(this.oldCategoryName, this.newCategoryName);
                    this.onRename();
                    this.close();
                }))
            .addButton(btn => btn
                .setButtonText('取消')
                .onClick(() => {
                    this.close();
                }));
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}
