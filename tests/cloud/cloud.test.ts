import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createCloudHandler } from '../../cloudfunctions/oradv/handler';
import { CloudStore, type CloudDatabase, type CloudQuery } from '../../cloudfunctions/oradv/store';
import { MemoryStore } from '../../shared/memory-store';

type Row = Record<string, unknown>;
type Predicate = { op: string; value: unknown };
const comparison = (op: string) => (value: unknown): Predicate => ({ op, value });

test('locked wx-server-sdk 4.0.2 absent-document option preserves collection errors without network', async () => {
  const requireFromFunction = createRequire(resolve('cloudfunctions/oradv/package.json'));
  const cloud = requireFromFunction('wx-server-sdk');
  assert.equal(requireFromFunction('wx-server-sdk/package.json').version, '4.0.2');
  cloud.init({ env: 'offline-test-env' });
  const database = cloud.database({ env: 'offline-test-env', throwOnNotFound: false });
  const reference = database.collection('offline').doc('missing');
  // Replace the SDK's network boundary before making any request.
  reference._document.get = async () => ({ data: [] });
  assert.equal((await reference.get()).data, null);
  reference._document.get = async () => { throw { code: 'DATABASE_COLLECTION_NOT_EXIST', message: 'collection unavailable' }; };
  await assert.rejects(reference.get(), /collection unavailable/);
});

test('CloudBase resolves patched callable lodash methods, including prototype traversal protection', () => {
  const fromFunction = createRequire(resolve('cloudfunctions/oradv/package.json'));
  const fromDatabase = createRequire(fromFunction.resolve('@cloudbase/database'));
  const set = fromDatabase('lodash.set');
  const unset = fromDatabase('lodash.unset');
  assert.equal(typeof set, 'function');
  assert.equal(typeof unset, 'function');
  assert.equal(fromDatabase('lodash.set/package.json').version, '4.18.1-oradv.1');
  assert.equal(fromDatabase('lodash.unset/package.json').version, '4.18.1-oradv.1');
  const row = {};
  assert.equal(set(row, 'profile.rides[0].name', 'ADV'), row);
  assert.deepEqual(row, { profile: { rides: [{ name: 'ADV' }] } });
  assert.equal(unset(row, ['profile', 'rides', '0', 'name']), true);
  assert.deepEqual(row, { profile: { rides: [{}] } });
  const prototype = { preserved: true };
  const target = Object.create(prototype);
  set(target, '__proto__.polluted', true);
  assert.equal('polluted' in prototype, false);
  assert.equal(unset(target, ['__proto__', 'preserved']), false);
  assert.equal(prototype.preserved, true);
  function Victim() {}
  Victim.prototype.preserved = true;
  assert.equal(unset({ constructor: Victim }, [['constructor'], ['prototype'], 'preserved']), false);
  assert.equal(Victim.prototype.preserved, true);
  set({ constructor: Victim }, 'constructor.prototype.polluted', true);
  assert.equal(Victim.prototype.polluted, undefined);
  assert.equal(fromDatabase('axios/package.json').version, '0.34.0');
});
function matches(row: Row, condition: unknown): boolean {
  const value = condition as Row;
  if (value.op === 'and') return (value.value as unknown[]).every((item) => matches(row, item));
  if (value.op === 'or') return (value.value as unknown[]).some((item) => matches(row, item));
  return Object.entries(value).every(([field, predicate]) => {
    const { op, value: expected } = predicate as Predicate;
    if (op === 'eq') return row[field] === expected;
    return op === 'gt' ? (row[field] as number) > (expected as number) : (row[field] as number) < (expected as number);
  });
}

