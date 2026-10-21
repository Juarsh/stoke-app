// Data-layer seam (architecture rule, spec-frozen-v1): everything the app keeps on the phone goes through LocalStore.
// Today's impl is the key-value store in ./kv (expo-sqlite kv-store on native, localStorage for web QA). Moving to
// another local database means a new LocalStore impl here; callers don't change. The server side is reached only
// through the API client in ./api (base URL from config.apiUrl, one config value).
import { kv } from './kv';

export interface LocalStore {
  load(key: string): Promise<string | null>;
  save(key: string, value: string): Promise<void>;
}

export const localStore: LocalStore = {
  load: (key) => kv.get(key),
  save: async (key, value) => { await kv.set(key, value); },
};
