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

