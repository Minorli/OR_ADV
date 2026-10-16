import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CloudStore, type CloudDatabase, type CloudTransaction } from '../../cloudfunctions/oradv/store';
import type { Transaction } from '../../shared/store';

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const gate = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
interface Options {
  fail?: (attempt: number, method: 'get' | 'set', id: string) => unknown;
  wait?: (attempt: number, method: 'get' | 'set', id: string) => Promise<void>;
  commitError?: unknown;
}
function fixture(options: Options = {}) {
  let state: Record<string, Record<string, unknown>> = {}, attempts = 0, commits = 0, rollbacks = 0, peak = 0;
  const calls: { attempt: number; method: string; id: string; closed: boolean }[] = [], retryArguments: (number | undefined)[] = [];
  const database = {
    async runTransaction<T>(work: (tx: CloudTransaction) => Promise<T>, sdkRetries?: number): Promise<T> {
      const attempt = ++attempts, staged = structuredClone(state); let active = 0, closed = false;
      retryArguments.push(sdkRetries);
      const operation = async (method: 'get' | 'set', id: string, data?: Record<string, unknown>) => {
        calls.push({ attempt, method, id, closed });
        active++; peak = Math.max(peak, active);
        try {
          if (active > 1) throw Object.assign(new Error('[ResourceUnavailable.TransactionBusy]'), { backendCode: 'DATABASE_TRANSACTION_FAIL', errCode: -501001 });
          await (options.wait?.(attempt, method, id) ?? sleep(1));
          const error = options.fail?.(attempt, method, id); if (error) throw error;
          if (method === 'get') return { data: staged[id] ?? null };
          staged[id] = structuredClone(data!); return {};
        } finally { active--; }
      };
      const tx = { collection: () => ({ doc: (id: string) => ({ get: () => operation('get', id), set: ({ data }: { data: Record<string, unknown> }) => operation('set', id, data) }) }) } as CloudTransaction;
      try {
        const result = await work(tx);
        assert.equal(active, 0, 'SDK commit must not race a pending document request');
        state = staged; commits++;
        if (options.commitError) throw options.commitError;
        return result;
      } catch (error) { assert.equal(active, 0, 'SDK rollback must not race a pending document request'); rollbacks++; throw error; }
      finally { closed = true; }
    },
  } as CloudDatabase;
  return { store: new CloudStore(database), calls, retryArguments, state: () => state, attempts: () => attempts, commits: () => commits, rollbacks: () => rollbacks, peak: () => peak };
}

test('parallel domain reads and metadata writes serialize within one SDK transaction', async () => {
  const db = fixture();
  const result = await db.store.transaction(async tx => {
    assert.deepEqual(await Promise.all(['a', 'b', 'c', 'd'].map(id => tx.get('roles', id))), [null, null, null, null]);
    await Promise.all(['a', 'b', 'c', 'd'].map(id => tx.set('roles', id, { id, clubId: 'oradv', enabled: true })));
    return 'finished-once';
  });
  assert.equal(result, 'finished-once'); assert.equal(db.attempts(), 1); assert.equal(db.commits(), 1); assert.equal(db.peak(), 1);
  assert.equal(Object.keys(db.state()).length, 4); assert.deepEqual(db.retryArguments, [0]);
});

test('first document failure aborts queued siblings and drains before rollback without late SDK calls', async () => {
  const original = Object.assign(new Error('permission denied'), { backendCode: 'DATABASE_PERMISSION_DENIED' });
  const db = fixture({ fail: (_attempt, _method, id) => id === 'bad' ? original : undefined });
  await assert.rejects(db.store.transaction(tx => Promise.all(['bad', 'later-a', 'later-b'].map(id => tx.get('roles', id)))), error => error === original);
  await sleep(10);
  assert.deepEqual(db.calls.map(row => row.id), ['bad']); assert.equal(db.rollbacks(), 1); assert.equal(db.commits(), 0);
  assert(db.calls.every(row => !row.closed)); assert.equal(db.attempts(), 1);
});

test('callback failure preserves its error, stops siblings and drains an already running command', async () => {
  const entered = gate(), release = gate(), original = new Error('business failure');
  const db = fixture({ wait: async (_attempt, _method, id) => { if (id === 'running') { entered.release(); await release.promise; } } });
  const pending = db.store.transaction(async tx => {
    const running = tx.get('rows', 'running'); const later = tx.get('rows', 'later');
    void Promise.allSettled([running, later]); await entered.promise; throw original;
  });
  await entered.promise; await sleep(3); assert.equal(db.rollbacks(), 0);
  release.release(); await assert.rejects(pending, error => error === original); await sleep(3);
  assert.deepEqual(db.calls.map(row => row.id), ['running']); assert.equal(db.attempts(), 1); assert.equal(db.rollbacks(), 1);
});

test('commands already enqueued before callback return complete before commit', async () => {
  const db = fixture(); let operation: Promise<void> | undefined;
  const result = await db.store.transaction(async tx => { operation = tx.set('rows', 'one', { clubId: 'oradv', count: 1 }); return 'one-result'; });
  await operation; assert.equal(result, 'one-result'); assert.equal(db.state().one.count, 1); assert.equal(db.commits(), 1);
});

