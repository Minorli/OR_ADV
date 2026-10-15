import type { QueryOptions, Store, Transaction } from '../../shared/store';
import { withMetadata } from '../../shared/store';

type RecordData = Record<string, unknown>;
export interface CloudDocument {
  get(): Promise<{ data: RecordData | null }>;
  set(options: { data: RecordData }): Promise<unknown>;
}
export interface CloudQuery {
  doc(id: string): CloudDocument;
  where(condition: unknown): CloudQuery;
  orderBy(field: string, direction: 'asc' | 'desc'): CloudQuery;
  limit(count: number): CloudQuery;
  get(): Promise<{ data: RecordData[] }>;
}
export interface CloudTransaction { collection(name: string): Pick<CloudQuery, 'doc'> }
export interface CloudDatabase {
  collection(name: string): CloudQuery;
  runTransaction<T>(work: (transaction: CloudTransaction) => Promise<T>): Promise<T>;
  command: {
    and(conditions: unknown[]): unknown;
    or(conditions: unknown[]): unknown;
    eq(value: unknown): unknown;
    gt(value: unknown): unknown;
    lt(value: unknown): unknown;
  };
}

function record(value: unknown): value is RecordData {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** wx-server-sdk wrapper, configured with throwOnNotFound:false by the entry. */
export class CloudStore implements Store {
  constructor(private readonly database: CloudDatabase) {}

  transaction<T>(work: (transaction: Transaction) => Promise<T>): Promise<T> {
    // The SDK owns commit, rollback and conflict retries. Never catch database errors
    // as a missing document: missing collections/permissions must stop the request.
    return this.database.runTransaction((cloudTransaction) => work(withMetadata({
      get: async <U>(collection: string, id: string): Promise<U | null> => {
        const result = await cloudTransaction.collection(collection).doc(id).get();
        if (result.data === null) return null;
        if (!record(result.data)) throw new Error('Invalid wx-server-sdk document result');
        return result.data as U;
      },
      set: async <U>(collection: string, id: string, value: U): Promise<void> => {
        if (!record(value)) throw new Error('Document must be an object');
        const { _id: ignoredId, _openid: ignoredOpenId, ...data } = value;
        await cloudTransaction.collection(collection).doc(id).set({ data });
      },
    }, new Date().toISOString())));
  }

  async query<T>(collection: string, filters: RecordData, options: QueryOptions = {}): Promise<T[]> {
    const field = options.orderBy ?? 'id';
    const direction = options.direction ?? 'asc';
    const limit = options.limit ?? 100;
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(field) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('Invalid store query');
    }
    // Equality filters are explicit commands so objects cannot become operators.
    const conditions: unknown[] = Object.entries(filters).map(([name, value]) => {
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) throw new Error('Invalid store filter');
      return { [name]: this.database.command.eq(value) };
    });
    if (options.after !== undefined) {
      const after = options.after;
      if (!record(after) || typeof after.id !== 'string' || !('value' in after)) throw new Error('Invalid store cursor');
      const compare = direction === 'desc' ? this.database.command.lt : this.database.command.gt;
      conditions.push(field === 'id'
        ? { id: compare.call(this.database.command, after.value) }
        : this.database.command.or([
          { [field]: compare.call(this.database.command, after.value) },
          { [field]: this.database.command.eq(after.value), id: this.database.command.gt(after.id) },
        ]));
    }
    let query = this.database.collection(collection);
    if (conditions.length > 0) query = query.where(this.database.command.and(conditions));
    query = query.orderBy(field, direction);
    if (field !== 'id') query = query.orderBy('id', 'asc');
    const result = await query.limit(limit).get();
    if (!Array.isArray(result.data) || !result.data.every(record)) throw new Error('Invalid wx-server-sdk query result');
    return result.data as T[];
  }
}
