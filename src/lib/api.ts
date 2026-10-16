// Typed client for the Go backend (/workspace/calorie-tracker). With no
// EXPO_PUBLIC_API_URL it runs in MOCK mode: parse is answered locally by the
// TS parser and writes resolve immediately (data stays on the device).
import { DISH_TABLE_VERSION } from '../parser';
import { config } from './config';
import type { FoodEntry } from './domain';

export * from './parseLocal';
import { ItemIn, ParseResponse, parseLocal } from './parseLocal';
/** GET /v1/remembered row (API.md @ 6986771). */
export interface RememberedRow { id: number; span: string; dish_id: string | null; custom_name: string; qty: number; unit: string; oil_level: string;
  kcal_best: number; kcal_low: number; kcal_high: number; protein_best: number; protein_low: number; protein_high: number; carbs_g: number; fat_g: number; uses: number; updated_at: string }

export class ApiError extends Error { constructor(public status: number, msg: string) { super(msg); } }
/** Parse answered 202 {status:'pending', job_id}: the item stays pending; poll the job later.
 * next_attempt_at (RFC 3339) is the server's hint for when a requeued job will be tried again. */
export class ParsePending extends Error { constructor(public jobId: string, public nextAttemptAt?: string) { super('parse pending'); } }
type JobBody = { status?: string; job_id?: string; next_attempt_at?: string; result?: ParseResponse } & Partial<ParseResponse>;
/** 202/pending -> ParsePending; done -> the ParseResponse (inline or under result). */
export function parseJobBody(b: JobBody, jobId?: string): ParseResponse {
  if (b.status === 'pending' || b.status === 'queued' || b.status === 'running') throw new ParsePending(b.job_id ?? jobId ?? '', b.next_attempt_at);
  if (b.status === 'failed' || b.status === 'error') throw new ApiError(500, 'parse job failed');
  return (b.result ?? b) as ParseResponse;
}

