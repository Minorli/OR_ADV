export interface Transaction {
  get<T>(collection: string, id: string): Promise<T | null>;
  set<T>(collection: string, id: string, value: T): Promise<void>;
}

export interface QueryOptions {
  orderBy?: string;
  direction?: 'asc' | 'desc';
  limit?: number;
  /** Stable continuation: ordered value, then ascending document id. */
  after?: unknown;
}

export interface Store {
  transaction<T>(work: (transaction: Transaction) => Promise<T>): Promise<T>;
  query<T>(collection: string, filters: Record<string, unknown>, options?: QueryOptions): Promise<T[]>;
}

export type StoreSnapshot = Record<string, Record<string, unknown>>;

/** Shared by fixture loading and transaction adapters; private control rows
 * without clubId retain their original shape. Business dates are unchanged. */
export function normalizeMetadata<T>(value: T, prior: unknown, now: string): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (typeof record.clubId !== 'string') return value;
  const existing = prior && typeof prior === 'object' ? prior as Record<string, unknown> : undefined;
  return { ...record, createdAt: existing?.createdAt ?? record.createdAt ?? now,
    updatedAt: now, schemaVersion: record.schemaVersion ?? existing?.schemaVersion ?? 1 } as T;
}

/** One timestamp per transaction attempt, with read-your-writes caching. */
export function withMetadata(transaction: Transaction, now: string): Transaction {
  const cache = new Map<string, Promise<unknown | null>>();
  const copy = <T>(value: T): T => value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
  const cacheKey = (collection: string, id: string) => JSON.stringify([collection, id]);
  const read = <T>(collection: string, id: string): Promise<T | null> => {
    const key = cacheKey(collection, id);
    if (!cache.has(key)) cache.set(key, transaction.get(collection, id).then(copy));
    return cache.get(key)!.then((value) => copy(value as T | null));
  };
  return {
    get: read,
    set: async <T>(collection: string, id: string, value: T): Promise<void> => {
      const business = value && typeof value === 'object' && !Array.isArray(value) && typeof (value as Record<string, unknown>).clubId === 'string';
      const prior = business ? await read(collection, id) : null;
      const normalized = normalizeMetadata(value, prior, now);
      await transaction.set(collection, id, normalized);
      cache.set(cacheKey(collection, id), Promise.resolve(copy(normalized)));
    },
  };
}
