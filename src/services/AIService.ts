import { requestUrl, Notice } from 'obsidian';
import { AccountingSettings } from '../settings';

export interface TransactionData {
    date: string;
    description: string;
    category: string;
    amount: number;
    currency: string;
    paymentMethod?: string;
}

export class AIService {
    private settings: AccountingSettings;

    constructor(settings: AccountingSettings) {
        this.settings = settings;
    }

    async processInput(content: string, isImage: boolean = false): Promise<TransactionData[]> {
        if (this.settings.aiProvider === 'gemini') {
            return this.processGemini(content, isImage);
        } else {
            return this.processOpenAIWithFallback(content, isImage);
        }
    }

    /** AI output is untrusted: only accept plain text or numbers for text fields. */
    private asText(value: unknown, fallback: string): string {
        if (typeof value === 'string') return value;
        if (typeof value === 'number' && Number.isFinite(value)) return String(value);
        return fallback;
    }

    private normalizeDraft(rows: unknown[]): TransactionData[] {
        return rows.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object').map(row => ({
            date: typeof row.date === 'string' ? row.date : '',
            description: this.asText(row.description, ''),
            category: this.asText(row.category, '其他支出 / 一般'),
            amount: row.amount === undefined || row.amount === null || row.amount === '' ? NaN : Number(row.amount),
            currency: this.asText(row.currency, this.settings.defaultInputCurrency).toUpperCase(),
            paymentMethod: this.asText(row.paymentMethod, '未分类')
        }));
    }

    private cleanJSON(text: string): string {
        // Strip markdown code blocks if present
        let cleaned = text.trim();
        if (cleaned.startsWith('```')) {
            cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
        }
        return cleaned.trim();
    }

    private async processGemini(content: string, isImage: boolean): Promise<TransactionData[]> {
        if (!this.settings.geminiApiKey) {
            new Notice('Please configure your Gemini API Key in settings.');
            return [];
        }

        const model = this.settings.geminiModel || 'gemini-1.5-flash';
        // Models usually start with "models/" in some SDKs, but here we use the URL directly
        // Key goes in a header, not the URL, so it never appears in logged URLs or error messages.
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

        const prompt = `Extract transaction details for bookkeeping. 
The input may contain multiple transactions. Return a JSON ARRAY of objects.
Each object must have:
- date: (string, YYYY-MM-DD format, fallback to today's date if missing)
- description: (string, preserve the full description context. 
  
  MERCHANT NAME STANDARDIZATION (when a merchant is mentioned):
  Standardize merchant names to their most recognizable/commonly-used form:
  - "全家" / "FamilyMart" / "familymart" → "FamilyMart"
  - "7-11" / "7-Eleven" / "セブンイレブン" → "7-Eleven"
  - "罗森" / "Lawson" / "ローソン" → "Lawson"
  - "星巴克" / "Starbucks" → "Starbucks"
  - "麦当劳" / "McDonald's" → "McDonald's"
  - "肯德基" / "KFC" → "KFC"
  
  IMPORTANT: Preserve other words in the description (e.g., "FamilyMart买水" not just "FamilyMart").
  Use the most recognizable form (English or Chinese), not necessarily both. Keep it concise)
- category: (string, MUST follow format "Primary / Secondary". 
  Choose Primary from: [餐饮美食, 购物消费, 交通出行, 居家生活, 休闲娱乐, 医疗保健, 金融税务, 其他支出]. 
  Secondary is a specific sub-category. Use merchant/shop names to infer high-precision sub-categories.
  
  IMPORTANT CATEGORY RULES:
  1. Consolidate similar categories - do NOT create near-duplicates (e.g., "家具" and "家具家居" should both be "家具家居")
  2. Use consistent naming - if a subcategory already exists (like "房租"), always use the exact same name
  3. Prefer existing subcategory names over creating new ones when the meaning is similar)
- amount: (number, positive)
- currency: (string, 3-letter code, e.g., CNY, USD, JPY. Default to ${this.settings.defaultInputCurrency} if no currency is mentioned).
- paymentMethod: (string, payment method used.
  
  IMPORTANT PAYMENT METHOD NORMALIZATION:
  1. Match partial names to full names: "EPOS" → "EPOS信用卡", "微信" → "微信零钱", "支付宝" → "支付宝"
  2. Standardize credit card names: Include bank name + "信用卡" (e.g., "招商银行信用卡", "工商银行信用卡")
  3. Common patterns:
     - "现金" for cash
     - "微信零钱" or "微信支付" for WeChat (prefer "微信零钱")
     - "支付宝" for Alipay
     - "[Bank]信用卡" for credit cards (e.g., "EPOS信用卡", "三井住友信用卡")
     - "[Bank]借记卡" for debit cards
  4. If ambiguous or not mentioned, use "未分类").

Return ONLY the JSON array. Do not include markdown code blocks.

Input: ${isImage ? '[An image was provided]' : content}`;

        const body: any = {
            contents: [{
                parts: []
            }],
            generationConfig: {
                responseMimeType: "application/json",
            }
        };

        if (isImage) {
            // content should be base64 string
            body.contents[0].parts.push({
                inlineData: {
                    mimeType: "image/jpeg", // Assuming jpeg for now
                    data: content
                }
            });
            body.contents[0].parts.push({ text: prompt });
        } else {
            body.contents[0].parts.push({ text: prompt + "\n\n" + content });
        }

        try {
            const response = await requestUrl({
                url,
                method: 'POST',
                contentType: 'application/json',
                headers: { 'x-goog-api-key': this.settings.geminiApiKey },
                body: JSON.stringify(body),
                throw: false // Handle status ourselves
            });

            if (response.status !== 200) {
                console.error('Gemini error status:', response.status, response.text);
                if (response.status === 429) {
                    new Notice('Gemini API 频率限制 (429)。请稍后再试或检查额度。');
                } else {
                    new Notice(`Gemini API 错误 (${response.status})。请检查 API Key 或模型名称。`);
                }
                return [];
            }

            const result = response.json;
            const textResponse = this.cleanJSON(result.candidates[0].content.parts[0].text);
            const parsed = JSON.parse(textResponse);
            return this.normalizeDraft(Array.isArray(parsed) ? parsed : [parsed]);
        } catch (error) {
            console.error('Gemini API Error:', error);
            new Notice('Gemini 网络或解析错误，请查看控制台。');
            return [];
        }
    }

    /**
     * 遍历 apiEndpoints 列表，按顺序尝试，一个失败立即切换下一个（Fallback 模式）。
     * 兼容旧的单一 openaiApiKey/openaiEndpoint 配置（当 apiEndpoints 为空时）。
     */
    private async processOpenAIWithFallback(content: string, isImage: boolean): Promise<TransactionData[]> {
        // 构建候选列表：优先使用 apiEndpoints，兼容旧配置
        const candidates = (this.settings.apiEndpoints || []).filter(ep => ep.enabled);

        // 若列表为空，降级到旧的单一 endpoint 配置
        if (candidates.length === 0) {
            if (!this.settings.openaiApiKey && !this.settings.openaiEndpoint) {
                new Notice('请在设置中添加至少一个 API Endpoint。');
                return [];
            }
            candidates.push({
                id: 'legacy',
                name: 'OpenAI (旧配置)',
                endpoint: this.settings.openaiEndpoint || 'https://api.openai.com/v1',
                apiKey: this.settings.openaiApiKey || '',
                model: this.settings.openaiModel || 'gpt-4o',
                enabled: true,
            });
        }

        const errors: string[] = [];

        for (let i = 0; i < candidates.length; i++) {
            const ep = candidates[i]!;
            const isLast = i === candidates.length - 1;
            const label = ep.name || ep.endpoint;


            try {
                const result = await this.processOpenAI(content, isImage, ep);
                if (result.length > 0) {
                    if (i > 0) {
                        new Notice(`✅ 已切换到备用 Endpoint「${label}」并成功`);
                    }
                    return result;
                }
                // 若返回空数组但没抛出异常，视为 API 响应失败，继续尝试下一个
                const msg = `Endpoint「${label}」返回空结果`;
                errors.push(msg);
                console.warn(`[AIService] ${msg}，尝试下一个...`);
                if (!isLast) {
                    new Notice(`⚠️ ${label} 失败，尝试下一个...`, 2000);
                }
            } catch (error) {
                const msg = `Endpoint「${label}」错误: ${(error as Error).message}`;
                errors.push(msg);
                console.warn(`[AIService] ${msg}，尝试下一个...`);
                if (!isLast) {
                    new Notice(`⚠️ ${label} 失败，尝试下一个...`, 2000);
                }
            }
        }

        new Notice(`❌ 所有 Endpoint 均失败（共 ${candidates.length} 个）。请检查配置。`, 5000);
        console.error('[AIService] 所有 Endpoint 均失败:', errors);
        return [];
    }

    private async processOpenAI(content: string, isImage: boolean, ep?: { endpoint: string; apiKey: string; model: string }): Promise<TransactionData[]> {
        // 若传入了 ep 参数则使用它，否则回落到旧 settings 字段（向后兼容）
        let endpointUrl = ep ? ep.endpoint : (this.settings.openaiEndpoint || 'https://api.openai.com/v1');
        const apiKey = ep ? ep.apiKey : this.settings.openaiApiKey;
        const model = ep ? ep.model : (this.settings.openaiModel || 'gpt-4o');

        if (!apiKey) {
            throw new Error('API Key 为空');
        }

        endpointUrl = endpointUrl.trim();
        if (endpointUrl.endsWith('/')) {
            endpointUrl = endpointUrl.slice(0, -1);
        }

        const url = `${endpointUrl}/chat/completions`;

        const messages: any[] = [
            {
                role: "system",
                content: "You are a helpful bookkeeping assistant. Extract transaction data into a JSON array. Return ONLY the JSON. Do not use markdown code blocks."
            },
            {
                role: "user",
                content: []
            }
        ];

        const userContent = messages[1].content;
        const textPrompt = `Extract transaction details for bookkeeping. The input may contain multiple transactions. 
Return a JSON array of objects with keys: date (YYYY-MM-DD), description (preserve full context with standardized merchant names), category, amount (number), currency (3-letter code), paymentMethod (string).

MERCHANT NAME STANDARDIZATION (in description field):
When a merchant is mentioned, standardize to the most recognizable/commonly-used form:
- "全家" / "FamilyMart" → "FamilyMart"
- "7-11" / "セブンイレブン" → "7-Eleven"
- "罗森" / "Lawson" → "Lawson"
- "星巴克" / "Starbucks" → "Starbucks"
- "麦当劳" / "McDonald's" → "McDonald's"
- "肯德基" / "KFC" → "KFC"

IMPORTANT: Preserve other words in description (e.g., "FamilyMart买水" not just "FamilyMart"). Use the most recognizable form (English or Chinese), not necessarily both. Keep descriptions concise.

Category MUST follow "Primary / Secondary" format. Primary categories: [餐饮美食, 购物消费, 交通出行, 居家生活, 休闲娱乐, 医疗保健, 金融税务, 其他支出].

IMPORTANT CATEGORY RULES:
1. Consolidate similar categories - do NOT create near-duplicates (e.g., "家具" and "家具家居" should both be "家具家居")
2. Use consistent naming - if a subcategory already exists (like "房租" or "买菜"), always use the exact same name
3. Prefer existing subcategory names over creating new ones when the meaning is similar

IMPORTANT PAYMENT METHOD NORMALIZATION:
1. Match partial names to full standardized names:
   - "EPOS" → "EPOS信用卡"
   - "微信" → "微信零钱"
   - "支付宝" → "支付宝"
   - "现金" for cash
2. Standardize credit/debit cards: [Bank Name]信用卡 or [Bank Name]借记卡
   Examples: "招商银行信用卡", "工商银行借记卡", "三井住友信用卡"
3. If ambiguous or not mentioned, use "未分类"

If no currency is specified in the input, use ${this.settings.defaultInputCurrency} as the default.`;

        if (isImage) {
            userContent.push({ type: "text", text: textPrompt });
            userContent.push({
                type: "image_url",
                image_url: {
                    url: `data:image/jpeg;base64,${content}`
                }
            });
        } else {
            userContent.push({ type: "text", text: textPrompt + "\n\n" + content });
        }

        const response = await requestUrl({
            url,
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model,
                messages,
                response_format: { type: "json_object" }
            }),
            throw: false
        });

        if (response.status !== 200) {
            const errMsg = `HTTP ${response.status}: ${response.text?.slice(0, 200) || '无响应体'}`;
            console.error('OpenAI error:', errMsg);
            throw new Error(errMsg);
        }

        const result = response.json;
        let textResponse = result.choices[0].message.content;
        textResponse = this.cleanJSON(textResponse);

        const parsed = JSON.parse(textResponse);
        // Some models might wrap the array in a root object like { "transactions": [...] } 
        // if we force response_format: json_object. Let's be flexible.
        if (Array.isArray(parsed)) return this.normalizeDraft(parsed);
        if (typeof parsed === 'object' && parsed !== null) {
            const possibleArray = Object.values(parsed).find(v => Array.isArray(v));
            if (possibleArray) return this.normalizeDraft(possibleArray);
            return this.normalizeDraft([parsed]);
        }
        return [];
    }
}
