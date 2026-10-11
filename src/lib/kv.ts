// Native: SQLite-backed key-value store (offline storage).
import Storage from 'expo-sqlite/kv-store';
export const kv = { get: (k: string) => Storage.getItem(k), set: (k: string, v: string) => Storage.setItem(k, v) };
