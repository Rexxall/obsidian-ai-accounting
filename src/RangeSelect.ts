import type { Chart, Plugin } from 'chart.js';
import { setIcon } from 'obsidian';
import { compareRange, formatPct, type TrendPoint } from './services/rangeCompare';
import { tr } from './i18n';

export interface RangeSelectOptions {
    /** The card holding the chart; the popover is placed inside it. */
    card: HTMLElement;
    /** The positioned box around the canvas; it takes focus for the keyboard. */
    wrap: HTMLElement;
    points: TrendPoint[];
    unit: 'day' | 'month';
    /** Readable name of a point, e.g. "11 月 3 日" or "2026 年 11 月". */
    label: (key: string) => string;
    /** Amount with its currency. */
    money: (n: number) => string;
    colors: { band: string; edge: string; cursor: string };
    /** Picked keys from the last render, so a redraw keeps the selection. */
    initial?: { a: string; b: string | null } | null;
    onChange?: (picked: { a: string; b: string | null } | null) => void;
}

/**
 * Pick two bars of the trend chart, by click, drag, touch or keyboard, and read how spending changed
 * between them: from → to, the difference, the percentage and the total in between. Esc clears.
 * Uses only the numbers already on the chart.
 */
export class RangeSelect {
    private a: number | null = null;
    private b: number | null = null;
    private cursor: number | null = null;
    private chart: Chart | null = null;
    private pop: HTMLElement;
    private downAt: number | null = null;
    private dragged = false;

    constructor(private o: RangeSelectOptions) {
        const find = (key: string | null | undefined) => (key ? o.points.findIndex(p => p.key === key) : -1);
        const a = find(o.initial?.a);
        if (a >= 0) {
            this.a = a;
            const b = find(o.initial?.b);
            this.b = b >= 0 ? b : null;
        }
        this.pop = o.card.createDiv({ cls: 'aa-range-pop', attr: { role: 'status', 'aria-live': 'polite' } });
        // Right after the chart, so on narrow cards it reads under the bars, above the caption.
        o.wrap.insertAdjacentElement('afterend', this.pop);
        this.pop.hide();
        const unitName = o.unit === 'day' ? tr('day', '日期') : tr('month', '月份');
        o.wrap.setAttrs({
            tabindex: '0',
            role: 'group',
            'aria-label': tr(
                `Spending trend. Left and right arrows move between ${unitName}s, Enter picks the start and then the end, Shift with an arrow stretches the range, Escape clears.`,
                `支出趋势。左右方向键在${unitName}之间移动，回车先定起点再定终点，按住 Shift 加方向键拉长区间，Esc 清除。`
            )
        });
        o.wrap.addClass('aa-range-target');
    }

    /** Draws the picked range behind the bars and the keyboard cursor. Pass it in the chart's plugins. */
    plugin(): Plugin<'bar'> {
        return {
            id: 'aaRangeSelect',
            beforeDatasetsDraw: chart => this.draw(chart),
        };
    }

    attach(chart: Chart): void {
        this.chart = chart;
        const canvas = chart.canvas;
        canvas.addEventListener('pointerdown', this.onDown);
        canvas.addEventListener('pointermove', this.onMove);
        canvas.addEventListener('pointerup', this.onUp);
        canvas.addEventListener('pointercancel', this.onCancel);
        this.o.wrap.addEventListener('keydown', this.onKey);
        this.o.wrap.addEventListener('blur', this.onBlur);
        this.o.wrap.addEventListener('focus', this.onFocus);
        this.show();
    }

    private indexAt(evt: PointerEvent): number | null {
        const chart = this.chart;
        if (!chart || this.o.points.length === 0) return null;
        const rect = chart.canvas.getBoundingClientRect();
        const value = chart.scales.x?.getValueForPixel(evt.clientX - rect.left);
        if (value === undefined || !Number.isFinite(value)) return null;
        return Math.min(this.o.points.length - 1, Math.max(0, Math.round(value)));
    }

