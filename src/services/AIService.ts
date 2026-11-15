import { readCategoryReply } from './categorize';
import type { AccountingSettings, AiService } from '../settings';
import { AiError, describeAiError, isLocalAgent } from '../ai/kit';
import type { AiClient, ContentPart } from '../vendor/rex-ai-kit/index';
import { tr } from '../i18n';

/** An image sent with the prompt: base64 data, without the data: prefix. */
export interface ChatImage { data: string; mimeType: string }

export interface TransactionData {
    /** Set for rows whose ID is known in advance, such as recurring expenses. */
    id?: string;
    date: string;
    description: string;
    category: string;
    amount: number;
    currency: string;
    paymentMethod?: string;
}

export interface ProcessHooks {
    signal?: AbortSignal;
    /** Called before each service is tried. */
    onAttempt?: (serviceName: string, index: number, total: number) => void;
}

/** Category for moving money between your own accounts; it is listed but not counted as spending. */
export const TRANSFER_CATEGORY = '转账';

/** One row sent for a category: an index to answer by, and nothing that identifies the payer. */
export interface CategoryQuestion {
    i: number;
    text: string;
    amount: number;
    currency: string;
    /** The statement's own category, if it has one. */
    hint?: string;
}

const PRIMARY_CATEGORIES = ['餐饮美食', '购物消费', '交通出行', '居家生活', '休闲娱乐', '医疗保健', '金融税务', '其他支出', TRANSFER_CATEGORY];

function categoryPrompt(known: string[]): string {
    const listed = known.length ? `\nCategories this person already uses (prefer these, same spelling):\n${known.slice(0, 200).join('\n')}` : '';
    return `Give each bookkeeping row a category "Primary / Secondary".
Primary is one of [${PRIMARY_CATEGORIES.join(', ')}]; Secondary is specific, inferred from the merchant or item.
A negative amount is a refund: use the category of what was bought. "hint" is the bank's or app's own category; use it as a clue only.
Moving money between the person's own accounts (top-ups, withdrawals, card repayments, investments) is "${TRANSFER_CATEGORY} / <what>".${listed}
Return only a JSON object {"rows": [{"i": <row i>, "category": "<Primary / Secondary>"}, …]}, one entry per row, without code fences.`;
}

/** Local agents start a program and are slower to answer than an API. */
const TIMEOUT_MS = 90_000;
const LOCAL_TIMEOUT_MS = 180_000;

export class AIService {
    /** Keys live in Obsidian's Keychain; the client reads them when a request is sent. */
    constructor(private settings: AccountingSettings, private client: AiClient) { }

    /** Enabled services in order; for an image, only those that read images (never a program on this computer). */
    services(isImage: boolean): AiService[] {
        return this.settings.aiServices.filter(svc => svc.enabled && (!isImage || (svc.vision && !isLocalAgent(svc.ai.provider))));
    }

    /** The name shown while waiting: the user's own, or the provider's. */
    label(svc: AiService): string {
        return svc.name || this.client.provider(svc.ai).name;
    }

    private async ask(svc: AiService, prompt: string, images: ChatImage[], signal?: AbortSignal): Promise<unknown[]> {
        const content: ContentPart[] = [{ type: 'text', text: prompt }, ...images.map(image => ({ type: 'image' as const, mime: image.mimeType, data: image.data }))];
        const reply = await this.client.complete(svc.ai, {
            messages: [{ role: 'user', content: images.length ? content : prompt }],
            json: true,
            signal,
            timeoutMs: isLocalAgent(svc.ai.provider) ? LOCAL_TIMEOUT_MS : TIMEOUT_MS,
        });
        return parseJsonArray(reply.text, this.label(svc));
    }

    /**
     * Reads transactions from text, images, or a note with its embedded images. Only services that read
     * images get a request with images. Services are tried in order; a failed one hands over to the next.
     * Throws the last AiError when none works.
     */
    async processInput(text: string, images: ChatImage[] = [], hooks: ProcessHooks = {}): Promise<TransactionData[]> {
        const isImage = images.length > 0;
        const candidates = this.services(isImage);
        if (candidates.length === 0) {
            throw new AiError('No AI service', 'no-key', undefined, isImage && this.services(false).length > 0 ? 'no-vision' : 'no-service');
        }
        const prompt = text.trim() ? `${this.prompt()}\n\nInput${isImage ? ' (the attached images belong to it)' : ''}:\n${text}` : this.prompt();
        let last: AiError | undefined;
        for (const [index, svc] of candidates.entries()) {
            if (hooks.signal?.aborted) throw new AiError('Cancelled', 'aborted');
            hooks.onAttempt?.(this.label(svc), index + 1, candidates.length);
            try {
                return this.normalizeDraft(await this.ask(svc, prompt, images, hooks.signal));
            } catch (error) {
                last = asAiError(error);
                if (last.kind === 'aborted') throw last;
                console.warn(`AI Accounting: service ${index + 1} failed (${last.kind}${last.status ? ` ${last.status}` : ''}).`);
            }
        }
        throw last ?? new AiError('No reply', 'network');
    }

