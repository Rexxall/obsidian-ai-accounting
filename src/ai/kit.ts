import { Platform, requestUrl } from 'obsidian';
import { AiClient, AiError, ModelCache, explainError, getProvider, nodeCliRunner, requestUrlTransport, type KeyStore, type Lang, type ModelCacheData } from '../vendor/rex-ai-kit/index';
import { isZh } from '../i18n';

/** The plugin speaks Chinese or English; the shared AI settings follow the same choice. */
export function aiLang(): Lang {
    return isZh() ? 'zh' : 'en';
}

/** Nothing here touches the network; requests start only from a user action. */
export function createAiClient(keys: KeyStore, cache: ModelCacheData | undefined): AiClient {
    return new AiClient({
        keys,
        transport: requestUrlTransport(requestUrl),
        cache: new ModelCache(cache),
        cli: Platform.isDesktopApp ? nodeCliRunner() : undefined,
        lang: aiLang(),
    });
}

/** Claude Code and Codex on this computer read text only. */
export function isLocalAgent(provider: string): boolean {
    return !!getProvider(provider)?.localAgent;
}

/** Why a request failed and what to do next, in the plugin's language. */
export function describeAiError(error: unknown): string {
    return explainError(error, aiLang());
}

export { AiError };
