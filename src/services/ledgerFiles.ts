/**
 * Monthly ledger and source archive names. A bare "2026-01" collides with monthly notes of the same name,
 * so new files carry a prefix ("账本 2026-01", "Ledger 2026-01"). Files named the old way are still read
 * and written until they are renamed.
 */
export interface LedgerNames {
    /** Prefix of a monthly ledger, e.g. "账本 ". */
    ledger: string;
    /** Prefix of a monthly source archive, e.g. "账本原文 ". */
    archive: string;
}

export function defaultLedgerNames(zh: boolean): LedgerNames {
    return zh ? { ledger: '账本 ', archive: '账本原文 ' } : { ledger: 'Ledger ', archive: 'Ledger sources ' };
}

const MONTH = /^\d{4}-\d{2}$/;

/** The month a file basename stands for, under the given prefix or the old bare name; null otherwise. */
export function monthOf(basename: string, prefix: string): string | null {
    if (MONTH.test(basename)) return basename;
    if (prefix && basename.startsWith(prefix)) {
        const rest = basename.slice(prefix.length);
        if (MONTH.test(rest)) return rest;
    }
    return null;
}

/** Path of the file for a month: the existing one (new name first, then the old bare name), or the new name to create. */
export function monthPath(folder: string, month: string, prefix: string, exists: (path: string) => boolean): string {
    const named = `${folder}/${prefix}${month}.md`;
    const bare = `${folder}/${month}.md`;
    if (exists(named)) return named;
    if (exists(bare)) return bare;
    return named;
}

/**
 * Points links at new names: `[[old]]`, `![[old|alias]]`, `[[old#heading]]`, `[[path/old]]` and `[text](path/old.md)`,
 * where `targets` maps the link path as written (without .md) to its replacement. Anything else is left as it is.
 */
export function rewriteLinkTargets(text: string, targets: Map<string, string>): string {
    const wiki = text.replace(/(!?\[\[)([^\]|#^\n]+)(?=[\]|#^])/g, (whole: string, open: string, target: string) => {
        const key = target.trim().replace(/\.md$/i, '');
        const next = targets.get(key);
        return next === undefined ? whole : `${open}${next}${target.toLowerCase().endsWith('.md') ? '.md' : ''}`;
    });
    return wiki.replace(/(\]\()(<?)([^)>\n]+?)(>?)(\s+"[^"]*")?\)/g, (whole: string, open: string, lt: string, target: string, gt: string, title: string | undefined) => {
        let decoded = target;
        try { decoded = decodeURI(target); } catch { /* keep as written */ }
        const withExt = decoded.toLowerCase().endsWith('.md');
        const next = targets.get(withExt ? decoded.slice(0, -3) : decoded);
        if (next === undefined) return whole;
        const written = `${next}${withExt ? '.md' : ''}`;
        return `${open}${lt}${lt ? written : written.replace(/ /g, '%20')}${gt}${title ?? ''})`;
    });
}
