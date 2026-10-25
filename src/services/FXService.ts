import { requestUrl, App } from 'obsidian';

export interface ExchangeRateResponse {
    amount: number;
    base: string;
    date: string;
    rates: Record<string, number>;
}

export class FXService {
    private cache: Map<string, { rate: number; timestamp: number }> = new Map();
    private CACHE_DURATION = 1000 * 60 * 60 * 24; // 24 hours
    private CACHE_FILE: string;

    constructor(private app: App, pluginDir: string) {
        this.CACHE_FILE = `${pluginDir}/rates_cache.json`;
        this.ready = this.loadCache();
    }

    private ready: Promise<void>;

    private async loadCache() {
        if (await this.app.vault.adapter.exists(this.CACHE_FILE)) {
            try {
                const data = await this.app.vault.adapter.read(this.CACHE_FILE);
                const json = JSON.parse(data);
                this.cache = new Map(Object.entries(json));
            } catch (e) {
                console.error('Failed to load FX cache', e);
            }
        }
    }

    private async saveCache() {
        try {
            const obj = Object.fromEntries(this.cache);
            await this.app.vault.adapter.write(this.CACHE_FILE, JSON.stringify(obj));
        } catch (e) {
            console.error('Failed to save FX cache', e);
        }
    }

    async getExchangeRate(from: string, to: string, date?: string): Promise<number> {
        await this.ready;
        if (from === to) return 1.0;

        const cacheKey = `${from}_${to}_${date || 'latest'}`;
        const cached = this.cache.get(cacheKey);

        // For historical dates (date defined), cache is valid forever (unless we want to support corrections)
        // For 'latest', respect CACHE_DURATION
        const isHistorical = !!date;
        const isValid = cached && (isHistorical || (Date.now() - cached.timestamp < this.CACHE_DURATION));

        if (isValid) {
            return cached!.rate;
        }

        try {
            const datePath = date ? date : 'latest';
            const url = `https://api.frankfurter.app/${datePath}?from=${from}&to=${to}`;
            const response = await requestUrl({ url });

            if (response.status !== 200) {
                throw new Error(`Failed to fetch exchange rate: ${response.status}`);
            }

            const data = response.json as ExchangeRateResponse;
            const rate = data.rates[to];

            if (rate) {
                this.cache.set(cacheKey, { rate, timestamp: Date.now() });
                void this.saveCache(); // Fire and forget
                return rate;
            } else {
                throw new Error(`Rate not found for ${to}`);
            }
        } catch (error) {
            console.error('FXService Error:', error);
            // Fallback to cache if available even if expired
            if (cached) return cached.rate;
            throw error;
        }
    }

    async convert(amount: number, from: string, to: string, date?: string): Promise<number> {
        const rate = await this.getExchangeRate(from, to, date);
        return amount * rate;
    }
}