/** This models the wx wrapper API, not a live CloudBase database. */
function sdk(initial: Record<string, Row[]> = {}) {
  const state = structuredClone(initial);
  const writes: unknown[] = [];
  const database: CloudDatabase = {
    command: { and: comparison('and'), or: comparison('or'), eq: comparison('eq'), gt: comparison('gt'), lt: comparison('lt') },
    collection: (collection: string): CloudQuery => {
      let condition: unknown;
      const orders: [string, 'asc' | 'desc'][] = [];
      let limit = 100;
      const query: CloudQuery = {
        doc: (id) => ({
          get: async () => {
            if (!(collection in state)) throw new Error('DATABASE_COLLECTION_NOT_EXIST');
            return { data: structuredClone(state[collection]!.find((row) => row.id === id) ?? null) };
          },
          set: async (options) => { writes.push(options); return {}; },
        }),
        where: (next) => { condition = next; return query; },
        orderBy: (field, direction) => { orders.push([field, direction]); return query; },
        limit: (count) => { limit = count; return query; },
        get: async () => {
          if (!(collection in state)) throw new Error('DATABASE_COLLECTION_NOT_EXIST');
          let rows = state[collection]!.filter((row) => condition === undefined || matches(row, condition));
          rows = [...rows].sort((left, right) => {
            for (const [field, direction] of orders) {
              if (left[field] === right[field]) continue;
              const result = (left[field] as number) < (right[field] as number) ? -1 : 1;
              return direction === 'desc' ? -result : result;
            }
            return 0;
          });
          return { data: structuredClone(rows.slice(0, limit)) };
        },
      };
      return query;
    },
    runTransaction: async (work) => work(database),
  };
  return { database, writes };
}

test('wx transaction distinguishes absent documents from missing collections and wraps set data', async () => {
  const fake = sdk({ users: [{ id: 'one', nickname: '骑友' }] });
  const store = new CloudStore(fake.database);
  await store.transaction(async (tx) => {
    assert.equal(await tx.get('users', 'missing'), null);
    assert.deepEqual(await tx.get('users', 'one'), { id: 'one', nickname: '骑友' });
    await tx.set('users', 'one', { id: 'one', nickname: '更新', _id: 'database-owned', _openid: 'private' });
  });
  assert.deepEqual(fake.writes, [{ data: { id: 'one', nickname: '更新' } }]);
  await assert.rejects(store.transaction((tx) => tx.get('missing_collection', 'one')), /DATABASE_COLLECTION_NOT_EXIST/);
  await assert.rejects(store.transaction(async () => { throw new Error('TRANSACTION_CONFLICT'); }), /TRANSACTION_CONFLICT/);
});

test('compound cursor keeps ascending id tie-break while scores descend and scopes by club', async () => {
  const fake = sdk({ public_rankings: [
    { id: 'd', clubId: 'oradv', score: 9 }, { id: 'c', clubId: 'oradv', score: 10 },
    { id: 'a', clubId: 'oradv', score: 10 }, { id: 'b', clubId: 'other', score: 10 },
  ] });
  const store = new CloudStore(fake.database);
  const rows = await store.query<Row>('public_rankings', { clubId: 'oradv' }, { orderBy: 'score', direction: 'desc', limit: 2, after: { value: 10, id: 'a' } });
  assert.deepEqual(rows.map((row) => row.id), ['c', 'd']);
  await assert.rejects(store.query('public_rankings', {}, { limit: 101 }), /Invalid store query/);
});

const request = { action: 'activity.list', requestId: 'req-1', clubId: 'oradv', payload: {} };
const config = { envId: 'oradv-test-123', appId: 'wx0123456789abcdef', runtimeEnvId: 'oradv-test-123' };
const context = { OPENID: 'trusted-wechat-user', APPID: config.appId, ENV: config.envId };

test('entry trusts only SDK context and rejects environment/app mismatch before accessing store', async () => {
  let touched = false;
  const handler = createCloudHandler({ config: () => config, context: () => ({ ...context, APPID: 'wx1111111111111111' }),
    store: () => { touched = true; return new MemoryStore(); }, invoke: async () => { throw new Error('must not invoke'); }, trace: () => 'trace-1' });
  const wrongApp = await handler(request);
  assert.equal(wrongApp.ok, false);
  if (!wrongApp.ok) assert.equal(wrongApp.error.code, 'UNAUTHENTICATED');
  assert.equal(touched, false);
  const spoof = await handler({ ...request, OPENID: 'owner' });
  if (!spoof.ok) assert.equal(spoof.error.code, 'INVALID_INPUT');
  const wrongEnv = createCloudHandler({ config: () => ({ ...config, runtimeEnvId: 'production-123' }), context: () => context,
    store: () => { throw new Error('must not access'); }, invoke: async () => { throw new Error('must not invoke'); } });
  const result = await wrongEnv(request);
  if (!result.ok) assert.equal(result.error.code, 'TEMPORARY_FAILURE');
  else assert.fail('environment mismatch accepted');
});