    private onDown = (evt: PointerEvent) => {
        if (evt.button !== 0) return;
        const i = this.indexAt(evt);
        if (i === null) return;
        this.downAt = i;
        this.dragged = false;
        this.chart?.canvas.setPointerCapture(evt.pointerId);
    };

    private onMove = (evt: PointerEvent) => {
        if (this.downAt === null) return;
        const i = this.indexAt(evt);
        if (i === null || (i === this.downAt && !this.dragged)) return;
        this.dragged = true;
        this.set(this.downAt, i);
    };

    private onUp = (evt: PointerEvent) => {
        if (this.downAt === null) return;
        const i = this.indexAt(evt) ?? this.downAt;
        if (!this.dragged) this.pick(i);
        this.downAt = null;
        this.dragged = false;
        // The dashed cursor is for the keyboard; a pointer pick hides it.
        this.cursor = null;
        this.chart?.draw();
    };

    private onCancel = () => {
        this.downAt = null;
        this.dragged = false;
    };

    /** Keyboard focus shows where the arrows start. Pointer clicks also focus, so only a :focus-visible focus counts. */
    private onFocus = () => {
        if (!this.o.wrap.matches(':focus-visible') || this.o.points.length === 0) return;
        this.cursor = this.b ?? this.a ?? this.o.points.length - 1;
        this.chart?.draw();
    };

    private onBlur = () => {
        this.cursor = null;
        this.chart?.draw();
    };

    private onKey = (evt: KeyboardEvent) => {
        const n = this.o.points.length;
        if (n === 0) return;
        const at = this.cursor ?? this.b ?? this.a ?? n - 1;
        let next: number | null = null;
        if (evt.key === 'ArrowLeft') next = Math.max(0, at - 1);
        else if (evt.key === 'ArrowRight') next = Math.min(n - 1, at + 1);
        else if (evt.key === 'Home') next = 0;
        else if (evt.key === 'End') next = n - 1;
        if (next !== null) {
            evt.preventDefault();
            this.cursor = next;
            if (evt.shiftKey) this.set(this.a ?? at, next);
            else this.chart?.draw();
            return;
        }
        if (evt.key === 'Enter' || evt.key === ' ') {
            evt.preventDefault();
            this.pick(at);
            this.cursor = at;
        } else if (evt.key === 'Escape' && this.a !== null) {
            evt.preventDefault();
            evt.stopPropagation();
            this.clear();
        }
    };

    /** A click or Enter: the first sets the start, the second the end, the third starts over. */
    private pick(i: number) {
        if (this.a === null || this.b !== null) this.set(i, null);
        else this.set(this.a, i);
    }

    private set(a: number, b: number | null) {
        this.a = a;
        this.b = b;
        this.chart?.draw();
        this.show();
        this.o.onChange?.({ a: this.o.points[a]?.key ?? '', b: b === null ? null : this.o.points[b]?.key ?? null });
    }

    clear() {
        this.a = null;
        this.b = null;
        this.chart?.draw();
        this.show();
        this.o.onChange?.(null);
    }

    private draw(chart: Chart<'bar'> | Chart) {
        const x = chart.scales.x;
        const area = chart.chartArea;
        const n = this.o.points.length;
        if (!x || !area || n < 2) return;
        const half = (area.right - area.left) / n / 2;
        const ctx = chart.ctx;
        ctx.save();
        if (this.a !== null) {
            const lo = Math.min(this.a, this.b ?? this.a);
            const hi = Math.max(this.a, this.b ?? this.a);
            const left = x.getPixelForValue(lo) - half;
            const right = x.getPixelForValue(hi) + half;
            ctx.fillStyle = this.o.colors.band;
            ctx.fillRect(left, area.top, right - left, area.bottom - area.top);
            ctx.strokeStyle = this.o.colors.edge;
            ctx.lineWidth = 1.5;
            for (const edge of this.b === null ? [x.getPixelForValue(this.a)] : [left, right]) {
                ctx.beginPath();
                ctx.moveTo(Math.round(edge) + 0.5, area.top);
                ctx.lineTo(Math.round(edge) + 0.5, area.bottom);
                ctx.stroke();
            }
        }
        if (this.cursor !== null) {
            const cx = Math.round(x.getPixelForValue(this.cursor)) + 0.5;
            ctx.strokeStyle = this.o.colors.cursor;
            ctx.setLineDash([3, 3]);
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(cx, area.top);
            ctx.lineTo(cx, area.bottom);
            ctx.stroke();
        }
        ctx.restore();
    }

