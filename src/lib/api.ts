// Typed client for the Go backend (/workspace/calorie-tracker). With no
// EXPO_PUBLIC_API_URL it runs in MOCK mode: parse is answered locally by the
// TS parser and writes resolve immediately (data stays on the device).
import { DISH_TABLE_VERSION } from '../parser';
import { config } from './config';
import type { FoodEntry } from './domain';

export * from './parseLocal';
import { ItemIn, ParseResponse, parseLocal } from './parseLocal';
/** Flip on when API.md's create-entry contract gains client_id, dish_table_version, carbs_g, fat_g (another worker is adding them). */
export const ENTRY_EXTRA_FIELDS = false;

export class ApiError extends Error { constructor(public status: number, msg: string) { super(msg); } }

export function createApi(getToken: () => string | null) {
  async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const tok = getToken();
    const res = await fetch(config.apiUrl + path, {
      method, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new ApiError(res.status, await res.text());
    return (res.status === 204 ? undefined : await res.json()) as T;
  }
  return {
    mock: config.mock,
    /** Online: table + Gemini fallback (AI items come back with ai_estimate=true). */
    async parse(text: string, useAI = true): Promise<ParseResponse> {
      if (config.mock) {
        const r = parseLocal(text);
        return { ...r, fallback: r.unmatched.length ? 'not_configured' : 'none' };
      }
      return req('POST', '/v1/parse', { text, use_ai: useAI });
    },
    async upsertEntry(e: FoodEntry): Promise<void> {
      if (config.mock) return;
      const source = e.source === 'table' || e.source === 'ai' ? (e.source === 'ai' ? 'ai_estimate' : e.item_source ?? 'table') : 'custom';
      const item: ItemIn & Record<string, unknown> = e.dish_id
        ? { dish_id: e.dish_id, qty: e.qty, unit: e.unit, oil_level: e.oil_level, source, confirmed: true }
        : { custom_name: e.custom_name, kcal: e.kcal.best, protein_g: e.protein_g.best, source, confirmed: true };
      if (ENTRY_EXTRA_FIELDS) Object.assign(item, { client_id: e.id, dish_table_version: e.dish_table_version, carbs_g: e.carbs_g, fat_g: e.fat_g });
      await req('POST', '/v1/entries', { local_date: e.local_date, slot: e.slot, text: e.raw_text, items: [item] });
    },
    async deleteEntry(id: string): Promise<void> { if (!config.mock) await req('DELETE', `/v1/entries/${encodeURIComponent(id)}`); },
    async putSteps(local_date: string, steps: number): Promise<void> {
      if (!config.mock) await req('POST', '/v1/activity/steps', { local_date, steps, source: 'health_connect' });
    },
    async putProfile(body: unknown): Promise<void> { if (!config.mock) await req('PUT', '/v1/profile', body); },
    async deleteMe(): Promise<void> { if (!config.mock) await req('DELETE', '/v1/me'); },
  };
}
export type Api = ReturnType<typeof createApi>;
export { DISH_TABLE_VERSION };
