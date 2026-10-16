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
  runTransaction<T>(work: (transaction: CloudTransaction) => Promise<T>, retries?: number): Promise<T>;
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

/** wx-server-sdk 4.0.2 remaps unknown raw codes to -501001. Observe only
 * this reference's raw boundary; preserve SDK errors and never copy messages. */
async function withBackendCode<T>(reference: CloudDocument, method: 'get' | 'set', work: () => Promise<T>): Promise<T> {
  const raw = (reference as CloudDocument & { _document?: unknown })._document;
  if (!record(raw) || typeof raw[method] !== 'function') return work();
  const original = raw[method] as (...args: unknown[]) => unknown;
  const descriptor = Object.getOwnPropertyDescriptor(raw, method);
  let code: string | undefined;
  const observe = (value: unknown) => {
    if (!record(value) || !value.code || !['string', 'number'].includes(typeof value.code)) return;
    const candidate = String(value.code);
    if (/^[A-Za-z0-9_.:-]{1,80}$/.test(candidate)) code = candidate;
  };
  const wrapped = async function (this: unknown, ...args: unknown[]) {
    try { const result = await original.apply(this, args); observe(result); return result; }
    catch (error) { observe(error); throw error; }
  };
  try { Object.defineProperty(raw, method, { value: wrapped, configurable: true, writable: true, enumerable: descriptor?.enumerable ?? false }); }
  catch { return work(); }
  try { return await work(); }
  catch (error) {
    if (code && record(error)) {
      try { Object.defineProperty(error, 'backendCode', { value: code, configurable: true }); }
      catch { /* Diagnostic capture cannot replace a nonextensible SDK error. */ }
    }
    throw error;
  } finally {
    try { if (descriptor) Object.defineProperty(raw, method, descriptor); else delete raw[method]; }
    catch { /* Do not replace an SDK result/error if its own descriptor changed. */ }
  }
}

function retryableTransaction(error: unknown, documentFailure: unknown, documentFailed: boolean): boolean {
  if (!record(error)) return false;
  // CloudBase documents this code as an aborted transaction, including commit
  // conflicts. Other commit/transport errors can have an unknown outcome.
  if (error.code === 'DATABASE_TRANSACTION_CONFLICT') return true;
  if (!documentFailed || error !== documentFailure) return false;
  const code = error.backendCode ?? error.code;
  if (code === 'DATABASE_TRANSACTION_CONFLICT') return true;
  const reason = /(?:^|[^A-Za-z0-9_.])ResourceUnavailable\.(?:TransactionBusy|TransactionNotExist)(?=$|[^A-Za-z0-9_.])/;
  return code === 'DATABASE_TRANSACTION_FAIL' && [error.errMsg, error.message].some(message => typeof message === 'string' && reason.test(message));
}

/** wx-server-sdk wrapper, configured with throwOnNotFound:false by the entry. */
export class CloudStore implements Store {
  constructor(private readonly database: CloudDatabase) {}

  async transaction<T>(work: (transaction: Transaction) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      let documentFailure: unknown, documentFailed = false, callbackError: unknown, callbackFailed = false;
      try {
        return await this.database.runTransaction(async cloudTransaction => {
          let tail = Promise.resolve(), closed = false, stopped = false, failure: unknown;
          const stop = (error: unknown) => { if (!stopped) { stopped = true; failure = error; } };
          const document = async <U>(operation: () => Promise<U>): Promise<U> => {
            if (stopped) throw failure;
            try { return await operation(); }
            catch (error) { if (!documentFailed) { documentFailed = true; documentFailure = error; } stop(error); throw error; }
          };
          const metadata = withMetadata({
            get: <U>(collection: string, id: string): Promise<U | null> => document(async () => {
              const reference = cloudTransaction.collection(collection).doc(id);
              const result = await withBackendCode(reference, 'get', () => reference.get());
              if (result.data === null) return null;
              if (!record(result.data)) throw new Error('Invalid wx-server-sdk document result');
              return result.data as U;
            }),
            set: async <U>(collection: string, id: string, value: U): Promise<void> => {
              if (!record(value)) throw new Error('Document must be an object');
              const { _id: ignoredId, _openid: ignoredOpenId, ...data } = value;
              await document(async () => {
                const reference = cloudTransaction.collection(collection).doc(id);
                await withBackendCode(reference, 'set', () => reference.set({ data }));
              });
            },
          }, new Date().toISOString());
          // Queue complete metadata operations. Their internal read-for-set is
          // already sequential and must not recursively enqueue behind itself.
          const enqueue = <U>(operation: () => Promise<U>): Promise<U> => {
            if (closed) return Promise.reject(stopped ? failure : new Error('Transaction callback has completed'));
            const result = tail.then(async () => {
              if (stopped) throw failure;
              try { return await operation(); } catch (error) { stop(error); throw error; }
            });
            tail = result.then(() => undefined, () => undefined);
            return result;
          };
          let result: T | undefined;
          try { result = await work({ get: (collection, id) => enqueue(() => metadata.get(collection, id)), set: (collection, id, value) => enqueue(() => metadata.set(collection, id, value)) }); }
          catch (error) { callbackFailed = true; callbackError = error; stop(error); }
          closed = true;
          await tail;
          if (callbackFailed) throw callbackError;
          if (stopped) { callbackFailed = true; callbackError = failure; throw failure; }
          return result as T;
        }, 0);
      } catch (error) {
        const original = callbackFailed ? callbackError : error;
        if (attempt >= 7 || !retryableTransaction(original, documentFailure, documentFailed)) throw original;
        // Eight contenders need up to eight fresh attempts. Full jitter avoids
        // synchronized conflict rounds; total backoff stays below 7.1 seconds.
        const ceiling = Math.min(2000, 100 * 2 ** attempt);
        await new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * ceiling)));
      }
    }
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
