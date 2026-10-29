import { requestUrl } from 'obsidian';
import { tr } from '../i18n';

/**
 * AI services the plugin can call. Everything except Gemini speaks the OpenAI chat format.
 * Model names change often, so the presets are only a starting point; the settings can
 * fetch the service's own model list.
 */
export type ProviderId = 'deepseek' | 'qwen' | 'siliconflow' | 'kimi' | 'zhipu' | 'gemini' | 'openai' | 'custom';

export interface ProviderPreset {
    id: ProviderId;
    name: string;
    baseUrl: string;
    model: string;
    /** Whether the preset model reads images. */
    vision: boolean;
    /** Where to get a key. */
    keyUrl: string;
    /** Local servers and proxies may not need a key. */
    keyOptional?: boolean;
}

export function presets(): ProviderPreset[] {
    return [
        { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', vision: true, keyUrl: 'https://platform.deepseek.com/api_keys' },
        { id: 'qwen', name: tr('Qwen (Alibaba Model Studio)', '通义千问（阿里云百炼）'), baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-vl-plus', vision: true, keyUrl: 'https://bailian.console.aliyun.com/' },
        { id: 'siliconflow', name: tr('SiliconFlow', '硅基流动'), baseUrl: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-VL-72B-Instruct', vision: true, keyUrl: 'https://cloud.siliconflow.cn/account/ak' },
        { id: 'kimi', name: 'Kimi', baseUrl: 'https://api.moonshot.cn/v1', model: 'kimi-k3.1-pro', vision: true, keyUrl: 'https://platform.kimi.com/' },
        { id: 'zhipu', name: tr('Zhipu GLM', '智谱 GLM'), baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-5.3-flash', vision: true, keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys' },
        { id: 'gemini', name: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.5-flash', vision: true, keyUrl: 'https://aistudio.google.com/apikey' },
        { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', vision: true, keyUrl: 'https://platform.openai.com/api-keys' },
        { id: 'custom', name: tr('Other (OpenAI-compatible, local or proxy)', '其他（OpenAI 兼容、本地或代理）'), baseUrl: 'http://localhost:11434/v1', model: '', vision: false, keyUrl: '', keyOptional: true }
    ];
}

export const DEFAULT_PROVIDER: ProviderId = 'deepseek';

export function presetFor(id: string | undefined): ProviderPreset {
    const all = presets();
    return all.find(p => p.id === id) ?? all.find(p => p.id === 'custom')!;
}

/** Works out the service from an address saved by an older version. */
export function guessProvider(baseUrl: string): ProviderId {
    const host = hostOf(baseUrl);
    if (host.endsWith('deepseek.com')) return 'deepseek';
    if (host.endsWith('dashscope.aliyuncs.com') || host.endsWith('maas.aliyuncs.com')) return 'qwen';
    if (host.includes('siliconflow')) return 'siliconflow';
    if (host.includes('moonshot') || host.endsWith('kimi.com')) return 'kimi';
    if (host.endsWith('bigmodel.cn')) return 'zhipu';
    if (host === 'generativelanguage.googleapis.com' && !baseUrl.includes('/openai')) return 'gemini';
    if (host === 'api.openai.com') return 'openai';
    return 'custom';
}

function hostOf(url: string): string {
    try { return new URL(url).host.toLowerCase(); } catch { return ''; }
}

export interface AiTarget {
    provider: ProviderId;
    baseUrl: string;
    model: string;
    apiKey: string;
}

export type FailureKind = 'no-key' | 'auth' | 'quota' | 'rate' | 'model' | 'timeout' | 'network' | 'bad-reply' | 'cancelled' | 'http';

export class AiError extends Error {
    constructor(public kind: FailureKind, public status: number | undefined, public detail: string, public step: 'models' | 'chat') {
        super(describeFailure(kind, status));
        this.name = 'AiError';
    }
}

/** One plain sentence per kind of failure, with what to do about it. */
export function describeFailure(kind: FailureKind, status?: number): string {
    switch (kind) {
        case 'no-key': return tr('No API key yet.', '还没有填 API 密钥。');
        case 'auth': return tr('The service rejected the key (401/403). Check that the key is right and belongs to this service and region.', '服务商拒绝了这个密钥（401/403）。请核对密钥是否正确、是否属于这家服务商和这个地区。');
        case 'quota': return tr('The account is out of balance or quota. Top up or switch to another service.', '账户余额或额度不足。请充值，或换一家服务。');
        case 'rate': return tr('Too many requests right now (429). Wait a moment and retry.', '请求太频繁（429），稍等一会儿再试。');
        case 'model': return tr('This model does not exist or the key cannot use it. Pick one from the model list.', '这个模型不存在，或这个密钥不能用它。请从模型列表里选一个。');
        case 'timeout': return tr('No reply in time. The service may be busy; retry, or check the address and your network.', '等了很久没有回复。服务可能繁忙，可以重试，或检查地址和网络。');
        case 'network': return tr('Could not reach the service. Check the address and your network.', '连不上服务。请检查地址和网络。');
        case 'bad-reply': return tr('The service replied, but not in a form the plugin can read. Try another model.', '服务有回复，但格式读不出来。可以换一个模型试试。');
        case 'cancelled': return tr('Cancelled.', '已取消。');
        default: return tr(`The service returned an error (HTTP ${status ?? '?'}).`, `服务返回错误（HTTP ${status ?? '?'}）。`);
    }
}

const QUOTA_WORDS = /insufficient|balance|quota|billing|arrearage|exceeded your current|credit|余额|额度|欠费/i;
const MODEL_WORDS = /model/i;
const MISSING_WORDS = /not.?exist|not.?found|does not exist|invalid model|unknown model|no such|不存在|无效/i;

export function classify(status: number, body: string): FailureKind {
    if (status === 401 || status === 403) return QUOTA_WORDS.test(body) ? 'quota' : 'auth';
    if (status === 402) return 'quota';
    if (status === 429) return QUOTA_WORDS.test(body) ? 'quota' : 'rate';
    if (status === 404) return 'model';
    if ((status === 400 || status === 422) && MODEL_WORDS.test(body) && MISSING_WORDS.test(body)) return 'model';
    if (status === 400 && /api.?key/i.test(body)) return 'auth';
    if (status === 408 || status === 504) return 'timeout';
    return 'http';
}

/** Removes keys and anything that looks like one, and keeps it short. */
export function redact(text: string, secrets: string[] = []): string {
    let out = text;
    for (const secret of secrets) if (secret && secret.length >= 6) out = out.split(secret).join('[key]');
    out = out
        .replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [key]')
        .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[key]')
        .replace(/\bAIza[A-Za-z0-9_-]{20,}/g, '[key]')
        .replace(/([?&](?:key|api_key|token)=)[^&\s]+/gi, '$1[key]');
    return out.length > 300 ? `${out.slice(0, 300)}…` : out;
}

export interface CancelToken {
    cancelled: boolean;
}

function trimBase(url: string): string {
    return url.trim().replace(/\/+$/, '');
}

async function send(step: 'models' | 'chat', target: AiTarget, request: { url: string; method: string; headers: Record<string, string>; body?: string }, timeoutMs: number, token?: CancelToken) {
    let timer = 0;
    const timeout = new Promise<never>((_, reject) => {
        timer = window.setTimeout(() => reject(new AiError('timeout', undefined, '', step)), timeoutMs);
    });
    try {
        const response = await Promise.race([requestUrl({ ...request, throw: false }), timeout]);
        if (token?.cancelled) throw new AiError('cancelled', undefined, '', step);
        if (response.status >= 400) {
            let body = '';
            try { body = response.text ?? ''; } catch { body = ''; }
            throw new AiError(classify(response.status, body), response.status, redact(body, [target.apiKey]), step);
        }
        return response;
    } catch (error) {
        if (error instanceof AiError) throw error;
        if (token?.cancelled) throw new AiError('cancelled', undefined, '', step);
        throw new AiError('network', undefined, redact(error instanceof Error ? error.message : String(error), [target.apiKey]), step);
    } finally {
        window.clearTimeout(timer);
    }
}

function needsKey(target: AiTarget): boolean {
    return !target.apiKey && !presetFor(target.provider).keyOptional;
}

/** Free: lists the models the key can use. */
export async function listModels(target: AiTarget, timeoutMs = 15000): Promise<string[]> {
    if (needsKey(target)) throw new AiError('no-key', undefined, '', 'models');
    const base = trimBase(target.baseUrl);
    if (target.provider === 'gemini') {
        const response = await send('models', target, { url: `${base}/models?pageSize=1000`, method: 'GET', headers: { 'x-goog-api-key': target.apiKey } }, timeoutMs);
        const models = (response.json as { models?: { name?: string; supportedGenerationMethods?: string[] }[] }).models ?? [];
        return models.filter(m => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent'))
            .map(m => (m.name ?? '').replace(/^models\//, '')).filter(Boolean);
    }
    const headers: Record<string, string> = target.apiKey ? { Authorization: `Bearer ${target.apiKey}` } : {};
    const response = await send('models', target, { url: `${base}/models`, method: 'GET', headers }, timeoutMs);
    const data = (response.json as { data?: { id?: string }[] }).data ?? [];
    return data.map(m => m.id ?? '').filter(Boolean).sort();
}

export interface ChatInput {
    prompt: string;
    /** Base64 image data, without the data: prefix. */
    image?: { data: string; mimeType: string };
    json?: boolean;
    maxTokens?: number;
}

/** Sends one request and returns the model's text. Throws AiError. */
export async function chat(target: AiTarget, input: ChatInput, timeoutMs = 90000, token?: CancelToken): Promise<string> {
    if (needsKey(target)) throw new AiError('no-key', undefined, '', 'chat');
    if (!target.model) throw new AiError('model', undefined, '', 'chat');
    const base = trimBase(target.baseUrl);
    if (target.provider === 'gemini') {
        const parts: ({ text: string } | { inlineData: { mimeType: string; data: string } })[] = [{ text: input.prompt }];
        if (input.image) parts.unshift({ inlineData: { mimeType: input.image.mimeType, data: input.image.data } });
        const generationConfig: Record<string, unknown> = { temperature: 0.1 };
        if (input.json) generationConfig.responseMimeType = 'application/json';
        if (input.maxTokens) generationConfig.maxOutputTokens = input.maxTokens;
        const response = await send('chat', target, {
            url: `${base}/models/${encodeURIComponent(target.model)}:generateContent`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': target.apiKey },
            body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig })
        }, timeoutMs, token);
        const body = response.json as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
        const text = (body.candidates?.[0]?.content?.parts ?? []).map(p => p.text ?? '').join('');
        if (!text && !input.maxTokens) throw new AiError('bad-reply', response.status, '', 'chat');
        return text;
    }
    const content: ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } })[] = [{ type: 'text', text: input.prompt }];
    if (input.image) content.push({ type: 'image_url', image_url: { url: `data:${input.image.mimeType};base64,${input.image.data}` } });
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (target.apiKey) headers.Authorization = `Bearer ${target.apiKey}`;
    const payload: Record<string, unknown> = { model: target.model, messages: [{ role: 'user', content: input.image ? content : input.prompt }], temperature: 0.1 };
    if (input.maxTokens) payload.max_tokens = input.maxTokens;
    const post = (body: Record<string, unknown>) => send('chat', target, { url: `${base}/chat/completions`, method: 'POST', headers, body: JSON.stringify(body) }, timeoutMs, token);
    let response;
    try {
        response = await post(input.json ? { ...payload, response_format: { type: 'json_object' } } : payload);
    } catch (error) {
        // Some models refuse the JSON switch; the prompt asks for JSON anyway.
        if (input.json && error instanceof AiError && error.status === 400 && /response_format|json/i.test(error.detail)) response = await post(payload);
        else throw error;
    }
    const body = response.json as { choices?: { message?: { content?: string } }[] };
    const text = body.choices?.[0]?.message?.content ?? '';
    if (!text && !input.maxTokens) throw new AiError('bad-reply', response.status, '', 'chat');
    return text;
}

/** Strips code fences and pulls the first JSON array out of a reply. */
export function parseJsonArray(reply: string): unknown[] {
    const cleaned = reply.replace(/```(?:json)?/g, '').trim();
    let parsed: unknown;
    try { parsed = JSON.parse(cleaned); } catch { throw new AiError('bad-reply', undefined, '', 'chat'); }
    if (Array.isArray(parsed)) return parsed as unknown[];
    if (parsed && typeof parsed === 'object') {
        const inner = Object.values(parsed).find((v): v is unknown[] => Array.isArray(v));
        return inner ?? [parsed];
    }
    throw new AiError('bad-reply', undefined, '', 'chat');
}

export interface TestResult {
    ok: boolean;
    message: string;
    /** Safe to share: no key and no note content. */
    diagnostics: string;
    models?: string[];
}

/**
 * Checks a service in two steps: the model list (free), then one very short request,
 * which the service bills at a few tokens.
 */
export async function testConnection(target: AiTarget, pluginLabel: string): Promise<TestResult> {
    const lines = [
        `${pluginLabel}`,
        `Service: ${presetFor(target.provider).id}`,
        `Address: ${redact(trimBase(target.baseUrl), [target.apiKey])}`,
        `Model: ${target.model || '(empty)'}`,
        `Key: ${target.apiKey ? 'set' : 'empty'}`,
        `Time: ${new Date().toISOString()}`
    ];
    const fail = (error: unknown): TestResult => {
        const e = error instanceof AiError ? error : new AiError('network', undefined, redact(String(error), [target.apiKey]), 'chat');
        lines.push(`Step: ${e.step}`, `Result: ${e.kind}${e.status ? ` (HTTP ${e.status})` : ''}`);
        if (e.detail) lines.push(`Service said: ${e.detail}`);
        return { ok: false, message: e.message, diagnostics: lines.join('\n') };
    };
    let models: string[] | undefined;
    try {
        models = await listModels(target);
    } catch (error) {
        // Some proxies do not offer a model list; only stop on errors that a chat request would also hit.
        if (!(error instanceof AiError) || ['no-key', 'auth', 'quota', 'network', 'timeout'].includes(error.kind)) return fail(error);
        lines.push(`Model list: unavailable (${error.kind}${error.status ? ` ${error.status}` : ''})`);
    }
    if (models) {
        lines.push(`Model list: ${models.length} models`);
        if (target.model && models.length > 0 && !models.includes(target.model)) {
            lines.push('Result: model (not in list)');
            return { ok: false, message: describeFailure('model'), diagnostics: lines.join('\n'), models };
        }
    }
    try {
        await chat(target, { prompt: 'Reply with: ok', maxTokens: 5 }, 20000);
    } catch (error) {
        return { ...fail(error), models };
    }
    lines.push('Result: ok');
    return { ok: true, message: tr('Connected. The key and model work.', '连接成功，密钥和模型都能用。'), diagnostics: lines.join('\n'), models };
}

export const TEST_COST_NOTE = () => tr(
    'Checks the model list (free), then sends one very short request of a few tokens, billed by the service at well under one cent.',
    '先查模型列表（免费），再发一条只有几个词的请求，由服务商按用量计费，通常不到一分钱。'
);

/** A short name for progress messages: the service, or the host for a custom address. */
export function serviceLabel(target: AiTarget): string {
    const preset = presetFor(target.provider);
    return preset.id === 'custom' ? hostOf(target.baseUrl) || preset.name : preset.name;
}
