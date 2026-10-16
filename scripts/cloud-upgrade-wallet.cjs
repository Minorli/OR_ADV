#!/usr/bin/env node
'use strict';
// Additive TEST migration. Never runs the empty-environment initializer or changes business records.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const setup = require('./cloud-setup.cjs');
const root = path.resolve(__dirname, '..');
const PLAN = JSON.parse(fs.readFileSync(path.join(root, 'config/database-plan.v4.json'), 'utf8'));
const NAMES = ['points_accounts', 'points_wallet_ledger', 'points_policy_versions', 'redemption_catalog', 'redemption_requests'];
const DENY = { read: false, write: false };
const fail = code => { throw new setup.SetupError(code, 'wallet-upgrade'); };
function validatePlan(plan = PLAN) {
  if (plan.version !== 4 || plan.clubId !== 'oradv' || plan.mode !== 'additive_only' || plan.basePlan !== 'database-plan.v3.json'
    || JSON.stringify(plan.collections) !== JSON.stringify(NAMES) || JSON.stringify(plan.clientRulesForEveryCollection) !== JSON.stringify(DENY)
    || !Array.isArray(plan.indexes) || plan.indexes.length !== 4) fail('INVALID_ADDITIVE_PLAN');
  const seen = new Set();
  for (const index of plan.indexes) {
    const id = index.collection + '/' + index.name;
    if (!NAMES.includes(index.collection) || !/^[a-z][a-z0-9_]{1,63}$/.test(index.name) || index.unique !== false || seen.has(id)
      || !Array.isArray(index.fields) || index.fields.length < 2 || index.fields.length > 5
      || index.fields.some(field => !Array.isArray(field) || field.length !== 2 || !/^[a-zA-Z][a-zA-Z0-9]{0,63}$/.test(field[0]) || !['asc','desc'].includes(field[1]))
      || new Set(index.fields.map(field => field[0])).size !== index.fields.length) fail('INVALID_ADDITIVE_INDEX');
    seen.add(id);
  }
  return createHash('sha256').update(JSON.stringify(plan)).digest('hex');
}
function baseline(report, context) {
  if (report.collections.length !== context.plan.collections.length || report.otherCollections.some(name => !NAMES.includes(name))
    || report.collections.some(row => !setup.denyReadback(row.rule)) || !setup.storageDenyReadback(report.storageRule)
    || report.functions.length !== 1 || report.functions[0].FunctionName !== 'oradv' || report.functions[0].Status !== 'Active') fail('BASELINE_NOT_VERIFIED');
  for (const index of context.plan.indexes) {
    const matches = report.collections.find(row => row.name === index.collection)?.indexes.filter(row => row.Name === index.name);
    if (matches?.length !== 1 || !setup.indexEqual(matches[0], index)) fail('BASELINE_INDEX_MISMATCH');
  }
}
async function rule(context, name) {
  return setup.call('wallet-rule', () => context.manager.commonService('tcb', '2018-06-08').call({ Action: 'DescribeSafeRule', Param: { EnvId: context.selected.envId, CollectionName: name } }));
}
async function describe(context, name) {
  const detail = await setup.call('wallet-indexes', () => context.manager.database.describeCollection(name));
  if (!Array.isArray(detail?.Indexes) || detail.Indexes.length > 100) fail('INVALID_INDEX_RESPONSE');
  return detail;
}
async function migrate(context, dependencies = {}) {
  validatePlan();
  if (!context.options.execute || context.options.appId !== context.config.appId || context.options.envId !== context.selected.envId || context.selected.envId === context.config.environments?.production?.envId) fail('TARGET_CONFIRMATION_REQUIRED');
  const inspect = dependencies.inspect || setup.inspect;
  const before = await inspect(context); baseline(before, context);
  // Preflight every existing addition before doing any writes. No rule overwrite or index drop.
  const existing = new Map();
  for (const name of before.otherCollections) {
    if (!setup.denyReadback(await rule(context, name))) fail('EXISTING_WALLET_RULE_MISMATCH');
    const detail = await describe(context, name);
    for (const index of PLAN.indexes.filter(row => row.collection === name)) {
      const matches = detail.Indexes.filter(row => row.Name === index.name);
      if (matches.length > 1 || matches.length === 1 && !setup.indexEqual(matches[0], index)) fail('EXISTING_WALLET_INDEX_MISMATCH');
    }
    existing.set(name, detail);
  }
  for (const name of NAMES) {
    if (!existing.has(name)) {
      await setup.call('wallet-create', () => context.manager.database.createCollection(name));
      await setup.call('wallet-deny', () => context.manager.commonService('tcb', '2018-06-08').call({ Action: 'ModifySafeRule', Param: { EnvId: context.selected.envId, CollectionName: name, AclTag: 'CUSTOM', Rule: JSON.stringify(DENY) } }));
    }
    if (!setup.denyReadback(await rule(context, name))) fail('WALLET_RULE_READBACK_MISMATCH');
    for (const index of PLAN.indexes.filter(row => row.collection === name)) {
      if (!existing.get(name)?.Indexes.some(row => row.Name === index.name)) {
        await setup.call('wallet-index-create', () => context.manager.database.updateCollection(name, { CreateIndexes: [{ IndexName: index.name, MgoKeySchema: { MgoIndexKeys: index.fields.map(([Name, direction]) => ({ Name, Direction: direction === 'asc' ? '1' : '-1' })), MgoIsUnique: false } }], DropIndexes: [] }));
      }
      const matches = (await describe(context, name)).Indexes.filter(row => row.Name === index.name);
      if (matches.length !== 1 || !setup.indexEqual(matches[0], index)) fail('WALLET_INDEX_READBACK_MISMATCH');
    }
  }
  const after = await inspect(context); baseline(after, context);
  if (after.otherCollections.length !== NAMES.length || NAMES.some(name => !after.otherCollections.includes(name))) fail('WALLET_COLLECTION_READBACK_MISMATCH');
  for (const name of NAMES) if (!setup.denyReadback(await rule(context, name))) fail('WALLET_RULE_READBACK_MISMATCH');
  return { target: 'test', version: 4, planHash: validatePlan(), baselineCollections: 27, addedCollections: 5, addedIndexes: 4, denyRulesVerified: true, businessRecordsWritten: 0, billingChanged: false };
}
async function main(args = process.argv.slice(2)) {
  const context = setup.loadContext(setup.parse(['inspect', ...args]));
  const planHash = validatePlan();
  if (!context.options.execute) return { mode: 'OFFLINE_PLAN', target: 'test', version: 4, planHash, addedCollections: 5, addedIndexes: 4, networkCalled: false, credentialsRead: false };
  return migrate(await setup.connect(context));
}
if (require.main === module) main().then(result => { console.log(JSON.stringify(result)); process.exit(0); }, error => { console.error(setup.safeError(error)); process.exit(2); });
module.exports = { PLAN, NAMES, validatePlan, baseline, migrate, main };
