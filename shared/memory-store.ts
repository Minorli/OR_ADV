import type { QueryOptions, Store, StoreSnapshot, Transaction } from './store';
import { normalizeMetadata, withMetadata } from './store';

const clone = <T>(value: T): T => value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;

/** Local test adapter. A failed transaction discards every staged write. */
export class MemoryStore implements Store {
  private data: StoreSnapshot;
  private tail: Promise<void> = Promise.resolve();

  constructor(initial: StoreSnapshot = {}, private readonly clock: () => string = () => new Date().toISOString()) {
    const now = clock();
    this.data = Object.fromEntries(Object.entries(initial).map(([collection, rows]) => [collection,
      Object.fromEntries(Object.entries(rows).map(([id, value]) => {
        const normalized = normalizeMetadata(value, null, now);
        const existing = value as Record<string, unknown> | null;
        // Restoring a local snapshot is not a business edit.
        return [id, clone(existing?.updatedAt && normalized && typeof normalized === 'object'
          ? { ...normalized, updatedAt: existing.updatedAt } : normalized)];
      })),
    ]));
  }

  snapshot(): StoreSnapshot {
    return clone(this.data);
  }

  async transaction<T>(work: (transaction: Transaction) => Promise<T>): Promise<T> {
    const preceding = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await preceding;
    const staged = clone(this.data);
    try {
      const result = await work(withMetadata({
        get: async <T>(collection: string, id: string) => {
          const value = staged[collection]?.[id];
          return value === undefined ? null : clone(value as T);
        },
        set: async <T>(collection: string, id: string, value: T) => {
          staged[collection] ??= {};
          staged[collection][id] = clone(value);
        },
      }, this.clock()));
      const response = clone(result);
      this.data = staged;
      return response;
    } finally {
      release();
    }
  }

  async query<T>(collection: string, filters: Record<string, unknown>, options: QueryOptions = {}): Promise<T[]> {
    const field = options.orderBy ?? 'id';
    const direction = options.direction === 'desc' ? -1 : 1;
    const compare = (left: unknown, right: unknown) => left === right ? 0 : (left as string | number) < (right as string | number) ? -1 : 1;
    let rows = Object.values(this.data[collection] ?? {}) as Record<string, unknown>[];
    rows = rows.filter((row) => Object.entries(filters).every(([key, value]) => row[key] === value));
    rows.sort((a, b) => direction * compare(a[field], b[field]) || compare(a.id, b.id));
    const after = options.after as { value: unknown; id: string } | undefined;
    if (after) {
      rows = rows.filter((row) => direction * compare(row[field], after.value) > 0 || (row[field] === after.value && compare(row.id, after.id) > 0));
    }
    return clone(rows.slice(0, options.limit ?? 100)) as T[];
  }
}