    /**
     * Suggests a category for each row a statement import could not file from the ledger. Only the description,
     * amount, currency and the statement's own category hint are sent, never dates, accounts or order numbers.
     * Text-only request; services are tried in order like {@link processInput}.
     */
    async suggestCategories(items: CategoryQuestion[], known: string[], hooks: ProcessHooks = {}): Promise<Map<number, string>> {
        const candidates = this.services(false);
        if (candidates.length === 0) throw new AiError('No AI service', 'no-key', undefined, 'no-service');
        const result = new Map<number, string>();
        for (let start = 0; start < items.length; start += 80) {
            const batch = items.slice(start, start + 80);
            const asked = new Set(batch.map(item => item.i));
            const prompt = `${categoryPrompt(known)}\n\nRows:\n${JSON.stringify(batch)}`;
            let last: AiError | undefined;
            let done = false;
            for (const [index, svc] of candidates.entries()) {
                if (hooks.signal?.aborted) throw new AiError('Cancelled', 'aborted');
                hooks.onAttempt?.(this.label(svc), index + 1, candidates.length);
                try {
                    for (const [i, category] of readCategoryReply(await this.ask(svc, prompt, [], hooks.signal), asked)) result.set(i, category);
                    done = true;
                    break;
                } catch (error) {
                    last = asAiError(error);
                    if (last.kind === 'aborted') throw last;
                    console.warn(`AI Accounting: service ${index + 1} failed (${last.kind}${last.status ? ` ${last.status}` : ''}).`);
                }
            }
            if (!done) throw last ?? new AiError('No reply', 'network');
        }
        return result;
    }

    /** AI output is untrusted: only accept plain text or numbers for text fields. */
    private asText(value: unknown, fallback: string): string {
        if (typeof value === 'string') return value;
        if (typeof value === 'number' && Number.isFinite(value)) return String(value);
        return fallback;
    }

    normalizeDraft(rows: unknown[]): TransactionData[] {
        return rows.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object').map(row => ({
            date: typeof row.date === 'string' ? row.date : '',
            description: this.asText(row.description, ''),
            category: this.asText(row.category, '其他支出 / 一般'),
            amount: row.amount === undefined || row.amount === null || row.amount === '' ? NaN : Number(row.amount),
            currency: this.asText(row.currency, this.settings.defaultInputCurrency).toUpperCase(),
            paymentMethod: this.asText(row.paymentMethod, '未分类')
        }));
    }

    private prompt(): string {
        const today = new Date();
        const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
        return `Extract transaction details for bookkeeping. The input may contain several transactions.
Each transaction is an object with these keys:
- date: YYYY-MM-DD. Use ${iso} if the input has no date.
- description: keep the full context, with merchant names standardized to their best-known form
  ("全家"/"familymart" → "FamilyMart", "7-11"/"セブンイレブン" → "7-Eleven", "罗森"/"ローソン" → "Lawson",
  "星巴克" → "Starbucks", "麦当劳" → "McDonald's", "肯德基" → "KFC"). Keep the other words, e.g. "FamilyMart买水".
- category: "Primary / Secondary". Primary is one of [餐饮美食, 购物消费, 交通出行, 居家生活, 休闲娱乐, 医疗保健, 金融税务, 其他支出, ${TRANSFER_CATEGORY}].
  Secondary is a specific sub-category inferred from the merchant. Reuse the same names for the same things; do not create near-duplicates.
  Moving money between the payer's own accounts (top-ups, card repayments, ATM withdrawals) is "${TRANSFER_CATEGORY} / <what>".
- amount: a number. Positive for spending. A refund or return is negative, with the category of the original purchase.
- currency: 3-letter code. Use ${this.settings.defaultInputCurrency} if none is given.
- paymentMethod: e.g. 现金, 微信零钱, 支付宝, "<Bank>信用卡", "<Bank>借记卡"; "EPOS" → "EPOS信用卡". Use "未分类" if unknown.
Return only a JSON object {"transactions": [ … ]} holding these objects, without code fences.`;
    }
}

function asAiError(error: unknown): AiError {
    return error instanceof AiError ? error : new AiError(error instanceof Error ? error.message : String(error), 'bad-response');
}

/** Strips code fences and pulls the first JSON array out of a reply, bare or wrapped in an object. */
export function parseJsonArray(reply: string, provider?: string): unknown[] {
    const cleaned = reply.replace(/```(?:json)?/g, '').trim();
    const bad = () => new AiError('Unreadable reply', 'bad-response', undefined, undefined, provider);
    let parsed: unknown;
    try { parsed = JSON.parse(cleaned); } catch { throw bad(); }
    if (Array.isArray(parsed)) return parsed as unknown[];
    if (parsed && typeof parsed === 'object') {
        const inner = Object.values(parsed).find((v): v is unknown[] => Array.isArray(v));
        return inner ?? [parsed];
    }
    throw bad();
}

/** A sentence for a failure, with the next step, including the cases where no service is set up or none reads images. */
export function failureMessage(error: unknown): string {
    if (error instanceof AiError) {
        if (error.detail === 'no-vision') return tr('None of your AI services reads images. Turn on "Reads images" for one that does, or add one in settings.', '没有能识图的 AI 服务。请在设置里给支持图片的服务打开“能识图”，或添加一个。');
        if (error.detail === 'no-service') return tr('No AI service is set up yet. Add one in settings → AI services.', '还没有设置 AI 服务。请到设置 → AI 服务里添加。');
    }
    return describeAiError(error);
}
