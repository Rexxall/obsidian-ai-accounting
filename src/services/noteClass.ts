/** Adds a class to a note's cssclasses, keeping the ones already there; the old `cssclass` field becomes `cssclasses`. */
export function withCssClass(fm: Record<string, unknown>, cssClass: string | undefined): void {
	const name = (cssClass ?? '').trim();
	if (!/^[A-Za-z][\w-]*$/.test(name)) return;
	const raw = fm.cssclasses ?? fm.cssclass;
	const list = (Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[\s,]+/) : [])
		.map(value => String(value).trim())
		.filter(Boolean);
	if (!list.includes(name)) list.push(name);
	delete fm.cssclass;
	fm.cssclasses = list;
}