export function createApi(getToken: () => string | null) {
  async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const tok = getToken();
    const res = await fetch(config.apiUrl + path, {
      method, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(stripSex(body)),
    });
    if (!res.ok) throw new ApiError(res.status, await res.text());
    if (res.status === 204) return undefined as T;
    const json = await res.json();
    return (res.status === 202 ? { status: 'pending', ...json } : json) as T;
  }
  return {
    mock: config.mock,
    /** Online: table + Gemini fallback (AI items come back with ai_estimate=true). */
    async parse(text: string, useAI = true): Promise<ParseResponse> {
      if (config.mock) {
        const r = parseLocal(text);
        if (config.mockAi && r.unmatched.length) {
          if (config.mockAiDelay) await new Promise((res) => setTimeout(res, config.mockAiDelay));
          // QA only: a span containing 'zanthu' simulates a final busy queue -> failed row
          if (/zanthu/i.test(text)) return { ...r, items: r.items.filter((i) => i.dish_id !== ''), used_ai: false, fallback: 'busy', custom_items: [] };
          // QA only: failed reasons with/without a reset time (qa.sh screenshots); ai_state "failed", no kcal
          const qa = /qauserlimit(nt)?|qadaily(nt)?/i.exec(text)?.[0].toLowerCase();
          if (qa) {
            const base = { ...r, items: r.items.filter((i) => i.dish_id !== ''), used_ai: false, ai_state: 'failed' as const, custom_items: r.unmatched.map((u) => ({ custom_name: u, needs_input: true })) };
            const at = qa.endsWith('nt') ? {} : { ai_resets_at: '2026-10-16T00:00:00-07:00' };
            return qa.startsWith('qauser') ? { ...base, fallback: 'cap_reached', fallback_reason: 'user_limit', user_daily_limit: 3, ...at }
              : { ...base, fallback: 'daily_limit', fallback_reason: 'daily_limit', ...at };
          }
          // QA only (EXPO_PUBLIC_MOCK_AI=1): fake an AI estimate so the purple AI card can be reviewed without Gemini
          const ai = r.items.filter((i) => i.dish_id === '').map((i) => ({ ...i, source: 'ai_estimate' as const, ai_estimate: true, data_source: 'ai', source_note: 'AI estimate (mock) - confirm before saving' }));
          return { ...r, items: [...r.items.filter((i) => i.dish_id !== ''), ...ai], used_ai: true, fallback: 'used', custom_items: [] };
        }
        return { ...r, fallback: r.unmatched.length ? 'not_configured' : 'none' };
      }
      return parseJobBody(await req<JobBody>('POST', '/v1/parse', { text, use_ai: useAI }));
    },
    /** Poll a 202 parse job (GET /v1/parse/jobs/{id}). Throws ParsePending while it is still running. */
    async parseJob(jobId: string): Promise<ParseResponse> {
      return parseJobBody(await req<JobBody>('GET', `/v1/parse/jobs/${encodeURIComponent(jobId)}`), jobId);
    },
    /** POST with client_id (idempotent). If the server already has it (an edit), PATCH by client_id. */
    async upsertEntry(e: FoodEntry): Promise<void> {
      if (config.mock) return;
      const source = e.source === 'custom' || e.source === 'manual' ? 'custom' : e.source === 'ai' ? 'ai_estimate' : (e.item_source ?? 'table');
      const nums = { kcal: e.kcal.best, kcal_low: e.kcal.low, kcal_high: e.kcal.high, protein_g: e.protein_g.best, protein_low: e.protein_g.low,
        protein_high: e.protein_g.high, carbs_g: e.carbs_g, fat_g: e.fat_g };
      // span => the server remembers this confirmed reading for the user (Remembered foods)
      const span = e.remember && e.span ? { span: e.span } : {};
      if (e.needs_review) {
        // logged but unchecked (API.md "Entry state"): counts for the server streak, not in totals. Identity only; numbers are display-only.
        const id = e.dish_id ? { dish_id: e.dish_id, qty: e.qty, unit: e.unit, oil_level: e.oil_level } : { custom_name: e.custom_name || e.span || 'item' };
        const r = await req<{ duplicates?: unknown[] }>('POST', '/v1/entries', { local_date: e.local_date, slot: e.slot, text: e.raw_text,
          items: [{ ...id, source, state: 'needs_review', client_id: e.id, ...(e.span ? { span: e.span } : {}) }] });
        if (r?.duplicates?.length) await req('PATCH', `/v1/entries/${encodeURIComponent(e.id)}`, { slot: e.slot, local_date: e.local_date, ...id, remember: false });
        return;
      }
      const item: ItemIn = e.dish_id
        ? { dish_id: e.dish_id, qty: e.qty, unit: e.unit, oil_level: e.oil_level, source, confirmed: true, client_id: e.id, dish_table_version: e.dish_table_version, ...nums, ...span }
        : { custom_name: e.custom_name, source, confirmed: true, client_id: e.id, ...nums, ...span };
      const r = await req<{ duplicates?: unknown[] }>('POST', '/v1/entries', { local_date: e.local_date, slot: e.slot, text: e.raw_text, items: [item] });
      if (r?.duplicates?.length) {
        // PATCH has no dish_table_version/range fields yet (API.md @ ea9dd85); best + identity only.
        await req('PATCH', `/v1/entries/${encodeURIComponent(e.id)}`, {
          slot: e.slot, local_date: e.local_date, ...(e.dish_id ? { dish_id: e.dish_id, qty: e.qty, unit: e.unit, oil_level: e.oil_level } : { custom_name: e.custom_name }),
          kcal: e.kcal.best, protein_g: e.protein_g.best, if_unmodified_since: e.updated_at,
          // confirms a needs_review entry on the server (no-op for confirmed ones)
          state: 'confirmed', ...(e.remember && e.span ? { span: e.span } : { remember: false }),
        });
      }
    },
    /** Remembered foods (per user). */
    async getRemembered(): Promise<RememberedRow[]> { if (config.mock) return []; return (await req<{ remembered: RememberedRow[] }>('GET', '/v1/remembered')).remembered ?? []; },
    /** 404 (already gone) counts as done. */
    async deleteRemembered(id?: number): Promise<void> {
      if (config.mock) return;
      try { await req('DELETE', id === undefined ? '/v1/remembered' : `/v1/remembered/${id}`); } catch (e) { if (!(e instanceof ApiError && e.status === 404)) throw e; }
    },
    async deleteEntry(id: string): Promise<void> { if (!config.mock) await req('DELETE', `/v1/entries/${encodeURIComponent(id)}`); },
    async putSteps(local_date: string, steps: number): Promise<void> {
      if (!config.mock) await req('POST', '/v1/activity/steps', { local_date, steps, source: 'health_connect' });
    },
    async putProfile(body: unknown): Promise<void> { if (!config.mock) await req('PUT', '/v1/profile', stripSex(body)); },
    async deleteMe(): Promise<void> { if (!config.mock) await req('DELETE', '/v1/me'); },
  };
}
export type Api = ReturnType<typeof createApi>;
export { DISH_TABLE_VERSION };

/** Sex is on-device only: removed from anything sent to the server, whatever the caller passes. */
export function stripSex<B>(body: B): B {
  if (!body || typeof body !== 'object') return body;
  const { sex: _sex, ...rest } = body as Record<string, unknown>; return rest as B;
}
