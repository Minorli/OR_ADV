import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { buildCloudBetaSeed, canonical, rowDigest, TARGET } from './seed-cloud-beta-data';
import type { SeedBundle, SeedGuard, SeedGroup, SeedRow } from './seed-cloud-beta-data';

type Row = Record<string, unknown>;
export interface SeedTransaction {
  get(collection: string, id: string): Promise<Row | null>;
  set(collection: string, id: string, value: Row): Promise<void>;
  remove(collection: string, id: string): Promise<void>;
}
export interface SeedDatabase {
  target: SeedRuntimeTarget;
  get(collection: string, id: string): Promise<Row | null>;
  transaction<T>(work: (tx: SeedTransaction) => Promise<T>): Promise<T>;
}
export interface SeedRuntimeTarget { clubId: string; region: string; purpose: 'test'; envId: string; appId: string }
export class SeedError extends Error {}
function fail(code: string): never { throw new SeedError(code); }
function validate(db: SeedDatabase, bundle: SeedBundle) {
  if (db.target.clubId !== TARGET.clubId || db.target.region !== TARGET.region || db.target.purpose !== 'test'
    || !/^[a-zA-Z0-9_-]{5,100}$/.test(db.target.envId) || !/^wx[a-fA-F0-9]{16}$/.test(db.target.appId)) fail('SEED_TARGET_REQUIRED');
  if (canonical(bundle) !== canonical(buildCloudBetaSeed())) fail('SEED_PLAN_CHANGED');
  if (bundle.groups.some(group => group.rows.length * 2 + group.guards.length + bundle.globalGuards.length > 100)) fail('SEED_GROUP_TOO_LARGE');
}
function unchanged(row: SeedRow, current: Row | null): boolean {
  if (current === null) return false;
  if (rowDigest(current) !== rowDigest(row.data)) fail('SEED_ROW_CHANGED');
  return true;
}
async function guard(reader: Pick<SeedTransaction, 'get'>, ids: SeedGuard[]) {
  for (const row of ids) if (await reader.get(row.collection, row.id)) fail('SEED_GUARD_OCCUPIED');
}
/** Inspect explicit manifest IDs only. No collection scans or real-user lookups. */
export async function inspectCloudBetaSeed(db: SeedDatabase, bundle: SeedBundle) {
  validate(db, bundle); await guard(db, bundle.guards);
  const manifest = await db.get(bundle.manifest.collection, bundle.manifest.id);
  if (manifest) unchanged(bundle.manifest, manifest);
  let existing = 0, missing = 0;
  for (const group of bundle.groups) for (const row of group.rows) {
    if (unchanged(row, await db.get(row.collection, row.id))) existing++; else missing++;
  }
  if (!manifest && existing) fail('SEED_MANIFEST_MISSING');
  return { existing, missing, manifestPresent: !!manifest };
}
async function checkGroup(tx: SeedTransaction, group: SeedGroup, globals: SeedGuard[]): Promise<SeedRow[]> {
  await guard(tx, [...globals, ...group.guards]);
  const present: SeedRow[] = [];
  for (const row of group.rows) if (unchanged(row, await tx.get(row.collection, row.id))) present.push(row);
  return present;
}
export async function applyCloudBetaSeed(db: SeedDatabase, bundle = buildCloudBetaSeed()) {
  await inspectCloudBetaSeed(db, bundle);
  let inserted = await db.transaction(async tx => {
    await guard(tx, bundle.globalGuards);
    if (unchanged(bundle.manifest, await tx.get(bundle.manifest.collection, bundle.manifest.id))) return 0;
    await tx.set(bundle.manifest.collection, bundle.manifest.id, bundle.manifest.data); return 1;
  });
  for (const group of bundle.groups) inserted += await db.transaction(async tx => {
    const present = new Set((await checkGroup(tx, group, bundle.globalGuards)).map(row => `${row.collection}/${row.id}`));
    const missing = group.rows.filter(row => !present.has(`${row.collection}/${row.id}`));
    for (const row of missing) await tx.set(row.collection, row.id, row.data);
    return missing.length;
  });
  const readback = await inspectCloudBetaSeed(db, bundle);
  if (readback.missing) fail('SEED_READBACK_INCOMPLETE');
  return { ok: true, operation: 'apply', datasetId: bundle.datasetId, hash: bundle.hash, inserted, records: readback.existing,
    realMemberPointsChanged: false, memberNumberControlsChanged: false };
}
/** Every activity and its seeded dependent rows are removed in one CAS transaction.
 * A genuine registration changes the activity revision and makes cleanup refuse. */
