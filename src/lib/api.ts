// Typed client for the Go backend (/workspace/calorie-tracker). With no
// EXPO_PUBLIC_API_URL it runs in MOCK mode: parse is answered locally by the
// TS parser and writes resolve immediately (data stays on the device).
import { DISH_TABLE_VERSION, parser } from '../parser';
import { config } from './config';
import { serverSource, type FoodEntry } from './domain';

export * from './parseLocal';
import { ItemIn, ParseResponse, parseLocal } from './parseLocal';
/** GET /v1/remembered row (API.md @ 6986771). */
export interface RememberedRow { id: number; span: string; dish_id: string | null; custom_name: string; qty: number; unit: string; oil_level: string;
  kcal_best: number; kcal_low: number; kcal_high: number; protein_best: number; protein_low: number; protein_high: number; carbs_g: number; fat_g: number; uses: number; updated_at: string }

export class ApiError extends Error {
  constructor(public status: number, msg: string) { super(msg); }
  /** set when the error came from the PATCH of an upsert (an edit of a row the server has): never rewrites the row */
  patch?: boolean;
  /** the server's human reason ({"error":"..."} or {"error":{"message"}}) */
  get reason(): string { const d = errorDetail(this.message); return d.message ?? (d.code.includes(' ') ? d.code : ''); }
  /** Server error code from the body: {"error":{"code":"..."}} (or legacy {"error":"..."}); '' if none. */
  get code(): string { return errorCode(this.message); }
  /** variant_required: the server's options at the sent portion */
  get variantOptions() { return errorDetail(this.message).variant_options; }
  /** 409 version_conflict: the server's current row ({"entry": ...}) */
  get entry(): { version?: number } | undefined {
    try { const j = JSON.parse(this.message) as { entry?: { version?: number } }; return j?.entry && typeof j.entry === 'object' ? j.entry : undefined; } catch { return undefined; }
  }
}
/** A PATCH still refused after the one version-conflict retry: surfaced on the entry ("Couldn’t sync this"). */
export const SYNC_CONFLICT = 'sync_conflict';
/** Extra fields of a 422 {error:{code,item,dish_id,message,variant_options,fields}}; {} for the plain {error:"string"} shape. */
export function errorDetail(body: string): { code: string; variant_options?: { dish_id: string; name: string; kcal: number; protein_g: number }[]; fields?: Record<string, string>; message?: string } {
  try { const e = (JSON.parse(body) as { error?: unknown })?.error;
    if (e && typeof e === 'object') { const o = e as Record<string, unknown>;
      return { code: typeof o.code === 'string' ? o.code : '', message: typeof o.message === 'string' ? o.message : undefined,
        fields: o.fields && typeof o.fields === 'object' ? o.fields as Record<string, string> : undefined,
        variant_options: Array.isArray(o.variant_options) ? (o.variant_options as Record<string, unknown>[]).filter((v) => v && typeof v.dish_id === 'string')
          .map((v) => ({ dish_id: String(v.dish_id), name: String(v.name ?? v.dish_id), kcal: Number(v.kcal) || 0, protein_g: Number(v.protein_g ?? v.protein) || 0 })).filter((v) => v.kcal > 0) : undefined };
    }
    if (typeof e === 'string') return { code: e };
  } catch { /* not JSON */ }
  return { code: '' };
}
/** API.md @ 1c617da: a confirmed save/edit of a variant-group dish (biryani, chilla) always sends variant_dish_id = dish_id.
 * Confirmed entries only reach here after a pick or an explicitly named variant (bare "biryani" is an open row). */
export function variantField(e: FoodEntry): { variant_dish_id?: string } {
  if (!e.dish_id || e.needs_review) return {};
  // only a pick the user made (or a variant named in their text, recorded on the entry); never inferred here
  return e.variant_dish_id && e.variant_dish_id === e.dish_id ? { variant_dish_id: e.dish_id } : {};
}
export function errorCode(body: string): string {
  try { const j = JSON.parse(body) as { error?: unknown }; const e = j?.error;
    if (e && typeof e === 'object' && typeof (e as { code?: unknown }).code === 'string') return (e as { code: string }).code;
    if (typeof e === 'string') return e;
  } catch { /* not JSON */ }
  return '';
}
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

