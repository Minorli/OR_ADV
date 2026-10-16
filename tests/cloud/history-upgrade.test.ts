import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const load = createRequire(__filename), upgrade = load('../../scripts/cloud-upgrade-history.cjs');
const base = load('../../config/database-plan.v3.json'), wallet = load('../../config/database-plan.v4.json');
const shape = (index: any) => ({ Name: index.name, Unique: false, Keys: index.fields.map(([Name, direction]: string[]) => ({ Name, Direction: direction === 'asc' ? '1' : '-1' })) });
const deny = () => ({ AclTag: 'CUSTOM', Rule: '{"read":false,"write":false}' });
function fixture() {
  const indexes = new Map<string, any[]>(), rules = new Map<string, any>(), writes: any[] = [];
  for (const name of [...base.collections, ...wallet.collections]) { indexes.set(name, [...base.indexes, ...wallet.indexes].filter(index => index.collection === name).map(shape)); rules.set(name, deny()); }
  indexes.get('activities')!.push({ Name: '_id_', Unique: true, Keys: [{ Name: '_id', Direction: '1' }] });
  const context: any = { options: { execute: true, env: 'test', appId: 'wx0123456789abcdef', envId: 'history-test-env' },
    config: { appId: 'wx0123456789abcdef', clubId: 'oradv', environments: { test: { envId: 'history-test-env', region: 'ap-shanghai' }, production: { envId: 'history-production-env' } } },
    selected: { envId: 'history-test-env', region: 'ap-shanghai' }, plan: base,
    manager: { database: {
      async describeCollection(name: string) { return { Indexes: structuredClone(indexes.get(name)) }; },
      async updateCollection(name: string, changes: any) { writes.push({ name, changes: structuredClone(changes) }); assert.equal(name, 'activities'); assert.deepEqual(changes.DropIndexes, []);
        assert.equal(changes.CreateIndexes.length, 1); const index = changes.CreateIndexes[0]; assert.equal(index.MgoKeySchema.MgoIsUnique, false);
        indexes.get(name)!.push({ Name: index.IndexName, Unique: false, Keys: index.MgoKeySchema.MgoIndexKeys }); },
      createCollection() { throw Error('collection writes forbidden'); }, runCommands() { throw Error('document writes forbidden'); },
    }, commonService() { return { async call({ Action, Param }: any) { assert.equal(Action, 'DescribeSafeRule', 'no security-rule write'); assert.equal(Param.EnvId, 'history-test-env'); return rules.get(Param.CollectionName); } }; } },
  };
  const report = () => ({ target: 'test', appId: context.config.appId, envId: context.selected.envId,
    collections: base.collections.map((name: string) => ({ name, count: 27, rule: rules.get(name), indexes: structuredClone(indexes.get(name)) })), otherCollections: [...wallet.collections],
    functions: [{ FunctionName: 'oradv', Status: 'Active' }], storageRule: { acl: 'CUSTOM', rule: '{"read":false,"write":false}' } });
  return { indexes, rules, writes, context, report, inspect: async () => report() };
}
test('history migration adds exactly one descending nonunique index and preserves all thirty-five original planned indexes', async () => {
  const f = fixture(), original = structuredClone([...f.indexes]); const result = await upgrade.migrate(f.context, { inspect: f.inspect });
  assert.equal(f.writes.length, 1); assert.equal(result.baselineCollections, 32); assert.equal(result.baselineIndexes, 35); assert.equal(result.finalPlannedIndexes, 36);
  assert.equal(result.addedCollections, 0); assert.equal(result.addedIndexes, 1); assert.equal(result.businessRecordsWritten, 0); assert.equal(result.rulesWritten, 0); assert.equal(result.billingChanged, false);
  for (const [name, indexes] of original) assert.deepEqual(f.indexes.get(name)!.filter(index => index.Name !== upgrade.INDEX.name), indexes);
  const again = await upgrade.migrate(f.context, { inspect: f.inspect }); assert.equal(again.addedIndexes, 0); assert.equal(again.indexAlreadyPresent, true); assert.equal(f.writes.length, 1);
});
test('wrong environment, AppID or production alias is refused before inspection or mutation', async () => {
  for (const fault of ['execute', 'env', 'appid', 'envid', 'production', 'binding', 'region', 'plan']) {
    const f = fixture(); let inspected = 0;
    if (fault === 'execute') f.context.options.execute = false;
    if (fault === 'env') f.context.options.env = 'production';
    if (fault === 'appid') f.context.options.appId = 'wx1111111111111111';
    if (fault === 'envid') f.context.options.envId = 'other-env';
    if (fault === 'production') f.context.config.environments.production.envId = f.context.selected.envId;
    if (fault === 'binding') f.context.config.environments.test.envId = 'another-test';
    if (fault === 'region') f.context.selected.region = 'ap-other';
    if (fault === 'plan') f.context.plan = { ...base, collections: [] };
    await assert.rejects(upgrade.migrate(f.context, { inspect: async () => { inspected++; return f.report(); } })); assert.equal(inspected, 0, fault); assert.deepEqual(f.writes, []);
  }
});
test('every existing base and wallet rule/index plus storage and active function is checked before the only permitted write', async () => {
  for (const fault of ['base-rule', 'wallet-rule', 'base-index', 'wallet-index', 'storage', 'function', 'foreign', 'missing-wallet', 'wrong-report']) {
    const f = fixture();
    if (fault === 'base-rule') f.rules.set('activities', { AclTag: 'CUSTOM', Rule: '{"read":true,"write":false}' });
    if (fault === 'wallet-rule') f.rules.set('points_accounts', { AclTag: 'ADMINONLY', Rule: '{}' });
    if (fault === 'base-index') f.indexes.get('activities')![0].Unique = true;
    if (fault === 'wallet-index') f.indexes.get('redemption_catalog')![0].Keys[0].Direction = '-1';
    const report = f.report();
    if (fault === 'storage') report.storageRule.rule = '{"read":true,"write":false}';
    if (fault === 'function') report.functions[0].Status = 'Updating';
    if (fault === 'foreign') report.otherCollections.push('foreign_collection');
    if (fault === 'missing-wallet') report.otherCollections.pop();
    if (fault === 'wrong-report') report.envId = 'unrelated-env';
    await assert.rejects(upgrade.migrate(f.context, { inspect: async () => report })); assert.deepEqual(f.writes, [], fault);
  }
});
test('same-name conflicting or duplicate history index is never replaced or dropped', async () => {
  for (const fault of ['unique', 'direction', 'duplicate']) {
    const f = fixture(), index = shape(upgrade.INDEX);
    if (fault === 'unique') index.Unique = true;
    if (fault === 'direction') index.Keys[2].Direction = '1';
    f.indexes.get('activities')!.push(index); if (fault === 'duplicate') f.indexes.get('activities')!.push(shape(upgrade.INDEX));
    await assert.rejects(upgrade.migrate(f.context, { inspect: f.inspect })); assert.deepEqual(f.writes, []);
  }
});
test('readback failures and changed preexisting indexes are reported without repairing or deleting anything', async () => {
  for (const fault of ['missing-created', 'unplanned-index-deleted']) {
    const f = fixture(), update = f.context.manager.database.updateCollection;
    f.context.manager.database.updateCollection = async (...args: any[]) => {
      await update(...args);
      if (fault === 'missing-created') f.indexes.set('activities', f.indexes.get('activities')!.filter(index => index.Name !== upgrade.INDEX.name));
      else f.indexes.set('activities', f.indexes.get('activities')!.filter(index => index.Name !== '_id_'));
    };
    await assert.rejects(upgrade.migrate(f.context, { inspect: f.inspect, sleep: async () => {} })); assert.equal(f.writes.length, 1);
  }
});
test('the history plan cannot add collections, unique indexes, rule changes or another query shape', () => {
  assert.match(upgrade.validatePlan(), /^[a-f0-9]{64}$/);
  for (const mutate of [(p: any) => p.collections.push('new_collection'), (p: any) => p.indexes[0].unique = true,
    (p: any) => p.indexes[0].fields[2][1] = 'asc', (p: any) => p.indexes.push(p.indexes[0]), (p: any) => p.clientRules = { read: true }]) {
    const plan = structuredClone(upgrade.PLAN); mutate(plan); assert.throws(() => upgrade.validatePlan(plan));
  }
});
test('offline history plan reads no credentials and never loads a remote connection', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'history-plan-'));
  try {
    const config = join(directory, 'config.json'); writeFileSync(config, JSON.stringify({ appId: 'wx0123456789abcdef', clubId: 'oradv', projectPath: 'app/miniprogram', privateKeyPath: join(directory, 'placeholder-only.key'),
      environments: { test: { envId: 'history-test-env', region: 'ap-shanghai' }, production: { envId: 'history-production-env' } } }));
    const result = await upgrade.main(['--env', 'test', '--config', config]); assert.equal(result.mode, 'OFFLINE_PLAN'); assert.equal(result.networkCalled, false); assert.equal(result.credentialsRead, false); assert.equal(result.addedIndexes, 1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
