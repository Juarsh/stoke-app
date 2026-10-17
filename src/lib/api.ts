// Typed client for the Go backend (/workspace/calorie-tracker). With no
// EXPO_PUBLIC_API_URL it runs in MOCK mode: parse is answered locally by the
// TS parser and writes resolve immediately (data stays on the device).
import { DISH_TABLE_VERSION, parser } from '../parser';
import { config } from './config';
import { KCAL_MAX, qtyInRange, serverName, serverSource, type FoodEntry } from './domain';

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
  get reason(): string { const d = errorDetail(this.message); return (d.message ?? (d.code.includes(' ') ? d.code : '')).replace(/^item \d+: /, ''); }
  /** Server error code from the body: {"error":{"code":"..."}} (or legacy {"error":"..."}); '' if none. */
  get code(): string { return errorCode(this.message); }
  /** variant_required: the server's options at the sent portion */
  get variantOptions() { return errorDetail(this.message).variant_options; }
  /** 409 version_conflict: the server's current row ({"entry": ...}) */
  get entry(): { version?: number } | undefined {
    try { const j = JSON.parse(this.message) as { entry?: { version?: number } }; return j?.entry && typeof j.entry === 'object' ? j.entry : undefined; } catch { return undefined; }
  }
}
/** The server's copy of a saved row (POST entries[i] / PATCH body): what it stored and counts (rg6 F1). */
export type ServerRow = { version?: number; state?: string; dish_id?: string | null; name?: string; qty?: number; unit?: string; oil_level?: string;
  kcal_best?: number; kcal_low?: number; kcal_high?: number; protein_best?: number; protein_low?: number; protein_high?: number; carbs_g?: number; fat_g?: number };