/** onReset: called with next_reset_at whenever a server response carries it. */
export function createApi(getToken: () => string | null, onReset?: (nextResetAt: string) => void) {
  async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const tok = getToken();
    const res = await fetch(config.apiUrl + path, {
      method, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(stripSex(body)),
    });
    if (!res.ok) throw new ApiError(res.status, await res.text());
    if (res.status === 204) return undefined as T;
    const json = await res.json();
    if (onReset && json && typeof json.next_reset_at === 'string') onReset(json.next_reset_at);
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
            const at = qa.endsWith('nt') ? {} : { ai_resets_at: '2026-10-16T00:00:00-07:00', next_reset_at: '2026-10-16T00:00:00-07:00' };
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
    /** POST with client_id (idempotent). If the server already has it (an edit), PATCH by client_id with the row version the
     * phone last saw (never its clock). On 409 version_conflict the user's edit is re-applied on the server's current version
     * and retried ONCE; still refused -> ApiError(409, sync_conflict). Returns the server's new version. */
    async upsertEntry(e: FoodEntry): Promise<{ version?: number }> {
      if (config.mock) return {};
      type Saved = { version?: number };
      const patch = (body: Record<string, unknown>, known?: number) => patch0(body, known).catch((err) => { if (err instanceof ApiError) err.patch = true; throw err; });
      const patch0 = async (body: Record<string, unknown>, known?: number): Promise<{ version?: number }> => {
        const path = `/v1/entries/${encodeURIComponent(e.id)}`;
        try { return { version: (await req<Saved>('PATCH', path, { ...body, ...(known ? { version: known } : {}) }))?.version }; }
        catch (err) {
          if (!(err instanceof ApiError && err.status === 409 && err.code === 'version_conflict')) throw err;
          const cur = err.entry?.version; // the server's row: our body (the user's latest values) goes on top of it
          try { return { version: (await req<Saved>('PATCH', path, { ...body, ...(cur ? { version: cur } : {}) }))?.version }; }
          catch (err2) {
            if (err2 instanceof ApiError && err2.status === 409 && err2.code === 'version_conflict') throw new ApiError(409, JSON.stringify({ error: { code: SYNC_CONFLICT } }));
            throw err2;
          }
        }
      };
      type Posted = { duplicates?: unknown[]; entries?: Saved[] };
      const source = serverSource(e);
      const nums = { kcal: e.kcal.best, kcal_low: e.kcal.low, kcal_high: e.kcal.high, protein_g: e.protein_g.best, protein_low: e.protein_g.low,
        protein_high: e.protein_g.high, carbs_g: e.carbs_g, fat_g: e.fat_g };
      // span => the server remembers this confirmed reading for the user (Remembered foods)
      const span = e.remember && e.span ? { span: e.span } : {};
      // the parse job this AI reading came from: the server refuses an AI reading tied to an abandoned job (409 job_abandoned).
      // A typed (custom) save never carries the job's AI provenance.
      const job = e.job_id && source === 'ai_estimate' ? { parse_job_id: e.job_id } : {};
      if (e.needs_review) {
        // logged but unchecked (API.md "Entry state"): counts for the server streak, not in totals. Identity only; numbers are display-only.
        const id = e.dish_id ? { dish_id: e.dish_id, qty: e.qty, unit: e.unit, oil_level: e.oil_level } : { custom_name: e.custom_name || e.span || 'item' };
        const r = await req<Posted>('POST', '/v1/entries', { local_date: e.local_date, slot: e.slot, text: e.raw_text,
          items: [{ ...id, source, state: 'needs_review', client_id: e.id, ...(e.span ? { span: e.span } : {}), ...job }] });
        if (r?.duplicates?.length) return patch({ slot: e.slot, local_date: e.local_date, ...id, remember: false }, e.server_version ?? r.entries?.[0]?.version);
        return { version: r?.entries?.[0]?.version };
      }
      const item: ItemIn = e.dish_id
        ? { dish_id: e.dish_id, qty: e.qty, unit: e.unit, oil_level: e.oil_level, source, confirmed: true, client_id: e.id, dish_table_version: e.dish_table_version, ...nums, ...span,
          ...variantField(e), ...job } as ItemIn
        : { custom_name: e.custom_name, source, confirmed: true, client_id: e.id, ...nums, ...span, ...job };
      const r = await req<Posted>('POST', '/v1/entries', { local_date: e.local_date, slot: e.slot, text: e.raw_text, items: [item] });
      if (!r?.duplicates?.length) return { version: r?.entries?.[0]?.version };
      // PATCH has no dish_table_version/range fields yet (API.md @ ea9dd85); best + identity only. No phone-clock precondition:
      // the version is the server's own, from its last response for this entry (else the POST's copy of the row).
      return patch({
        slot: e.slot, local_date: e.local_date, ...(e.dish_id ? { dish_id: e.dish_id, qty: e.qty, unit: e.unit, oil_level: e.oil_level, ...variantField(e) } : { custom_name: e.custom_name }),
        confirmed: true,
        kcal: e.kcal.best, protein_g: e.protein_g.best,
        // confirms a needs_review entry on the server (no-op for confirmed ones)
        state: 'confirmed', ...(e.remember && e.span ? { span: e.span } : { remember: false }),
        // only an AI reading says so; a typed (custom) save is plain custom, without the job's AI provenance
        // (a typed kcal on a custom row is custom on the server by itself)
        ...(source === 'ai_estimate' && e.job_id ? { parse_job_id: e.job_id, source } : {}),
      }, e.server_version ?? r.entries?.[0]?.version);
    },
    /** Remembered foods (per user). */
    async getRemembered(): Promise<RememberedRow[]> { if (config.mock) return []; return (await req<{ remembered: RememberedRow[] }>('GET', '/v1/remembered')).remembered ?? []; },
    /** 404 (already gone) counts as done. */
    async deleteRemembered(id?: number): Promise<void> {
      if (config.mock) return;
      try { await req('DELETE', id === undefined ? '/v1/remembered' : `/v1/remembered/${id}`); } catch (e) { if (!(e instanceof ApiError && e.status === 404)) throw e; }
    },
    /** The 35-minute backstop gave up on this job: the server stops trying and ignores a late result. 404/410 = done. */
    async abandonJob(jobId: string): Promise<void> {
      if (config.mock || !jobId) return;
      try { await req('POST', `/v1/parse/jobs/${encodeURIComponent(jobId)}/abandon`); } catch (e) { if (!(e instanceof ApiError && (e.status === 404 || e.status === 410))) throw e; }
    },
    /** 404 (never reached the server / already gone) counts as done. */
    async deleteEntry(id: string): Promise<void> {
      if (config.mock) return;
      try { await req('DELETE', `/v1/entries/${encodeURIComponent(id)}`); } catch (e) { if (!(e instanceof ApiError && e.status === 404)) throw e; }
    },
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
