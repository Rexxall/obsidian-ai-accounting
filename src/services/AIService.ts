import { AccountingSettings, ApiEndpoint } from '../settings';
import { AiError, AiTarget, CancelToken, chat, parseJsonArray, presetFor } from '../ai/providers';
import { tr } from '../i18n';

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
    token?: CancelToken;
    /** Called before each service is tried. */
    onAttempt?: (serviceName: string, index: number, total: number) => void;
}

/** Category for moving money between your own accounts; it is listed but not counted as spending. */
export const TRANSFER_CATEGORY = '转账';

export class AIService {
    /** Keys live in Obsidian's secret storage; settings only hold the secret names. */
    constructor(private settings: AccountingSettings, private getSecret: (name: string) => string = () => '') { }

    /** Enabled services in order; for an image, only those that read images. */
    services(isImage: boolean): ApiEndpoint[] {
        return this.settings.apiEndpoints.filter(ep => ep.enabled && (!isImage || ep.vision));
    }

    private target(ep: ApiEndpoint): AiTarget {
        return { provider: ep.provider, baseUrl: ep.endpoint || presetFor(ep.provider).baseUrl, model: ep.model, apiKey: ep.apiKeySecret ? this.getSecret(ep.apiKeySecret) : ep.apiKey };
    }

    /**
     * Reads transactions from text or an image (base64). Services are tried in order; a failed one
     * hands over to the next. Throws the last AiError when none works.
     */
    async processInput(content: string, isImage = false, mimeType = 'image/jpeg', hooks: ProcessHooks = {}): Promise<TransactionData[]> {
        const candidates = this.services(isImage);
        if (candidates.length === 0) {
            throw new AiError('no-key', undefined, isImage && this.services(false).length > 0 ? 'no-vision' : 'no-service', 'chat');
        }
        let last: AiError | undefined;
        for (const [index, ep] of candidates.entries()) {
            if (hooks.token?.cancelled) throw new AiError('cancelled', undefined, '', 'chat');
            hooks.onAttempt?.(ep.name || presetFor(ep.provider).name, index + 1, candidates.length);
            try {
                const reply = await chat(this.target(ep), {
                    prompt: isImage ? this.prompt() : `${this.prompt()}\n\nInput:\n${content}`,
                    image: isImage ? { data: content, mimeType } : undefined,
                    json: true
                }, 90000, hooks.token);
                return this.normalizeDraft(parseJsonArray(reply));
            } catch (error) {
                last = error instanceof AiError ? error : new AiError('bad-reply', undefined, '', 'chat');
                if (last.kind === 'cancelled') throw last;
                console.warn(`AI Accounting: service ${index + 1} failed (${last.kind}${last.status ? ` ${last.status}` : ''}).`);
            }
        }
        throw last ?? new AiError('network', undefined, '', 'chat');
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
Return a JSON array of objects with these keys:
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
Return only the JSON array, without code fences.`;
    }
}

/** A sentence for a failure, including the cases where no service is set up or none reads images. */
export function failureMessage(error: unknown): string {
    if (error instanceof AiError) {
        if (error.detail === 'no-vision') return tr('None of your AI services reads images. Turn on "Reads images" for one that does, or add one in settings.', '没有能识图的 AI 服务。请在设置里给支持图片的服务打开“能识图”，或添加一个。');
        if (error.detail === 'no-service') return tr('No AI service is set up yet. Add one in settings → AI services.', '还没有设置 AI 服务。请到设置 → AI 服务里添加。');
        return error.message;
    }
    return error instanceof Error ? error.message : String(error);
}
