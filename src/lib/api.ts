// Typed client for the Go backend (/workspace/calorie-tracker). With no
// EXPO_PUBLIC_API_URL it runs in MOCK mode: parse is answered locally by the
// TS parser and writes resolve immediately (data stays on the device).
import { DISH_TABLE_VERSION } from '../parser';
import { config } from './config';
import type { FoodEntry } from './domain';

export * from './parseLocal';
import { ItemIn, ParseResponse, parseLocal } from './parseLocal';
/** Backend learned-readings route. Empty until it appears in API.md; Remembered foods are kept on the device meanwhile. */
export const LEARNED_PATH = '';

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
        if (config.mockAi && r.unmatched.length) {
          // QA only (EXPO_PUBLIC_MOCK_AI=1): fake an AI estimate so the purple AI card can be reviewed without Gemini
          const ai = r.items.filter((i) => i.dish_id === '').map((i) => ({ ...i, source: 'ai_estimate' as const, ai_estimate: true, data_source: 'ai', source_note: 'AI estimate (mock) - confirm before saving' }));
          return { ...r, items: [...r.items.filter((i) => i.dish_id !== ''), ...ai], used_ai: true, fallback: 'used', custom_items: [] };
        }
        return { ...r, fallback: r.unmatched.length ? 'not_configured' : 'none' };
      }
      return req('POST', '/v1/parse', { text, use_ai: useAI });
    },
    /** POST with client_id (idempotent). If the server already has it (an edit), PATCH by client_id. */
    async upsertEntry(e: FoodEntry): Promise<void> {
      if (config.mock) return;
      const source = e.source === 'custom' || e.source === 'manual' ? 'custom' : e.source === 'ai' ? 'ai_estimate' : (e.item_source ?? 'table');
      const nums = { kcal: e.kcal.best, kcal_low: e.kcal.low, kcal_high: e.kcal.high, protein_g: e.protein_g.best, protein_low: e.protein_g.low,
        protein_high: e.protein_g.high, carbs_g: e.carbs_g, fat_g: e.fat_g };
      const item: ItemIn = e.dish_id
        ? { dish_id: e.dish_id, qty: e.qty, unit: e.unit, oil_level: e.oil_level, source, confirmed: true, client_id: e.id, dish_table_version: e.dish_table_version, ...nums }
        : { custom_name: e.custom_name, source, confirmed: true, client_id: e.id, ...nums };
      const r = await req<{ duplicates?: unknown[] }>('POST', '/v1/entries', { local_date: e.local_date, slot: e.slot, text: e.raw_text, items: [item] });
      if (r?.duplicates?.length) {
        // PATCH has no dish_table_version/range fields yet (API.md @ ea9dd85); best + identity only.
        await req('PATCH', `/v1/entries/${encodeURIComponent(e.id)}`, {
          slot: e.slot, local_date: e.local_date, ...(e.dish_id ? { dish_id: e.dish_id, qty: e.qty, unit: e.unit, oil_level: e.oil_level } : { custom_name: e.custom_name }),
          kcal: e.kcal.best, protein_g: e.protein_g.best, if_unmodified_since: e.updated_at,
        });
      }
    },
    /** Remembered foods. The backend's learned-readings endpoint isn't in API.md yet, so these stay local until LEARNED_PATH is confirmed. */
    async putLearned(text: string, reading: unknown): Promise<void> { if (!config.mock && LEARNED_PATH) await req('PUT', `${LEARNED_PATH}/${encodeURIComponent(text)}`, reading); },
    async deleteLearned(text?: string): Promise<void> { if (!config.mock && LEARNED_PATH) await req('DELETE', text ? `${LEARNED_PATH}/${encodeURIComponent(text)}` : LEARNED_PATH); },
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
