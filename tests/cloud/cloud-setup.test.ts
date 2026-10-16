import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const nodeRequire = createRequire(__filename);
const tool = nodeRequire('../../scripts/cloud-setup.cjs');
const plan = JSON.parse(fs.readFileSync(path.resolve('config/database-plan.v3.json'), 'utf8'));
const deny = { read: false, write: false };
const appId = 'wx0123456789abcdef', envId = 'oradv-test-123', region = 'ap-shanghai';
function withConfig(run: (file: string) => unknown) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oradv-setup-test-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ appId, clubId: 'oradv', projectPath: 'app/miniprogram', privateKeyPath: path.join(dir, 'absent.key'), environments: { test: { envId, region }, production: { envId: 'different-production' } } }));
  return Promise.resolve().then(() => run(file)).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}
function countResult(count: number) { return { Data: [JSON.stringify([JSON.stringify({ n: { $numberInt: String(count) }, ok: { $numberDouble: '1.0' } })])] }; }
function fake() {
  const collections = new Map<string, { count: number; indexes: any[]; rule: any }>();
  const mutations: any[] = [];
  let functions: any[] = [], storageRule = { acl: 'ADMINONLY', rule: '' };
  const manager = {
    database: {
      async listCollections(args: any) {
        assert.deepEqual(args, { MgoLimit: 1000, MgoOffset: 0 });
        // Deliberately stale count: the guard must use the native count command instead.
        return { Collections: [...collections].map(([CollectionName]) => ({ CollectionName, Count: 0 })), Pager: { Total: collections.size } };
      },
      async runCommands(args: any) {
        assert.equal(args.MgoCommands.length, 1);
        const command = args.MgoCommands[0];
        assert.equal(command.CommandType, 'QUERY');
        assert.deepEqual(JSON.parse(command.Command), { count: command.TableName, query: {} });
        return countResult(collections.get(command.TableName)!.count);
      },
      async describeCollection(name: string) { return { Indexes: structuredClone(collections.get(name)!.indexes) }; },
      async createCollection(name: string) {
        assert.equal(collections.has(name), false); mutations.push(['create', name]);
        collections.set(name, { count: 0, indexes: [{ Name: '_id_', Keys: [{ Name: '_id', Direction: '1' }], Unique: true }], rule: { AclTag: 'ADMINONLY', Rule: '' } }); return {};
      },
      async updateCollection(name: string, args: any) {
        assert.deepEqual(args.DropIndexes, []); assert.equal(args.CreateIndexes.length, 1);
        const index = args.CreateIndexes[0]; assert.equal(index.MgoKeySchema.MgoIsUnique, false);
        assert.ok(index.MgoKeySchema.MgoIndexKeys.every((key: any) => ['1', '-1'].includes(key.Direction)));
        mutations.push(['index', name, index.IndexName]);
        collections.get(name)!.indexes.push({ Name: index.IndexName, Keys: index.MgoKeySchema.MgoIndexKeys, Unique: false }); return {};
      },
    },
    functions: { async getFunctionList(limit: number, offset: number) { assert.equal(limit, 100); assert.equal(offset, 0); return { Functions: functions, TotalCount: functions.length }; } },
    commonService(service: string, version: string) {
      assert.equal(service, 'tcb'); assert.equal(version, '2018-06-08');
      return { async call(args: any) {
        assert.equal(args.Param.EnvId, envId);
        if (args.Action === 'DescribeSafeRule') return collections.get(args.Param.CollectionName)!.rule;
        assert.equal(args.Action, 'ModifySafeRule'); assert.equal(args.Param.AclTag, 'CUSTOM'); assert.deepEqual(JSON.parse(args.Param.Rule), deny);
        mutations.push(['deny', args.Param.CollectionName]);
        collections.get(args.Param.CollectionName)!.rule = { AclTag: args.Param.AclTag, Rule: args.Param.Rule }; return {};
      } };
    },
    storage: {
      async getStorageAcl(args: any) { assert.deepEqual(args, { withRule: true }); return storageRule; },
      async setStorageAcl(acl: string, rule: any) { assert.equal(acl, 'CUSTOM'); assert.deepEqual(rule, deny); mutations.push(['storage']); storageRule = { acl, rule: JSON.stringify(rule) }; return {}; },
    },
  };
  const context = { options: { action: 'apply', execute: true, appId, envId }, config: { appId }, selected: { envId, region }, plan, storage: deny, planHash: tool.validatePlan(plan, deny), manager, databaseTag: 'actual-database-instance' };
  return { context, collections, mutations, setFunctions(value: any[]) { functions = value; } };
}

test('initial cloud setup defaults offline without loading SDK, session credentials or an absent upload key', async () => {
  await withConfig(async file => {
    let connected = false;
    const before = Object.keys(nodeRequire.cache).filter(file => file.includes('@cloudbase'));
    const result = await tool.main(['apply', '--env', 'test', '--config', file], { connect: () => { connected = true; }, output: () => {} });
    assert.equal(connected, false);
    for (const field of ['sdkLoaded', 'credentialsRead', 'privateKeyRead', 'networkCalled']) assert.equal(result[field], false);
    assert.equal(result.collections, 27); assert.equal(result.indexes, 31);
    assert.deepEqual(Object.keys(nodeRequire.cache).filter(file => file.includes('@cloudbase')), before);
  });
});

