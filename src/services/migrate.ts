import type { AccountingSettings, AiService } from '../settings';
import { getProvider, migrateKey, resolveProvider, slotFromEndpoint, type KeyStore } from '../vendor/rex-ai-kit/index';

/** Fields of versions before 0.9.0, read only here. */
interface LegacyAi {
    aiProvider?: 'gemini' | 'openai';
    geminiSecretName?: string;
    geminiApiKey?: string;
    geminiModel?: string;
    openaiApiKey?: string;
    openaiModel?: string;
    openaiEndpoint?: string;
    /** 0.2.x to 0.8.x: one entry per service, address and model typed in by hand. */
    apiEndpoints?: LegacyEndpoint[];
}

interface LegacyEndpoint {
    id: string;
    name: string;
    provider?: string;
    endpoint: string;
    apiKey?: string;
    apiKeySecret?: string;
    model: string;
    enabled: boolean;
    vision?: boolean;
}

const LEGACY_FIELDS: (keyof LegacyAi)[] = ['aiProvider', 'geminiSecretName', 'geminiApiKey', 'geminiModel', 'openaiApiKey', 'openaiModel', 'openaiEndpoint', 'apiEndpoints'];

/** A service right after migration: a key still in plain text waits here until {@link moveKeys} stores it. */
export type MigratedService = AiService & { plainKey?: string };

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * Settings from any earlier version (0.2.x onward), brought to the current shape. Pure, so it can be
 * tested without Obsidian; plain-text keys are moved to the Keychain afterwards by {@link moveKeys}.
 */
export function migrateSettings(raw: unknown, defaults: AccountingSettings): AccountingSettings {
    const input = raw && typeof raw === 'object' ? raw as Partial<AccountingSettings> & LegacyAi : {};
    const s = { ...defaults, ...input } as AccountingSettings & LegacyAi;
    s.users = Array.isArray(input.users) ? input.users.map(user => ({ ...user })) : defaults.users.map(user => ({ ...user }));
    s.recurring = Array.isArray(input.recurring) ? input.recurring.map(item => ({ ...item })) : [];
    s.drafts = Array.isArray(input.drafts) ? input.drafts.map(draft => ({ ...draft, rows: draft.rows.map(row => ({ ...row })) })) : [];
    if (typeof s.budgetText !== 'string') s.budgetText = '';

    if (Array.isArray(input.aiServices)) {
        s.aiServices = input.aiServices.map(svc => ({ ...svc, ai: { ...svc.ai } }));
    } else {
        s.aiServices = legacyEndpoints(input).map(toService);
    }
    for (const field of LEGACY_FIELDS) delete s[field];
    return s;
}

/** Every service the old settings knew, in order, as the 0.8 list had them. */
function legacyEndpoints(input: LegacyAi): LegacyEndpoint[] {
    const endpoints: LegacyEndpoint[] = (Array.isArray(input.apiEndpoints) ? input.apiEndpoints : []).map(ep => ({ ...ep }));
    const legacyEndpoint = input.openaiEndpoint || 'https://api.openai.com/v1';
    const legacy = (id: string, enabled: boolean): LegacyEndpoint => ({
        id, name: 'OpenAI', endpoint: legacyEndpoint, apiKey: input.openaiApiKey || '', model: input.openaiModel || 'gpt-4o', enabled, vision: true
    });
    // The single OpenAI setting from early versions becomes an entry, so its key is never left in plain text.
    // When a list already exists, the old key was not in use: keep it off unless the list has the same key.
    if (input.openaiApiKey) {
        if (endpoints.length === 0) endpoints.push(legacy('migrated-default', input.aiProvider !== 'gemini'));
        else if (!endpoints.some(ep => ep.apiKey === input.openaiApiKey)) endpoints.push(legacy('migrated-legacy', false));
    }
    // Gemini had its own fields. It goes first when it was the chosen service, otherwise it is kept off.
    const hasGemini = !!(input.geminiSecretName || input.geminiApiKey);
    if (hasGemini && !endpoints.some(ep => slotFromEndpoint({ url: ep.endpoint, provider: ep.provider }).provider === 'gemini')) {
        const entry: LegacyEndpoint = {
            id: 'migrated-gemini', name: 'Google Gemini', provider: 'gemini', endpoint: GEMINI_BASE, apiKey: input.geminiApiKey || '',
            apiKeySecret: input.geminiSecretName || undefined, model: !input.geminiModel || input.geminiModel === 'gemini-1.5-flash' ? '' : input.geminiModel,
            enabled: input.aiProvider !== 'openai', vision: true
        };
        if (input.aiProvider === 'openai') endpoints.push(entry); else endpoints.unshift(entry);
    }
    return endpoints;
}

/** One old entry as a slot: the service from its address, the old Keychain name kept so nothing has to be re-entered. */
function toService(ep: LegacyEndpoint): MigratedService {
    const ai = slotFromEndpoint({ url: ep.endpoint, provider: ep.provider, model: ep.model, secretName: ep.apiKeySecret });
    const provider = getProvider(ai.provider);
    if (!ai.model) ai.model = provider?.picks[0]?.id ?? '';
    // A name the user gave is kept; an old default ("Deepseek", "OpenAI") follows the service instead.
    const lower = (ep.name || '').trim().toLowerCase();
    const named = lower && lower !== provider?.name.toLowerCase() && lower !== ai.provider ? ep.name.trim() : '';
    const svc: MigratedService = { id: ep.id, name: named, enabled: ep.enabled, vision: !provider?.localAgent && (ep.vision ?? true), ai };
    if (ep.apiKey && !ep.apiKeySecret) svc.plainKey = ep.apiKey;
    return svc;
}

/**
 * Plain-text keys move into the Keychain under the shared name (`openai-api-key` …), or a name of the
 * plugin's own when another plugin keeps a different key there. A saved Keychain name that holds nothing,
 * while the shared name does, is dropped so the shared key is used. Returns true when anything changed.
 */
export function moveKeys(services: MigratedService[], store: Required<Pick<KeyStore, 'getSecret' | 'setSecret'>>): boolean {
    let changed = false;
    for (const svc of services) {
        const shared = resolveProvider({ provider: svc.ai.provider }).secretName;
        if (svc.plainKey !== undefined) {
            if (svc.plainKey.trim() && shared) {
                const name = migrateKey(store, shared, svc.plainKey, 'ai-accounting');
                if (name === shared) delete svc.ai.secretName;
                else svc.ai.secretName = name;
            }
            delete svc.plainKey;
            changed = true;
        }
        const own = svc.ai.secretName;
        if (own && shared && !read(store, own) && read(store, shared)) {
            delete svc.ai.secretName;
            changed = true;
        }
    }
    return changed;
}

function read(store: Pick<KeyStore, 'getSecret'>, name: string): string {
    try {
        return store.getSecret(name)?.trim() ?? '';
    } catch {
        return '';
    }
}
