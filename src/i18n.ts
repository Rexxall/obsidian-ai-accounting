import { getLanguage } from 'obsidian';

/** Follows Settings → General → Language. Currency and time zone never depend on it. */
export function isZh(): boolean {
	return getLanguage().toLowerCase().startsWith('zh');
}

/** The Chinese text when the interface is Chinese, otherwise the English. */
export function tr(en: string, zh: string): string {
	return isZh() ? zh : en;
}