test('initial cloud setup rejects missing or mismatched target and production environment before connection', async () => {
  await withConfig(async file => {
    let connected = false;
    for (const extra of [[], ['--app-id', appId, '--env-id', 'wrong-target'], ['--app-id', 'wx1111111111111111', '--env-id', envId]]) {
      await assert.rejects(tool.main(['apply', '--env', 'test', '--config', file, '--execute', ...extra], { connect: () => { connected = true; }, output: () => {} }), { code: 'TARGET_CONFIRMATION_REQUIRED' });
    }
    assert.equal(connected, false);
    const original = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...original, environments: { ...original.environments, production: { envId } } }));
    assert.throws(() => tool.loadContext({ action: 'apply', env: 'test', config: file }), { code: 'PRODUCTION_TARGET_REFUSED' });
  });
});

test('initial cloud setup plan rejects permissive rules, unknown collections, unique or malformed indexes', () => {
  for (const mutate of [
    (p: any) => { p.clientRulesForEveryCollection.read = true; },
    (p: any) => { p.collections[0] = 'unexpected'; },
    (p: any) => { p.collections[1] = p.collections[0]; },
    (p: any) => { p.indexes[0].unique = true; },
    (p: any) => { p.indexes[0].fields[0][1] = 'drop'; },
    (p: any) => { p.indexes[0].dropIndexes = ['_id_']; },
    (p: any) => { p.indexes[1] = p.indexes[0]; },
  ]) { const changed = structuredClone(plan); mutate(changed); assert.throws(() => tool.validatePlan(changed, deny), tool.SetupError); }
  assert.throws(() => tool.validatePlan(plan, { read: true, write: false }), { code: 'INVALID_SECURITY_PLAN' });
  assert.equal(tool.validatePlan(plan, deny), tool.validatePlan(structuredClone(plan), deny));
});

test('initial cloud setup accepts only a complete exact running environment response', () => {
  const env = { EnvId: envId, Status: 'NORMAL', Databases: [{ InstanceId: 'db', Status: 'RUNNING', Region: region }], Functions: [{ Namespace: envId, Region: region }], Storages: [{ Bucket: 'bucket', Region: region }] };
  const context = { selected: { envId, region } };
  assert.equal(tool.validateEnvironment({ EnvInfo: env }, context), env);
  for (const change of [{ EnvId: 'another-target' }, { Status: 'SUSPENDED' }, { Databases: [] }, { Functions: [{ Namespace: 'wrong', Region: region }] }, { Storages: [{ Bucket: 'bucket', Region: 'ap-guangzhou' }] }]) assert.throws(() => tool.validateEnvironment({ EnvInfo: { ...env, ...change } }, context), { code: 'ENVIRONMENT_RESOURCE_MISMATCH' });
});

test('native collection counts require successful bounded EJSON output and never treat missing data as zero', () => {
  assert.equal(tool.parseCountResult(countResult(0)), 0); assert.equal(tool.parseCountResult(countResult(17)), 17);
  for (const result of [{}, { Data: [] }, { Data: ['null'] }, { Data: ['[]'] }, { Data: ['["{}"]'] }, countResult(-1), countResult(1.5), { Data: [JSON.stringify([JSON.stringify({ n: null, ok: 1 })])] }, { Data: [JSON.stringify([JSON.stringify({ n: { $numberInt: '0' }, ok: 0 })])] }]) assert.throws(() => tool.parseCountResult(result), { code: 'INVALID_COLLECTION_COUNT' });
});

test('fresh setup creates exact deny rules and nonunique index definitions and empty rerun preserves data and existing indexes', async () => {
  const f = fake();
  const result = await tool.apply(f.context);
  assert.equal(result.collections.length, 27); assert.deepEqual(result.otherCollections, []);
  assert.ok(result.collections.every((collection: any) => collection.count === 0 && tool.denyReadback(collection.rule)));
  assert.ok(tool.storageDenyReadback(result.storageRule));
  for (const name of plan.collections) {
    const created = f.mutations.findIndex(op => op[0] === 'create' && op[1] === name);
    assert.ok(created >= 0); assert.deepEqual(f.mutations[created + 1], ['deny', name]);
  }
  assert.equal(f.mutations.filter(op => op[0] === 'index').length, 31);
  const operations = f.mutations.filter(op => ['create', 'index'].includes(op[0])).length;
  await tool.apply(f.context);
  assert.equal(f.mutations.filter(op => ['create', 'index'].includes(op[0])).length, operations);
  for (const expected of plan.indexes) assert.ok(tool.indexEqual(f.collections.get(expected.collection)!.indexes.find(actual => actual.Name === expected.name), expected));
});

