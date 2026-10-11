// Web (QA screenshots only): localStorage, since wa-sqlite needs cross-origin isolation headers.
export const kv = {
  get: async (k: string) => globalThis.localStorage?.getItem(k) ?? null,
  set: async (k: string, v: string) => { globalThis.localStorage?.setItem(k, v); },
};