    private show() {
        const pop = this.pop;
        pop.empty();
        if (this.a === null) {
            pop.hide();
            return;
        }
        const c = compareRange(this.o.points, this.a, this.b ?? this.a);
        if (!c) {
            pop.hide();
            return;
        }
        const { label, money } = this.o;
        const head = pop.createDiv({ cls: 'aa-range-head' });
        const single = this.b === null || c.count === 1;
        const span = this.o.unit === 'day' ? tr(`${c.count} days`, `${c.count} 天`) : tr(`${c.count} months`, `${c.count} 个月`);
        head.createSpan({ cls: 'aa-range-when', text: single ? label(c.from.key) : `${label(c.from.key)} → ${label(c.to.key)}` });
        if (!single) head.createSpan({ cls: 'aa-range-span', text: span });
        const close = head.createEl('button', { cls: 'clickable-icon aa-range-close', attr: { 'aria-label': tr('Clear the range (Esc)', '清除区间（Esc）') } });
        setIcon(close, 'x');
        close.onclick = () => {
            this.clear();
            this.o.wrap.focus();
        };
        if (single) {
            pop.createDiv({ cls: 'aa-range-value', text: money(c.from.value) });
            const only = this.o.points.length < 2;
            const unit = this.o.unit === 'day' ? tr('day', '天') : tr('month', '个月');
            pop.createDiv({ cls: 'ap-cap', text: only ? tr(`Only one ${unit} so far; there is nothing to compare yet.`, `目前只有一${unit}的数据，还没法对比。`) : tr('Pick another bar to compare.', '再点一根柱子来对比。') });
        } else {
            const sign = c.delta > 0 ? '+' : c.delta < 0 ? '−' : '';
            const change = c.delta === 0 ? tr('no change', '没有变化') : `${sign}${money(Math.abs(c.delta))} · ${c.pct === null ? tr('from 0', '从 0 起') : formatPct(c.pct)}`;
            // Refunds can outweigh spending; then the period is a net refund, said as such.
            const total = c.sum < 0 ? tr(`Net refund ${money(-c.sum)}`, `净退回 ${money(-c.sum)}`) : tr(`Spent ${money(c.sum)}`, `共花 ${money(c.sum)}`);
            if (this.o.unit === 'day') {
                // Day by day, the total is the answer; single days are often 0 in a sparse ledger.
                pop.createDiv({ cls: 'aa-range-delta', text: total });
                pop.createDiv({ cls: 'ap-cap', text: tr(`${money(c.sum / c.count)} a day`, `日均 ${money(c.sum / c.count)}`) });
                if (c.from.value !== 0 || c.to.value !== 0) pop.createDiv({ cls: 'ap-cap', text: `${label(c.from.key)} ${money(c.from.value)} → ${label(c.to.key)} ${money(c.to.value)}（${change}）` });
            } else {
                pop.createDiv({ cls: 'aa-range-value', text: `${money(c.from.value)} → ${money(c.to.value)}` });
                const delta = pop.createDiv({ cls: 'aa-range-delta' });
                if (c.delta === 0) delta.setText(tr('No change', '没有变化'));
                else {
                    delta.createSpan({ text: `${sign}${money(Math.abs(c.delta))}` });
                    delta.createSpan({ cls: 'aa-range-pct', text: c.pct === null ? tr('from 0, no percentage', '从 0 起，没有百分比') : formatPct(c.pct) });
                }
                pop.createDiv({ cls: 'ap-cap', text: tr(`${total} in between`, `这段时间${total}`) });
            }
        }
        pop.show();
    }
}