/** Units pulled with the server's dish table (stored on the phone). */
export type DishUnits = { version: number; units: Record<string, string[]>; names?: Record<string, string> };
/** rg7 B4: the server's current dish table version from a response header (X-Dish-Table-Version); 0 when absent. */
export function headerVersion(res: { headers?: { get?: (k: string) => string | null } }): number {
  const v = Number(res.headers?.get?.('X-Dish-Table-Version') ?? '');
  return Number.isInteger(v) && v > 0 ? v : 0;
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
/** A needs_review dish the server's draft check takes as is: qty in range and its reading (when the phone has one) at most
 * 5000 kcal (food.go draft: "quantity out of range" / "numbers out of range"). */
export function draftDishOk(e: Pick<FoodEntry, 'qty' | 'review_item'>): boolean {
  if (!qtyInRange(e.qty)) return false;
  const k = e.review_item?.kcal;
  return !k || [k.best, k.high].every((x) => !Number.isFinite(x) || x <= KCAL_MAX);
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
/** onTableVersion: called with the server's dish table version (X-Dish-Table-Version) on every response that carries it,
 * so a phone on an older table pulls the new one (rg7 B4). */
export function createApi(getToken: () => string | null, onReset?: (nextResetAt: string) => void, onTableVersion?: (v: number) => void) {
  async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await req0<T>(method, path, body);
    return r.body;
  }
  async function req0<T>(method: string, path: string, body?: unknown): Promise<{ body: T; version: number }> {
    const tok = getToken();
    const res = await fetch(config.apiUrl + path, {
      method, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(stripSex(body)),
    });
    const version = headerVersion(res as unknown as Parameters<typeof headerVersion>[0]);
    if (version && path !== '/v1/dishes') onTableVersion?.(version);
    const out = (b: unknown) => ({ body: b as T, version });
    if (!res.ok) throw new ApiError(res.status, await res.text());
    if (res.status === 204) return out(undefined);
    const json = await res.json();
    if (onReset && json && typeof json.next_reset_at === 'string') onReset(json.next_reset_at);
    return out(res.status === 202 ? { status: 'pending', ...json } : json);
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
     * edit was based on (never the phone's clock). CEO (next build): every send of an edit is versioned and a stale version is
     * NEVER re-applied: the 409 version_conflict (with the server's locked row, B1) is thrown as is (isStaleEdit), and the
     * store shows the server's row with "Your change to … wasn’t saved." A row with no known version (older builds, a lost
     * POST answer): the server's copy is read first; if it moved on from what the phone last saw (server_counts) that is the
     * same 409, else the PATCH carries the version just read. Returns the server's new version. */
    /** PE: the server's supported units per dish, from its dish table (GET /v1/dishes supported_units) and that table's
     * version. null when the server doesn't send them (older build): the phone keeps what it has. */
    async getDishUnits(): Promise<DishUnits | null> {
      if (config.mock) return null;
      const got = await req0<{ id?: string; name?: string; version?: number; supported_units?: unknown }[]>('GET', '/v1/dishes');
      const rows = got.body;
      if (!Array.isArray(rows)) return null;
      const units: Record<string, string[]> = {};
      const names: Record<string, string> = {};
      let maxDish = 1;
      for (const d of rows) {
        if (typeof d?.id !== 'string') continue;
        maxDish = Math.max(maxDish, d.version ?? 1);
        if (typeof d.name === 'string' && d.name) names[d.id] = d.name;
        if (Array.isArray(d.supported_units) && d.supported_units.every((u) => typeof u === 'string') && d.supported_units.length) units[d.id] = d.supported_units as string[];
      }
      // rg7 B5: the table version is the server's header (a version that only removes a unit bumps no dish); older servers: max per dish
      return Object.keys(units).length ? { version: got.version || maxDish, units, names } : null;
    },
    async upsertEntry(e: FoodEntry): Promise<{ version?: number; row?: ServerRow }> {
      if (config.mock) return {};
      type Saved = ServerRow;
      const patch = (body: Record<string, unknown>, known?: number) => patch0(body, known).catch((err) => { if (err instanceof ApiError) err.patch = true; throw err; });
      const saved = (row?: Saved) => ({ version: row?.version, ...(row && typeof row === 'object' ? { row } : {}) });
      const path = `/v1/entries/${encodeURIComponent(e.id)}`;
      const stale = (row: ServerRow) => new ApiError(409, JSON.stringify({ error: { code: 'version_conflict', version: row.version }, entry: row }));
      const patch0 = async (body: Record<string, unknown>, known?: number): Promise<{ version?: number; row?: ServerRow }> => {
        let base = known;
        if (!base) {
          // no version known for this row: the server's copy decides (404 -> deleted elsewhere, the delete wins)
          const cur = await req<Saved>('GET', path);
          const sc = e.server_counts;
          if (sc && cur.state && (cur.state === 'needs_review' ? sc.kcal !== 0
            : Math.abs((cur.kcal_best ?? sc.kcal) - sc.kcal) > 0.5 || Math.abs((cur.protein_best ?? sc.protein) - sc.protein) > 0.05)) throw stale(cur);
          base = cur.version;
        }
        try { return saved(await req<Saved>('PATCH', path, { ...body, ...(base ? { version: base } : {}) })); }
        catch (err) {
          if (!(err instanceof ApiError && err.status === 409 && err.code === 'version_conflict') || err.entry) throw err;
          // an older server's 409 without its row: read it, so the phone can show what the server has
          let cur: Saved | null = null; try { cur = await req<Saved>('GET', path); } catch { /* unknown: the 409 as is */ }
          throw cur ? stale(cur) : err;
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
        // G1: the server's draft check (food.go draft) recomputes a dish at its qty and refuses a qty out of range or a reading
        // over 5000 kcal (60 roti, 5001 roti, 5001 g rice). Such a draft is saved by name instead, so the server has the row
        // too (streak / "logged" match); the phone keeps the dish reading in review_item, and confirming it sends the dish.
        const name = { custom_name: serverName(e.custom_name || e.review_item?.name || e.span || e.raw_text || 'item') || 'item' };
        const dish = e.dish_id && draftDishOk(e) ? { dish_id: e.dish_id, qty: e.qty, unit: e.unit, oil_level: e.oil_level } : null;
        const send = async (id: Record<string, unknown>, clear: Record<string, unknown> = {}) => {
          const r = await req<Posted>('POST', '/v1/entries', { local_date: e.local_date, slot: e.slot, text: e.raw_text,
            items: [{ ...id, source, state: 'needs_review', client_id: e.id, ...(e.span ? { span: e.span } : {}), ...job }] });
          if (r?.duplicates?.length) return patch({ slot: e.slot, local_date: e.local_date, ...clear, ...id, remember: false }, e.server_version);
          return { version: r?.entries?.[0]?.version };
        };
        if (!dish) return send(name, e.dish_id ? { dish_id: '' } : {});
        try { return await send(dish); }
        catch (err) {
          // the server still refused the dish draft (400: its own recompute): the same row by name, never lost
          if (!(err instanceof ApiError && err.status === 400)) throw err;
          return send(name, { dish_id: '' });
        }
      }
      const item: ItemIn = e.dish_id
        ? { dish_id: e.dish_id, qty: e.qty, unit: e.unit, oil_level: e.oil_level, source, confirmed: true, client_id: e.id, dish_table_version: parser.saveVersion(e.dish_id, e.dish_table_version), ...nums, ...span,
          ...variantField(e), ...job } as ItemIn
        : { custom_name: serverName(e.custom_name), source, confirmed: true, client_id: e.id, ...nums, ...span, ...job };
      const r = await req<Posted>('POST', '/v1/entries', { local_date: e.local_date, slot: e.slot, text: e.raw_text, items: [item] });
      if (!r?.duplicates?.length) return saved(r?.entries?.[0]);
      // PATCH has no dish_table_version/range fields yet (API.md @ ea9dd85); best + identity only. No phone-clock precondition:
      // the version is the server's own, from its last response for this entry (else the POST's copy of the row).
      return patch({
        slot: e.slot, local_date: e.local_date, ...(e.dish_id ? { dish_id: e.dish_id, qty: e.qty, unit: e.unit, oil_level: e.oil_level, ...variantField(e) } : { custom_name: serverName(e.custom_name) }),
        confirmed: true,
        kcal: e.kcal.best, protein_g: e.protein_g.best,
        // confirms a needs_review entry on the server (no-op for confirmed ones)
        state: 'confirmed', ...(e.remember && e.span ? { span: e.span } : { remember: false }),
        // only an AI reading says so; a typed (custom) save is plain custom, without the job's AI provenance
        // (a typed kcal on a custom row is custom on the server by itself)
        ...(source === 'ai_estimate' && e.job_id ? { parse_job_id: e.job_id, source } : {}),
      }, e.server_version);
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
    /** edge (a): GET /v1/entries/{id} (server id or the app's client_id): the server's current copy of a row; null when it
     * has none (404: deleted, or never stored). Read-only: used to count a flagged row exactly as the server has it. */
    async getEntry(id: string): Promise<ServerRow | null> {
      if (config.mock) return null;
      try { return await req<ServerRow>('GET', `/v1/entries/${encodeURIComponent(id)}`); } catch (e) { if (e instanceof ApiError && e.status === 404) return null; throw e; }
    },
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
