import type { AccountingSettings, ApiEndpoint } from '../settings';
import { guessProvider, presetFor } from '../ai/providers';

/** Fields of versions before 0.6.0, read only here. */
interface LegacyAi {
    aiProvider?: 'gemini' | 'openai';
    geminiSecretName?: string;
    geminiApiKey?: string;
    geminiModel?: string;
    openaiApiKey?: string;
    openaiModel?: string;
    openaiEndpoint?: string;
}

const LEGACY_FIELDS: (keyof LegacyAi)[] = ['aiProvider', 'geminiSecretName', 'geminiApiKey', 'geminiModel', 'openaiApiKey', 'openaiModel', 'openaiEndpoint'];

/**
 * Settings from any earlier version (0.2.x onward), brought to the current shape.
 * Pure apart from reading the provider presets, so it can be tested without Obsidian;
 * keys are moved to secret storage afterwards.
 */
export function migrateSettings(raw: unknown, defaults: AccountingSettings): AccountingSettings {
    const input = raw && typeof raw === 'object' ? raw as Partial<AccountingSettings> & LegacyAi : {};
    const s = { ...defaults, ...input } as AccountingSettings & LegacyAi;
    s.users = Array.isArray(input.users) ? input.users.map(user => ({ ...user })) : defaults.users.map(user => ({ ...user }));
    s.recurring = Array.isArray(input.recurring) ? input.recurring.map(item => ({ ...item })) : [];
    s.drafts = Array.isArray(input.drafts) ? input.drafts.map(draft => ({ ...draft, rows: draft.rows.map(row => ({ ...row })) })) : [];
    if (typeof s.budgetText !== 'string') s.budgetText = '';

    // Every service is one entry in the list. Older entries were all OpenAI-compatible;
    // the service is worked out from the address, and they keep reading images as before.
    const endpoints: ApiEndpoint[] = (Array.isArray(input.apiEndpoints) ? input.apiEndpoints : []).map(ep => ({
        ...ep,
        provider: ep.provider ?? guessProvider(ep.endpoint || ''),
        vision: ep.vision ?? true
    }));
    const legacyEndpoint = input.openaiEndpoint || 'https://api.openai.com/v1';
    const legacy = (id: string, name: string, enabled: boolean): ApiEndpoint => ({
        id, name, provider: guessProvider(legacyEndpoint), endpoint: legacyEndpoint, apiKey: input.openaiApiKey || '',
        model: input.openaiModel || 'gpt-4o', enabled, vision: true
    });
    // The single OpenAI setting from early versions becomes an entry, so its key is never left in plain text.
    // When a list already exists, the old key was not in use: keep it disabled unless the list has the same key.
    if (input.openaiApiKey) {
        if (endpoints.length === 0) endpoints.push(legacy('migrated-default', 'OpenAI', input.aiProvider !== 'gemini'));
        else if (!endpoints.some(ep => ep.apiKey === input.openaiApiKey)) endpoints.push(legacy('migrated-legacy', 'OpenAI', false));
    }
    // Gemini had its own fields. It goes first when it was the chosen service, otherwise it is kept disabled.
    const hasGemini = !!(input.geminiSecretName || input.geminiApiKey);
    if (hasGemini && !endpoints.some(ep => ep.provider === 'gemini')) {
        const gemini = presetFor('gemini');
        const model = !input.geminiModel || input.geminiModel === 'gemini-1.5-flash' ? gemini.model : input.geminiModel;
        const entry: ApiEndpoint = {
            id: 'migrated-gemini', name: 'Google Gemini', provider: 'gemini', endpoint: gemini.baseUrl, apiKey: input.geminiApiKey || '',
            apiKeySecret: input.geminiSecretName || undefined, model, enabled: input.aiProvider !== 'openai', vision: true
        };
        if (input.aiProvider === 'openai') endpoints.push(entry); else endpoints.unshift(entry);
    }
    s.apiEndpoints = endpoints;
    for (const field of LEGACY_FIELDS) delete s[field];
    return s;
}
