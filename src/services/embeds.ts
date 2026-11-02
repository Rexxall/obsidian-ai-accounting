/** Image types the AI services accept, by file extension. */
export const IMAGE_TYPES: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

/** At most this many embedded images go with one note. */
export const MAX_NOTE_IMAGES = 6;

/**
 * Link paths of the images a note embeds, in order and without repeats: `![[receipt.png]]`,
 * `![[receipt.png|300]]` and `![](attachments/receipt%201.png)`. Web images and non-image embeds are skipped.
 * Read from the text itself, because a note that just landed in the inbox is not in Obsidian's index yet.
 */
export function embeddedImageLinks(text: string): string[] {
    const links: string[] = [];
    const add = (raw: string) => {
        const link = raw.trim();
        const ext = link.split('.').pop()?.toLowerCase() ?? '';
        if (!link || /^[a-z]+:\/\//i.test(link) || !(ext in IMAGE_TYPES) || links.includes(link)) return;
        links.push(link);
    };
    for (const match of text.matchAll(/!\[\[([^\]|#^]+)(?:[#^|][^\]]*)?\]\]|!\[[^\]]*\]\(<?([^)>]+?)>?(?:\s+"[^"]*")?\)/g)) {
        if (match[1] !== undefined) {
            add(match[1]);
            continue;
        }
        const raw = match[2] ?? '';
        try { add(decodeURI(raw)); } catch { add(raw); }
    }
    return links;
}
