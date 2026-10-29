import { Notice } from 'obsidian';
import { tr } from '../i18n';
import { CancelToken } from './providers';

/**
 * A notice that shows which step a slow AI task is on, with Cancel while it runs and
 * Retry when it fails. The service cannot be stopped mid-request; Cancel stops waiting
 * and drops the reply.
 */
export class TaskProgress {
    readonly token: CancelToken = { cancelled: false };
    private notice: Notice;
    private closed = false;

    /** `prefix` keeps the class names inside this plugin, e.g. "aa" gives "aa-task-step". */
    constructor(private title: string, private prefix: string) {
        this.notice = new Notice('', 0);
        this.notice.messageEl.addClass(`${prefix}-task-notice`);
    }

    get cancelled(): boolean {
        return this.token.cancelled;
    }

    /** `index` counts from 1. */
    step(text: string, index?: number, total?: number) {
        if (this.closed) return;
        const frag = new DocumentFragment();
        const head = frag.createDiv({ cls: `${this.prefix}-task-title` });
        head.appendText(this.title);
        if (index && total) head.createSpan({ cls: `${this.prefix}-task-count`, text: ` · ${index}/${total}` });
        frag.createDiv({ cls: `${this.prefix}-task-step`, text });
        if (index && total) {
            const bar = frag.createDiv({ cls: `${this.prefix}-task-bar` });
            bar.createDiv({ cls: `${this.prefix}-task-bar-fill` }).setCssProps({ width: `${Math.round((index / total) * 100)}%` });
        }
        const actions = frag.createDiv({ cls: `${this.prefix}-task-actions` });
        this.button(actions, tr('Cancel', '取消'), () => {
            this.token.cancelled = true;
            this.close();
            new Notice(tr(`${this.title}: cancelled. Nothing was written.`, `${this.title}：已取消，没有写入任何内容。`));
        });
        this.notice.setMessage(frag);
    }

    /** Keeps the notice open with the reason, one next step (Retry unless named otherwise) and Close. */
    fail(message: string, next?: () => void, nextLabel = tr('Retry', '重试')) {
        if (this.closed) return;
        const frag = new DocumentFragment();
        frag.createDiv({ cls: `${this.prefix}-task-title`, text: this.title });
        frag.createDiv({ cls: `${this.prefix}-task-step is-error`, text: message });
        const actions = frag.createDiv({ cls: `${this.prefix}-task-actions` });
        if (next) this.button(actions, nextLabel, () => { this.close(); next(); }, true);
        this.button(actions, tr('Close', '关闭'), () => this.close());
        this.notice.setMessage(frag);
    }

    close() {
        if (this.closed) return;
        this.closed = true;
        this.notice.hide();
    }

    private button(parent: HTMLElement, text: string, onClick: () => void, cta = false) {
        const button = parent.createEl('button', { text, cls: cta ? 'mod-cta' : '' });
        // A click on a notice closes it; the buttons decide for themselves.
        button.addEventListener('click', event => { event.stopPropagation(); onClick(); });
    }
}
