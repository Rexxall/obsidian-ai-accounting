import { Modal, App, Setting, Notice } from 'obsidian';
import { tr } from '../i18n';
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
        this.modalEl.addClass('ap', 'ap-modal');
        this.setTitle(tr(`Rename category: ${this.oldCategoryName}`, `重命名分类：${this.oldCategoryName}`));

        new Setting(contentEl)
            .setName(tr('New name', '新分类名称'))
            .setDesc(tr('Every transaction in this category is updated.', '所有相关的交易分类都将被更新'))
            .addText(text => text
                .setValue(this.newCategoryName)
                .onChange(value => {
                    this.newCategoryName = value;
                }));

        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText(tr('Rename', '确认修改'))
                .setCta()
                .onClick(async () => {
                    if (!this.newCategoryName || this.newCategoryName === this.oldCategoryName) {
                        new Notice(tr('Nothing changed.', '无变化'));
                        this.close();
                        return;
                    }

                    new Notice(tr(`Renaming ${this.oldCategoryName} to ${this.newCategoryName}…`, `正在批量修改分类: ${this.oldCategoryName} -> ${this.newCategoryName}...`));
                    await this.plugin.dataService.updateCategoryBatch(this.oldCategoryName, this.newCategoryName);
                    this.onRename();
                    this.close();
                }))
            .addButton(btn => btn
                .setButtonText(tr('Cancel', '取消'))
                .onClick(() => {
                    this.close();
                }));
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}
