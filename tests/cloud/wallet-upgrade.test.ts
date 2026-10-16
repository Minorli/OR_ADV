import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const load = createRequire(__filename);
const upgrade = load('../../scripts/cloud-upgrade-wallet.cjs');
const base = load('../../config/database-plan.v3.json');
const indexShape = (row: any) => ({ Name: row.name, Unique: false, Keys: row.fields.map(([Name, direction]: string[]) => ({ Name, Direction: direction === 'asc' ? '1' : '-1' })) });
const deny = () => ({ AclTag: 'CUSTOM', Rule: '{"read":false,"write":false}' });

function fixture() {
  const added = new Map<string, { rule: any; Indexes: any[] }>(), calls: { method: string; name: string }[] = [];
  const context = { options: { execute: true, appId: 'test-app', envId: 'test-env' }, config: { appId: 'test-app', environments: { production: { envId: 'production-env' } } }, selected: { envId: 'test-env' }, plan: base,
    manager: { database: {
      async createCollection(name: string) { calls.push({ method: 'create', name }); assert(!added.has(name)); added.set(name, { rule: null, Indexes: [] }); },
      async describeCollection(name: string) { return { Indexes: added.get(name)!.Indexes }; },
      async updateCollection(name: string, changes: any) { calls.push({ method: 'index', name }); assert.deepEqual(changes.DropIndexes, []); const row = changes.CreateIndexes[0]; added.get(name)!.Indexes.push({ Name: row.IndexName, Unique: row.MgoKeySchema.MgoIsUnique, Keys: row.MgoKeySchema.MgoIndexKeys }); },
    }, commonService() { return { async call({ Action, Param }: any) { if (Action === 'ModifySafeRule') { calls.push({ method: 'deny', name: Param.CollectionName }); assert.equal(Param.EnvId, 'test-env'); added.get(Param.CollectionName)!.rule = { AclTag: Param.AclTag, Rule: Param.Rule }; return {}; } assert.equal(Action, 'DescribeSafeRule'); return added.get(Param.CollectionName)!.rule; } }; } },
  };
  const report = () => ({ collections: base.collections.map((name: string) => ({ name, count: 100, rule: deny(), indexes: base.indexes.filter((row: any) => row.collection === name).map(indexShape) })), otherCollections: [...added.keys()], storageRule: { acl: 'CUSTOM', rule: '{"read":false,"write":false}' }, functions: [{ FunctionName: 'oradv', Status: 'Active' }] });
  return { context, added, calls, report, inspect: async () => report() };
}

test('wallet upgrade adds only five denied collections and four exact indexes; repeated execution performs no mutations', async () => {
  const f = fixture(), before = f.report();
  const result = await upgrade.migrate(f.context, { inspect: f.inspect });
  assert.equal(result.businessRecordsWritten, 0); assert.equal(result.billingChanged, false);
  assert.equal(f.calls.filter(row => row.method === 'create').length, 5); assert.equal(f.calls.filter(row => row.method === 'deny').length, 5); assert.equal(f.calls.filter(row => row.method === 'index').length, 4);
  assert(f.calls.every(row => upgrade.NAMES.includes(row.name)));
  assert.deepEqual(f.report().collections, before.collections); const calls = [...f.calls];
  await upgrade.migrate(f.context, { inspect: f.inspect }); assert.deepEqual(f.calls, calls);
});

test('wrong target, changed original rules/indexes, or foreign resources are rejected before mutation', async () => {
  for (const fault of ['target', 'production', 'rule', 'index', 'foreign', 'function']) {
    const f = fixture();
    if (fault === 'target') f.context.options.envId = 'other';
    if (fault === 'production') f.context.config.environments.production.envId = 'test-env';
    const report = f.report();
    if (fault === 'rule') report.collections[0].rule = { AclTag: 'CUSTOM', Rule: '{"read":true,"write":false}' };
    if (fault === 'index') report.collections.find((row: any) => row.indexes.length)!.indexes[0].Unique = true;
    if (fault === 'foreign') report.otherCollections.push('unrelated');
    if (fault === 'function') report.functions[0].Status = 'Updating';
    await assert.rejects(upgrade.migrate(f.context, { inspect: async () => report })); assert.deepEqual(f.calls, [], fault);
  }
});

test('existing additions must match security rules and index definitions; conflicts are never overwritten', async () => {
  for (const fault of ['rule', 'index']) {
    const f = fixture();
    f.added.set('redemption_catalog', { rule: fault === 'rule' ? { AclTag: 'CUSTOM', Rule: '{"read":true,"write":false}' } : deny(), Indexes: fault === 'index' ? [{ ...indexShape(upgrade.PLAN.indexes[0]), Unique: true }] : [] });
    await assert.rejects(upgrade.migrate(f.context, { inspect: f.inspect })); assert.deepEqual(f.calls, []);
  }
});

test('additive plan rejects removals, duplicate indexes and relaxed client access', () => {
  assert.match(upgrade.validatePlan(), /^[a-f0-9]{64}$/);
  for (const mutate of [(plan: any) => plan.collections.pop(), (plan: any) => plan.indexes.push(plan.indexes[0]), (plan: any) => plan.clientRulesForEveryCollection.read = true]) {
    const plan = structuredClone(upgrade.PLAN); mutate(plan); assert.throws(() => upgrade.validatePlan(plan));
  }
});
