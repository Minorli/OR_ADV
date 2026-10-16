#!/usr/bin/env node
'use strict';
// TEST-only: add one public-history query index. No document, rule or billing writes.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const setup = require('./cloud-setup.cjs');
const wallet = require('./cloud-upgrade-wallet.cjs');
const root = path.resolve(__dirname, '..');
const read = name => JSON.parse(fs.readFileSync(path.join(root, 'config', name), 'utf8'));
const BASE = read('database-plan.v3.json'), WALLET = read('database-plan.v4.json'), PLAN = read('database-plan.v5.json');
const INDEX = { collection: 'activities', name: 'club_state_start_desc_id', fields: [['clubId', 'asc'], ['state', 'asc'], ['startAt', 'desc'], ['id', 'asc']], unique: false };
const EXPECTED = { version: 5, clubId: 'oradv', basePlans: ['database-plan.v3.json', 'database-plan.v4.json'], mode: 'indexes_only', collections: [], indexes: [INDEX] };
const canonical = value => JSON.stringify(value, (_key, current) => current && typeof current === 'object' && !Array.isArray(current)
  ? Object.fromEntries(Object.keys(current).sort().map(key => [key, current[key]])) : current);
const fail = code => { throw new setup.SetupError(code, 'history-upgrade'); };
function validatePlan(plan = PLAN) {
  if (canonical(plan) !== canonical(EXPECTED)) fail('INVALID_HISTORY_INDEX_PLAN');
  setup.validatePlan(BASE, { read: false, write: false }); wallet.validatePlan(WALLET);
  return createHash('sha256').update(canonical({ plan, base: BASE, wallet: WALLET })).digest('hex');
}
function target(context) {
  if (!context.options.execute || context.options.env !== 'test' || context.config.clubId !== 'oradv'
    || context.options.appId !== context.config.appId || context.options.envId !== context.selected.envId
    || context.selected.envId !== context.config.environments?.test?.envId
    || context.selected.region !== context.config.environments?.test?.region
    || context.selected.envId === context.config.environments?.production?.envId
    || !/^wx[a-zA-Z0-9]{16}$/.test(context.config.appId || '') || !/^[a-zA-Z0-9][a-zA-Z0-9-]{3,127}$/.test(context.selected.envId || '')) fail('TARGET_CONFIRMATION_REQUIRED');
  if (canonical(context.plan) !== canonical(BASE)) fail('BASELINE_PLAN_MISMATCH');
}
function verifyIndexes(rows, planned, code) {
  if (!Array.isArray(rows) || rows.length > 100 || new Set(rows.map(row => row.Name)).size !== rows.length) fail('INVALID_INDEX_RESPONSE');
  for (const index of planned) {
    const matches = rows.filter(row => row.Name === index.name);
    if (matches.length !== 1 || !setup.indexEqual(matches[0], index)) fail(code);
  }
}
async function inventory(context, inspect) {
  const report = await inspect(context);
  if (report.target !== 'test' || report.appId !== context.config.appId || report.envId !== context.selected.envId
    || !Array.isArray(report.collections) || report.collections.length !== 27
    || canonical(report.collections.map(row => row.name).sort()) !== canonical([...BASE.collections].sort())
    || !Array.isArray(report.otherCollections) || canonical([...report.otherCollections].sort()) !== canonical([...WALLET.collections].sort())
    || !setup.storageDenyReadback(report.storageRule) || !Array.isArray(report.functions) || report.functions.length !== 1
    || report.functions[0].FunctionName !== 'oradv' || report.functions[0].Status !== 'Active') fail('BASELINE_NOT_VERIFIED');
  const indexes = new Map();
  for (const row of report.collections) {
    if (!setup.denyReadback(row.rule)) fail('BASELINE_RULE_MISMATCH');
    verifyIndexes(row.indexes, BASE.indexes.filter(index => index.collection === row.name), 'BASELINE_INDEX_MISMATCH');
    indexes.set(row.name, row.indexes);
  }
  for (const name of WALLET.collections) {
    const rule = await setup.call('history-read-rule', () => context.manager.commonService('tcb', '2018-06-08').call({ Action: 'DescribeSafeRule', Param: { EnvId: context.selected.envId, CollectionName: name } }));
    if (!setup.denyReadback(rule)) fail('BASELINE_RULE_MISMATCH');
    const detail = await setup.call('history-read-indexes', () => context.manager.database.describeCollection(name));
    verifyIndexes(detail?.Indexes, WALLET.indexes.filter(index => index.collection === name), 'BASELINE_INDEX_MISMATCH');
    indexes.set(name, detail.Indexes);
  }
  const selected = indexes.get(INDEX.collection).filter(row => row.Name === INDEX.name);
  if (selected.length > 1 || selected.length === 1 && !setup.indexEqual(selected[0], INDEX)) fail('EXISTING_HISTORY_INDEX_MISMATCH');
  return { indexes, present: selected.length === 1 };
}
const preserved = indexes => canonical([...indexes].map(([collection, rows]) => [collection,
  rows.filter(row => collection !== INDEX.collection || row.Name !== INDEX.name).map(({ Name, Keys, Unique }) => ({ Name, Keys, Unique })).sort((a, b) => a.Name.localeCompare(b.Name)),
]).sort(([a], [b]) => a.localeCompare(b)));
async function migrate(context, dependencies = {}) {
  const planHash = validatePlan(); target(context);
  const inspect = dependencies.inspect || setup.inspect;
  const before = await inventory(context, inspect);
  if (!before.present) await setup.call('history-create-index', () => context.manager.database.updateCollection(INDEX.collection, {
    CreateIndexes: [{ IndexName: INDEX.name, MgoKeySchema: { MgoIndexKeys: INDEX.fields.map(([Name, direction]) => ({ Name, Direction: direction === 'asc' ? '1' : '-1' })), MgoIsUnique: false } }], DropIndexes: [],
  }));
  const sleep = dependencies.sleep || (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  let found = false;
  for (let attempt = 0; attempt < 10; attempt++) {
    const detail = await setup.call('history-index-readback', () => context.manager.database.describeCollection(INDEX.collection));
    if (!Array.isArray(detail?.Indexes) || detail.Indexes.length > 100) fail('INVALID_INDEX_RESPONSE');
    const matches = detail.Indexes.filter(row => row.Name === INDEX.name);
    if (matches.length > 1 || matches.length === 1 && !setup.indexEqual(matches[0], INDEX)) fail('HISTORY_INDEX_READBACK_MISMATCH');
    if (matches.length === 1) { found = true; break; }
    if (attempt < 9) await sleep(500);
  }
  if (!found) fail('HISTORY_INDEX_READBACK_TIMEOUT');
  const after = await inventory(context, inspect);
  if (!after.present) fail('HISTORY_INDEX_READBACK_MISMATCH');
  if (preserved(before.indexes) !== preserved(after.indexes)) fail('BASELINE_CHANGED_DURING_UPGRADE');
  return { target: 'test', version: 5, planHash, baselineCollections: 32, baselineIndexes: 35, addedCollections: 0, addedIndexes: before.present ? 0 : 1,
    indexAlreadyPresent: before.present, finalPlannedIndexes: 36, denyRulesVerified: true, storageDenyVerified: true,
    businessRecordsWritten: 0, rulesWritten: 0, billingChanged: false };
}
async function main(args = process.argv.slice(2)) {
  const context = setup.loadContext(setup.parse(['inspect', ...args])), planHash = validatePlan();
  if (!context.options.execute) return { mode: 'OFFLINE_PLAN', target: 'test', version: 5, planHash, baselineCollections: 32, baselineIndexes: 35,
    addedCollections: 0, addedIndexes: 1, networkCalled: false, credentialsRead: false };
  return migrate(await setup.connect(context));
}
if (require.main === module) main().then(result => { console.log(JSON.stringify(result)); process.exit(0); }, error => { console.error(setup.safeError(error)); process.exit(2); });
module.exports = { PLAN, INDEX, validatePlan, migrate, main };
