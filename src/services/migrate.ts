import type { AccountingSettings } from '../settings';

/**
 * Settings from any earlier version (0.2.x onward), brought to the current shape.
 * Pure, so it can be tested without Obsidian; keys are moved to secret storage afterwards.
 */
export function migrateSettings(raw: unknown, defaults: AccountingSettings): AccountingSettings {
    const input = raw && typeof raw === 'object' ? raw as Partial<AccountingSettings> : {};
    const s: AccountingSettings = { ...defaults, ...input };
    s.users = Array.isArray(input.users) ? input.users.map(user => ({ ...user })) : defaults.users.map(user => ({ ...user }));
    s.apiEndpoints = Array.isArray(input.apiEndpoints) ? input.apiEndpoints.map(ep => ({ ...ep })) : [];
    s.recurring = Array.isArray(input.recurring) ? input.recurring.map(item => ({ ...item })) : [];
    if (typeof s.budgetText !== 'string') s.budgetText = '';
    // Gemini 1.5 models were retired; move the old default to the current one.
    if (s.geminiModel === 'gemini-1.5-flash') s.geminiModel = defaults.geminiModel;

    // The single OpenAI setting from early versions becomes an endpoint, so its key is never left in plain text.
    // When an endpoint list already exists, the old key was not in use: keep it as a disabled endpoint
    // unless the list already has the same key.
    if (s.openaiApiKey) {
        if (s.apiEndpoints.length === 0) {
            s.apiEndpoints.push({ id: 'migrated-default', name: 'OpenAI', endpoint: s.openaiEndpoint || 'https://api.openai.com/v1', apiKey: s.openaiApiKey, model: s.openaiModel || 'gpt-4o', enabled: true });
        } else if (!s.apiEndpoints.some(ep => ep.apiKey === s.openaiApiKey)) {
            s.apiEndpoints.push({ id: 'migrated-legacy', name: '旧版单一接口', endpoint: s.openaiEndpoint || 'https://api.openai.com/v1', apiKey: s.openaiApiKey, model: s.openaiModel || 'gpt-4o', enabled: false });
        }
        s.openaiApiKey = '';
    }
    return s;
}