test('v3 setup extends an empty v2 environment without recreating or changing its collections and indexes', async () => {
  const oldPlan = JSON.parse(fs.readFileSync(path.resolve('config/database-plan.v2.json'), 'utf8'));
  const f = fake();
  for (const name of oldPlan.collections) {
    const indexes = [{ Name: '_id_', Keys: [{ Name: '_id', Direction: '1' }], Unique: true },
      ...oldPlan.indexes.filter((index: any) => index.collection === name).map((index: any) => ({ Name: index.name,
        Keys: index.fields.map(([Name, direction]: string[]) => ({ Name, Direction: direction === 'asc' ? '1' : '-1' })), Unique: false }))];
    f.collections.set(name, { count: 0, indexes, rule: { AclTag: 'CUSTOM', Rule: JSON.stringify(deny) } });
  }
  const previous = structuredClone([...f.collections]);
  const result = await tool.apply(f.context);
  assert.equal(result.collections.length, 27);
  const added = plan.collections.filter((name: string) => !oldPlan.collections.includes(name));
  assert.deepEqual(f.mutations.filter(op => op[0] === 'create').map(op => op[1]).sort(), [...added].sort());
  assert.equal(added.length, 9); assert.equal(f.mutations.filter(op => op[0] === 'index').length, 7);
  assert(f.mutations.filter(op => op[0] === 'index').every(op => !oldPlan.collections.includes(op[1])));
  for (const [name, before] of previous) {
    assert.equal(f.collections.get(name)!.count, 0);
    assert.deepEqual(f.collections.get(name)!.indexes, before.indexes, 'v2 index definitions remain unchanged');
    assert(tool.denyReadback(f.collections.get(name)!.rule));
  }
  const occupied = fake();
  occupied.collections.set('member_media', { count: 1, indexes: [], rule: { AclTag: 'CUSTOM', Rule: JSON.stringify(deny) } });
  await assert.rejects(tool.apply(occupied.context), { code: 'BUSINESS_DATA_PRESENT' });
  assert.deepEqual(occupied.mutations, [], 'new private v3 data also prevents empty-environment initialization');
});

test('initial setup refuses real business counts despite stale list count, deployed oradv and index mismatch before writes', async () => {
  for (const mode of ['data', 'function', 'index']) {
    const f = fake();
    f.collections.set('activities', { count: mode === 'data' ? 1 : 0, indexes: mode === 'index' ? [{ Name: plan.indexes[0].name, Keys: [{ Name: 'wrong', Direction: '1' }], Unique: false }] : [], rule: { AclTag: 'CUSTOM', Rule: JSON.stringify(deny) } });
    if (mode === 'function') f.setFunctions([{ FunctionName: 'oradv', Status: 'Active', Runtime: 'Nodejs20.19' }]);
    await assert.rejects(tool.apply(f.context), { code: mode === 'data' ? 'BUSINESS_DATA_PRESENT' : mode === 'function' ? 'EXISTING_ORADV_FUNCTION_REFUSED' : 'INDEX_MISMATCH' });
    assert.deepEqual(f.mutations, []);
  }
});

test('global storage rule setup rejects unrelated collections or functions before any write', async () => {
  for (const mode of ['collection', 'function']) {
    const f = fake();
    if (mode === 'collection') f.collections.set('unrelated', { count: 3, indexes: [], rule: { AclTag: 'ADMINONLY', Rule: '' } });
    else f.setFunctions([{ FunctionName: 'another-app', Status: 'Active', Runtime: 'Nodejs20.19' }]);
    await assert.rejects(tool.apply(f.context), { code: 'SHARED_ENVIRONMENT_REFUSED' });
    assert.deepEqual(f.mutations, []);
    if (mode === 'collection') assert.equal(f.collections.get('unrelated')!.count, 3);
  }
});

test('setup stops immediately if collection deny rules cannot be read back', async () => {
  const f = fake();
  const original = f.context.manager.commonService;
  f.context.manager.commonService = (service: string, version: string) => ({ async call(args: any) { if (args.Action === 'DescribeSafeRule') return { AclTag: 'CUSTOM', Rule: JSON.stringify({ read: true, write: false }) }; return original(service, version).call(args); } });
  await assert.rejects(tool.apply(f.context), { code: 'COLLECTION_RULE_READBACK_MISMATCH' });
  assert.deepEqual(f.mutations, [['create', 'clubs'], ['deny', 'clubs']]);
});

test('setup suppresses SDK private errors and cannot continue from failed or truncated inventory', async () => {
  const f = fake(), sentinel = 'private-session-token-and-personal-data';
  f.context.manager.database.listCollections = async () => { throw new Error(sentinel); };
  let error: any;
  try { await tool.apply(f.context); } catch (caught) { error = caught; }
  assert.equal(tool.safeError(error), 'CLOUD_CALL_FAILED (stage: list-collections)');
  assert.equal(JSON.stringify(error).includes(sentinel), false); assert.deepEqual(f.mutations, []);
  assert.equal(tool.safeError(new Error(sentinel)).includes(sentinel), false);
  const truncated = fake();
  truncated.context.manager.database.listCollections = async () => ({ Collections: [], Pager: { Total: 1 } });
  await assert.rejects(tool.apply(truncated.context), { code: 'COLLECTION_LIMIT_OR_RESPONSE' });
  assert.deepEqual(truncated.mutations, []);
});