test('recognized busy, expired transaction and wrapped/raw conflict errors reopen a fresh transaction', async () => {
  for (const fields of [
    { backendCode: 'DATABASE_TRANSACTION_FAIL', errMsg: '[ResourceUnavailable.TransactionBusy]' },
    { backendCode: 'DATABASE_TRANSACTION_FAIL', message: '[ResourceUnavailable.TransactionNotExist]' },
    { backendCode: 'DATABASE_TRANSACTION_CONFLICT', errCode: -501001 },
    { code: 'DATABASE_TRANSACTION_CONFLICT' },
  ]) {
    const db = fixture({ fail: attempt => attempt < 3 ? Object.assign(new Error('SDK document failure'), fields) : undefined });
    let callbacks = 0;
    const result = await db.store.transaction(async tx => { callbacks++; const row = await tx.get<{ count: number }>('rows', 'counter'); await tx.set('rows', 'counter', { count: (row?.count ?? 0) + 1 }); return 'committed'; });
    assert.equal(result, 'committed'); assert.equal(callbacks, 3); assert.equal(db.attempts(), 3); assert.equal(db.commits(), 1);
    assert.equal(db.state().counter.count, 1); assert.deepEqual(db.retryArguments, [0, 0, 0]);
  }
});

test('transaction retries stop after eight fresh attempts and never replay permission, unknown or ambiguous commit failures', async () => {
  const busy = Object.assign(new Error('[ResourceUnavailable.TransactionBusy]'), { backendCode: 'DATABASE_TRANSACTION_FAIL' });
  const bounded = fixture({ fail: () => busy });
  await assert.rejects(bounded.store.transaction(tx => tx.get('rows', 'counter')), error => error === busy);
  assert.equal(bounded.attempts(), 8); assert.equal(bounded.commits(), 0); assert.deepEqual(bounded.retryArguments, Array(8).fill(0));
  for (const original of [Object.assign(new Error('permission'), { backendCode: 'DATABASE_PERMISSION_DENIED' }),
    Object.assign(new Error('unknown'), { errCode: -501001 }), Object.assign(new Error('similar TransactionBusy text'), { backendCode: 'DATABASE_TRANSACTION_FAIL' })]) {
    const db = fixture({ fail: () => original });
    await assert.rejects(db.store.transaction(tx => tx.get('rows', 'counter')), error => error === original); assert.equal(db.attempts(), 1);
  }
  const commitError = Object.assign(new Error('[ResourceUnavailable.TransactionNotExist]'), { code: 'DATABASE_TRANSACTION_FAIL', errCode: -501001 });
  const ambiguous = fixture({ commitError });
  await assert.rejects(ambiguous.store.transaction(async tx => { await tx.set('rows', 'counter', { count: 1 }); return 'not-confirmed'; }), error => error === commitError);
  assert.equal(ambiguous.attempts(), 1); assert.equal(ambiguous.commits(), 1); assert.equal(ambiguous.state().counter.count, 1);
});

test('transaction queues never serialize unrelated transactions globally', async () => {
  const entered = gate(), release = gate();
  const db = fixture({ wait: async (_attempt, _method, id) => { if (id === 'slow') { entered.release(); await release.promise; } } });
  const slow = db.store.transaction(tx => tx.get('rows', 'slow')); await entered.promise;
  assert.equal(await db.store.transaction(tx => tx.get('rows', 'fast')), null);
  release.release(); await slow; assert.equal(db.commits(), 2);
});

test('catching a document failure inside the callback cannot commit a partially failed transaction', async () => {
  const original = Object.assign(new Error('not retryable'), { backendCode: 'DATABASE_PERMISSION_DENIED' });
  const db = fixture({ fail: () => original }); let returned = false;
  await assert.rejects(db.store.transaction(async tx => {
    await assert.rejects(tx.get('rows', 'bad'), error => error === original);
    await assert.rejects(tx.set('rows', 'later', { count: 1 }), error => error === original);
    returned = true; return 'must-not-commit';
  }), error => error === original);
  assert.equal(returned, true); assert.equal(db.calls.length, 1); assert.equal(db.commits(), 0); assert.equal(db.rollbacks(), 1);
});

test('a retained transaction handle rejects later reads and writes without accessing the SDK', async () => {
  const db = fixture(); let retained: Transaction | undefined;
  assert.equal(await db.store.transaction(async tx => { retained = tx; return 'completed'; }), 'completed');
  assert(retained);
  await assert.rejects(retained.get('rows', 'late'), /callback has completed/);
  await assert.rejects(retained.set('rows', 'late', { count: 1 }), /callback has completed/);
  assert.equal(db.calls.length, 0); assert.equal(db.commits(), 1);
});

test('eight concurrent optimistic counter transactions commit exactly eight increments with fresh conflict retries', async () => {
  let count = 0, version = 0, attempts = 0;
  const retryArguments: (number | undefined)[] = [];
  const database = { async runTransaction<T>(work: (tx: CloudTransaction) => Promise<T>, sdkRetries?: number) {
    attempts++; retryArguments.push(sdkRetries);
    const basis = version; let staged = count;
    const tx = { collection: () => ({ doc: () => ({
      get: async () => { await sleep(2); return { data: { count: staged } }; },
      set: async ({ data }: { data: { count: number } }) => { await sleep(2); staged = data.count; return {}; },
    }) }) } as CloudTransaction;
    const result = await work(tx);
    if (version !== basis) throw Object.assign(new Error('optimistic transaction was aborted'), { code: 'DATABASE_TRANSACTION_CONFLICT' });
    count = staged; version++; return result;
  } } as CloudDatabase;
  const store = new CloudStore(database);
  const results = await Promise.all(Array.from({ length: 8 }, () => store.transaction(async tx => {
    const previous = await tx.get<{ count: number }>('rpc_limits', 'counter');
    await tx.set('rpc_limits', 'counter', { count: previous!.count + 1 }); return 'committed';
  })));
  assert.equal(results.length, 8); assert(results.every(result => result === 'committed'));
  assert.equal(count, 8); assert.equal(version, 8); assert(attempts >= 8 && attempts <= 64);
  assert(retryArguments.every(value => value === 0));
});