export async function cleanupCloudBetaSeed(db: SeedDatabase, bundle = buildCloudBetaSeed()) {
  const before = await inspectCloudBetaSeed(db, bundle); let deleted = 0;
  if (!before.existing && !before.manifestPresent) return { ok: true, operation: 'cleanup', datasetId: bundle.datasetId, deleted };
  for (const group of [...bundle.groups].reverse()) deleted += await db.transaction(async tx => {
    const present = await checkGroup(tx, group, bundle.globalGuards);
    for (const row of present) await tx.remove(row.collection, row.id);
    return present.length;
  });
  const readback = await inspectCloudBetaSeed(db, bundle);
  if (readback.existing) fail('SEED_CLEANUP_INCOMPLETE');
  deleted += await db.transaction(async tx => {
    await guard(tx, bundle.globalGuards);
    if (!unchanged(bundle.manifest, await tx.get(bundle.manifest.collection, bundle.manifest.id))) return 0;
    await tx.remove(bundle.manifest.collection, bundle.manifest.id); return 1;
  });
  return { ok: true, operation: 'cleanup', datasetId: bundle.datasetId, deleted,
    realMemberPointsChanged: false, memberNumberControlsChanged: false };
}

const HELP = `Usage: node --import tsx scripts/seed-cloud-beta.ts [plan|apply|cleanup]
  [--env test --env-id ACTUAL_TEST_ENV_ID --app-id wxAPPID]
  [--config config/local.json --expected-sha256 PLAN_HASH --execute]

Default is a local plan. No credentials or cloud SDK are read without --execute.
Apply/cleanup require the exact configured test environment, approved plan hash,
and deployment credentials supplied in TENCENTCLOUD_SECRETID/SECRETKEY with optional
TENCENTCLOUD_SESSIONTOKEN. Never pass credentials on the command line.
Only this separately authorized fictional dataset is inserted; existing records,
member number controls, owner bootstrap, qualifications and real points are untouched.
Cleanup refuses modified records and removes only unchanged manifest-owned rows.
After owner bootstrap, automatic cleanup refuses all changes: review subsequent
qualifications, staff activity scopes and other dependencies manually. The bootstrap
marker is checked in every import/delete transaction, including manifest removal.
Genuine registrations also change the activity CAS hash and prevent cleanup.
`;
function options(argv: string[]) {
  const result: Record<string, string | boolean> = { action: 'plan' };
  const values = new Set(['--env', '--env-id', '--app-id', '--config', '--expected-sha256']);
  if (argv[0] && !argv[0].startsWith('--')) result.action = argv.shift()!;
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index]; if (name in result) fail('SEED_DUPLICATE_ARGUMENT');
    if (['--execute', '--help'].includes(name)) result[name] = true;
    else if (values.has(name) && argv[index + 1] && !argv[index + 1].startsWith('--')) result[name] = argv[++index];
    else fail('SEED_ARGUMENT_INVALID');
  }
  return result;
}
function connection(target: SeedRuntimeTarget): SeedDatabase {
  const secretId = process.env.TENCENTCLOUD_SECRETID, secretKey = process.env.TENCENTCLOUD_SECRETKEY;
  if (!secretId || !secretKey) fail('SEED_DEPLOYMENT_CREDENTIALS_REQUIRED');
  const fromFunction = createRequire(resolve(__dirname, '../cloudfunctions/oradv/package.json'));
  if (fromFunction('@cloudbase/node-sdk/package.json').version !== '3.17.2') fail('SEED_PINNED_SDK_REQUIRED');
  const cloudbase = fromFunction('@cloudbase/node-sdk');
  const raw = cloudbase.init({ env: target.envId, region: target.region, secretId, secretKey, sessionToken: process.env.TENCENTCLOUD_SESSIONTOKEN }).database();
  const document = (result: { code?: unknown; data?: unknown }): Row | null => {
    if (result.code) fail('SEED_DATABASE_READ_REJECTED');
    if (result.data === null || Array.isArray(result.data) && result.data.length === 0) return null;
    const data = Array.isArray(result.data) ? result.data[0] : result.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) fail('SEED_DATABASE_SHAPE_INVALID');
    return data as Row;
  };
  return {
    target,
    get: async (collection, id) => document(await raw.collection(collection).doc(id).get()),
    transaction: work => raw.runTransaction(async (tx: any) => work({
      get: async (collection, id) => document(await tx.collection(collection).doc(id).get()),
      set: async (collection, id, value) => { const result = await tx.collection(collection).doc(id).set(value); if (result?.code) fail('SEED_DATABASE_WRITE_REJECTED'); },
      remove: async (collection, id) => { const result = await tx.collection(collection).doc(id).remove(); if (result?.code || result?.deleted !== 1) fail('SEED_DELETE_NOT_CONFIRMED'); },
    })),
  };
}
export async function main(argv = process.argv.slice(2)) {
  const args = options([...argv]); if (args['--help']) { console.log(HELP); return; }
  if (!['plan', 'apply', 'cleanup'].includes(String(args.action))) fail('SEED_ARGUMENT_INVALID');
  if (args['--env'] !== undefined && args['--env'] !== 'test') fail('SEED_TARGET_REQUIRED');
  let target: SeedRuntimeTarget | undefined;
  if (args['--config'] !== undefined || args['--env-id'] !== undefined || args['--app-id'] !== undefined || args['--execute']) {
    const envId = args['--env-id'], appId = args['--app-id'], configPath = args['--config'];
    if (args['--env'] !== 'test' || typeof envId !== 'string' || !/^[a-zA-Z0-9_-]{5,100}$/.test(envId)
      || typeof appId !== 'string' || !/^wx[a-fA-F0-9]{16}$/.test(appId) || typeof configPath !== 'string') fail('SEED_TARGET_REQUIRED');
    const config = JSON.parse(readFileSync(resolve(configPath), 'utf8'));
    if (config.appId !== appId || config.clubId !== TARGET.clubId || config.environments?.test?.envId !== envId
      || config.environments?.production?.envId === envId) fail('SEED_TARGET_REQUIRED');
    target = { ...TARGET, envId, appId };
  }
  const bundle = buildCloudBetaSeed(), counts: Record<string, number> = {};
  for (const row of bundle.groups.flatMap(group => group.rows)) counts[row.collection] = (counts[row.collection] ?? 0) + 1;
  const plan = { operation: args.action, remote: 'NOT_RUN', target: target ?? TARGET, datasetId: bundle.datasetId, referenceAt: bundle.referenceAt,
    hash: bundle.hash, counts, groups: bundle.groups.length, manifestRecords: 1, fictionalMembers: 8, assignedMemberNumbers: 0,
    realMemberPointsChanged: false, ownerRolesGranted: 0, mediaOrReviewsInvented: false };
  if (!args['--execute']) { console.log(JSON.stringify(plan, null, 2)); return; }
  if (!target || args.action === 'plan' || args['--expected-sha256'] !== bundle.hash) fail('SEED_EXACT_PLAN_AND_TARGET_REQUIRED');
  if (args.action === 'apply' && bundle.groups.flatMap(group => group.rows).some(row => row.collection === 'activities'
    && row.data.state === 'published' && Date.parse(String(row.data.applicationClosesAt)) <= Date.now())) fail('SEED_DATES_STALE');
  const db = connection(target);
  const result = args.action === 'apply' ? await applyCloudBetaSeed(db, bundle) : await cleanupCloudBetaSeed(db, bundle);
  console.log(JSON.stringify({ ...result, target, remote: 'VERIFIED' }, null, 2));
}
if ((require as unknown as NodeRequire).main === module) main().catch(error => {
  console.error(error instanceof SeedError ? error.message : 'SEED_REMOTE_FAILURE'); process.exitCode = 1;
});
