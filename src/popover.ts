import { setIcon } from 'obsidian';
import { isZh, tr } from './i18n';

let closeOpen: (() => void) | null = null;

/**
 * A small glass sheet under a button, for pickers and filters. Closes on Escape,
 * on a click outside it, or when another one opens. Returns the close function.
 */
export function openPopover(anchor: HTMLElement, cls: string, build: (el: HTMLElement, close: () => void) => void): () => void {
    closeOpen?.();
    const doc = anchor.ownerDocument;
    const el = doc.body.createDiv({ cls: `ap ap-popover ${cls}`, attr: { role: 'dialog' } });
    const onDown = (event: MouseEvent) => {
        const target = event.target as Node;
        if (!el.contains(target) && !anchor.contains(target)) close();
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); close(); anchor.focus(); } };
    const close = () => {
        el.remove();
        doc.removeEventListener('mousedown', onDown, true);
        doc.removeEventListener('keydown', onKey, true);
        anchor.setAttribute('aria-expanded', 'false');
        if (closeOpen === close) closeOpen = null;
    };
    build(el, close);
    const place = () => {
        const rect = anchor.getBoundingClientRect();
        const width = el.offsetWidth;
        const left = Math.max(8, Math.min(rect.left, doc.documentElement.clientWidth - width - 8));
        el.setCssProps({ left: `${left}px`, top: `${rect.bottom + 6}px` });
    };
    place();
    doc.addEventListener('mousedown', onDown, true);
    doc.addEventListener('keydown', onKey, true);
    anchor.setAttribute('aria-expanded', 'true');
    closeOpen = close;
    return close;
}


function pad(n: number): string {
    return String(n).padStart(2, '0');
}

/** A month calendar under a date pill; `value` and the picked date are YYYY-MM-DD. */
export function openDatePicker(anchor: HTMLElement, value: string, onPick: (date: string) => void) {
    const [y, m, d] = value.split('-').map(Number);
    const valid = !!y && !!m && !!d;
    const today = new Date();
    openPopover(anchor, 'aa-date-pop', (el, close) => {
        const fill = (year: number, month: number) => {
            el.empty();
            const head = el.createDiv({ cls: 'ap-popover-head' });
            const back = head.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': tr('Previous month', '上个月') } });
            setIcon(back, 'chevron-left');
            head.createSpan({ text: isZh() ? `${year} 年 ${month + 1} 月` : new Date(year, month, 1).toLocaleDateString('en', { year: 'numeric', month: 'long' }) });
            const forward = head.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': tr('Next month', '下个月') } });
            setIcon(forward, 'chevron-right');
            back.onclick = () => (month === 0 ? fill(year - 1, 11) : fill(year, month - 1));
            forward.onclick = () => (month === 11 ? fill(year + 1, 0) : fill(year, month + 1));
            const grid = el.createDiv({ cls: 'ap-month-grid aa-day-grid' });
            (isZh() ? ['一', '二', '三', '四', '五', '六', '日'] : ['M', 'T', 'W', 'T', 'F', 'S', 'S']).forEach(name => grid.createSpan({ cls: 'ap-cap', text: name }));
            for (let i = 0; i < (new Date(year, month, 1).getDay() + 6) % 7; i++) grid.createSpan();
            const days = new Date(year, month + 1, 0).getDate();
            for (let day = 1; day <= days; day++) {
                const btn = grid.createEl('button', { text: String(day) });
                btn.toggleClass('is-selected', valid && year === y && month === m - 1 && day === d);
                btn.toggleClass('is-today', year === today.getFullYear() && month === today.getMonth() && day === today.getDate());
                btn.onclick = () => { close(); onPick(`${year}-${pad(month + 1)}-${pad(day)}`); };
            }
        };
        fill(valid ? y : today.getFullYear(), valid ? m - 1 : today.getMonth());
    });
}
