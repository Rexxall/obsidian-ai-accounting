import { BasesEntry, BasesPropertyId, BasesViewRegistration, Plugin, parsePropertyId, requireApiVersion } from 'obsidian';

/** Bases views exist from Obsidian 1.10; before that, and while Bases is off, nothing is registered. */
export function basesAvailable(plugin: Plugin): boolean {
	return requireApiVersion('1.10.0') && typeof plugin.registerBasesView === 'function';
}

/**
 * Registers a Bases view. `make` is only called once Bases exists, because the view class extends `BasesView`,
 * which older versions of Obsidian do not have. When Bases is turned off in this vault, it tries again every few
 * seconds and, once registered, reopens any base that is already showing so the new view appears in it.
 */
export function registerBasesViewWhenReady(plugin: Plugin, id: string, make: () => BasesViewRegistration): void {
	if (!basesAvailable(plugin)) return;
	const attempt = (): boolean => {
		try {
			return plugin.registerBasesView(id, make());
		} catch (error) {
			// Registering twice (a quick disable and enable) is not a failure.
			return error instanceof Error && error.message.includes('already');
		}
	};
	if (attempt()) return;
	const timer = window.setInterval(() => {
		if (!attempt()) return;
		window.clearInterval(timer);
		plugin.app.workspace.iterateAllLeaves(leaf => {
			if (leaf.view.getViewType() === 'bases') void leaf.setViewState(leaf.getViewState());
		});
	}, 5000);
	plugin.registerInterval(timer);
}

/**
 * A property's value as written: frontmatter as YAML gave it for note properties, so dates stay strings and numbers
 * stay numbers; the displayed text for file properties and formulas. Null when it is empty.
 */
export function rawValue(plugin: Plugin, entry: BasesEntry, prop: BasesPropertyId): unknown {
	const { type, name } = parsePropertyId(prop);
	if (type === 'note') {
		const value: unknown = plugin.app.metadataCache.getFileCache(entry.file)?.frontmatter?.[name];
		return value === undefined || value === null || value === '' ? null : value;
	}
	const value = entry.getValue(prop);
	const text = value?.toString() ?? '';
	return text === '' || text === 'null' ? null : text;
}
