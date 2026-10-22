// Our server session token (POST /v1/auth/google) lives in the OS keystore (expo-secure-store), never in the app's
// state file or logs. Token refresh is deferred: when the server says 401 the app signs out and keeps its local data.
import * as SecureStore from 'expo-secure-store';

const KEY = 'stoke.session.v1';

export const session = {
  async load(): Promise<string | null> { try { return (await SecureStore.getItemAsync(KEY)) || null; } catch { return null; } },
  async save(token: string): Promise<void> { await SecureStore.setItemAsync(KEY, token); },
  async clear(): Promise<void> { try { await SecureStore.deleteItemAsync(KEY); } catch { /* already gone */ } },
};