test('entry rate limits per trusted identity and rolls into next window without unbounded records', async () => {
  const store = new MemoryStore();
  let now = 0;
  let calls = 0;
  const handler = createCloudHandler({ config: () => config, context: () => context, store: () => store, now: () => now, trace: () => 'trace',
    invoke: async (_request, identity, traceId) => { calls += 1; assert.equal(identity.openId, context.OPENID); return { ok: true, data: 'safe', traceId }; } });
  for (let index = 0; index < 120; index += 1) assert.equal((await handler(request)).ok, true);
  const limited = await handler(request);
  if (!limited.ok) assert.equal(limited.error.code, 'RATE_LIMITED');
  else assert.fail('rate limit accepted');
  now = 60_000;
  assert.equal((await handler(request)).ok, true);
  assert.equal(calls, 121);
  assert.equal(Object.keys(store.snapshot().rpc_limits!).length, 1);
});

test('unexpected backend errors return a redacted retryable envelope', async () => {
  const handler = createCloudHandler({ config: () => config, context: () => context, store: () => new MemoryStore(),
    invoke: async () => { throw new Error('secret=private; openid=private; collection unavailable'); }, trace: () => 'trace-safe' });
  const result = await handler(request);
  assert.equal(result.ok, false);
  if (!result.ok) { assert.equal(result.error.code, 'TEMPORARY_FAILURE'); assert.equal(result.error.retryable, true); }
  assert.equal(JSON.stringify(result).includes('private'), false);
  const tooLarge = await handler({ ...request, payload: { value: 'x'.repeat(17_000) } });
  if (!tooLarge.ok) assert.equal(tooLarge.error.code, 'INVALID_INPUT');
});

test('migration plan has deny rules for all collections and refuses mutation', () => {
  const plan = spawnSync(process.execPath, ['scripts/cloud-plan.cjs'], { encoding: 'utf8' });
  assert.equal(plan.status, 0, plan.stderr);
  const value = JSON.parse(plan.stdout);
  assert.equal(value.remoteVerification, 'NOT_RUN');
  assert.deepEqual(value.plan.clientRulesForEveryCollection, { read: false, write: false });
  assert(value.plan.collections.includes('rpc_limits'));
  const execute = spawnSync(process.execPath, ['scripts/cloud-plan.cjs', '--execute'], { encoding: 'utf8' });
  assert.equal(execute.status, 1);
  assert.match(execute.stderr, /No resources were changed/);
});

test('owner CLI defaults to offline plan and refuses production without reading deployment credentials', () => {
  const directory = mkdtempSync(join(tmpdir(), 'oradv-bootstrap-test-'));
  try {
    const configPath = join(directory, 'local.json');
    writeFileSync(configPath, JSON.stringify({ appId: config.appId, clubId: 'oradv', environments: { test: { envId: config.envId }, production: { envId: 'oradv-production-123' } } }));
    const cli = ['--import', 'tsx', 'scripts/cloud-bootstrap-owner.ts'];
    const plan = spawnSync(process.execPath, [...cli, '--env', 'test', '--config', configPath, '--env-id', config.envId, '--app-id', config.appId, '--member-id', 'member-existing'], { encoding: 'utf8' });
    assert.equal(plan.status, 0, plan.stderr);
    assert.equal(JSON.parse(plan.stdout).mode, 'plan');
    const production = spawnSync(process.execPath, [...cli, '--env', 'production', '--execute'], { encoding: 'utf8' });
    assert.equal(production.status, 1);
    assert.match(production.stderr, /Only an explicit --env test/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
