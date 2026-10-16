import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { bootstrapOwner } from '../shared/owner-bootstrap';
import { withMetadata } from '../shared/store';
import { DomainError } from '../shared/errors';

class BootstrapError extends Error {}

const HELP = `Usage: node work/cloud-bootstrap-owner.cjs --env test --config config/local.json
  --env-id REAL_ENV_ID --app-id wxAPPID --member-id EXISTING_MEMBER_ID [--execute]

Default: prints an offline plan only. Run npm run build first.
Execution is TEST ONLY, never creates a user, never enables a public bootstrap API.
Obtain the member ID by logging in through the deployed mini program first.
Execution requires authorized deployment credentials in TENCENTCLOUD_SECRETID and
TENCENTCLOUD_SECRETKEY (optional TENCENTCLOUD_SESSIONTOKEN), outside the repository.
Device-code tcb login alone does not provide these credentials to this script.
Grant this deployment identity only the database rights needed for initialization.
No credentials are read or SDK network calls made without --execute.
The first successful grant assigns member number 0 and closes the marker atomically.
Any previous positive number remains retired and is never reused.
`;

function args(argv: string[]): Record<string, string | boolean> {
  const result: Record<string, string | boolean> = {};
  const values = new Set(['--env', '--config', '--env-id', '--app-id', '--member-id']);
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index]!;
    if (option in result) throw new BootstrapError(`Duplicate option: ${option}`);
    if (option === '--help' || option === '--execute') result[option] = true;
    else if (values.has(option) && argv[index + 1] && !argv[index + 1]!.startsWith('--')) result[option] = argv[++index]!;
    else throw new BootstrapError(`Unknown or incomplete option: ${option}`);
  }
  return result;
}

interface Result { data?: unknown; code?: unknown }
interface Doc { get(): Promise<Result>; set(data: unknown): Promise<Result> }
interface Tx { collection(name: string): { doc(id: string): Doc } }
interface Database {
  collection(name: string): { where(filter: unknown): { limit(n: number): { get(): Promise<Result> } } };
  runTransaction<T>(callback: (tx: Tx) => Promise<T>): Promise<T>;
}
function document<T>(result: Result): T | null {
  if (result.code) throw new BootstrapError('Cloud database rejected the operation');
  if (result.data === null || (Array.isArray(result.data) && result.data.length === 0)) return null;
  const value = Array.isArray(result.data) ? result.data[0] : result.data;
  if (!value || typeof value !== 'object') throw new BootstrapError('Cloud database returned an unexpected document');
  return value as T;
}
async function put(doc: Doc, value: unknown): Promise<void> {
  const result = await doc.set(value);
  if (result.code) throw new BootstrapError('Cloud database rejected the operation');
}

async function main(): Promise<void> {
  const options = args(process.argv.slice(2));
  if (options['--help']) { console.log(HELP); return; }
  if (options['--env'] !== 'test') throw new BootstrapError('Only an explicit --env test is accepted');
  const envId = options['--env-id'];
  const appId = options['--app-id'];
  const memberId = options['--member-id'];
  if (typeof envId !== 'string' || !/^[a-zA-Z0-9_-]{5,100}$/.test(envId) || /placeholder|REAL_ENV|<|>/i.test(envId)) throw new BootstrapError('A real --env-id is required');
  if (typeof appId !== 'string' || !/^wx[a-fA-F0-9]{16}$/.test(appId)) throw new BootstrapError('A real --app-id is required');
  if (typeof memberId !== 'string' || !/^[a-zA-Z0-9_:-]{1,128}$/.test(memberId)) throw new BootstrapError('An existing --member-id is required');
  if (typeof options['--config'] !== 'string') throw new BootstrapError('--config must identify your ignored local configuration');
  const config = JSON.parse(readFileSync(resolve(options['--config']), 'utf8'));
  if (config.appId !== appId || config.clubId !== 'oradv' || config.environments?.test?.envId !== envId
    || config.environments?.production?.envId === envId) throw new BootstrapError('AppID/test EnvId must exactly match configuration and differ from production');

  console.log(JSON.stringify({ mode: options['--execute'] ? 'execute' : 'plan', env: 'test', envId, appId, clubId: 'oradv', memberId,
    actions: ['Verify existing member and trusted active user in this AppID', 'Refuse existing owner, zero claim or bootstrap marker', 'Atomically reserve member number 0, keep any retired positive claim, grant owner, audit deployment credential fingerprint and close marker'],
  }, null, 2));
  if (!options['--execute']) return;
  const secretId = process.env.TENCENTCLOUD_SECRETID;
  const secretKey = process.env.TENCENTCLOUD_SECRETKEY;
  if (!secretId || !secretKey) throw new BootstrapError('Authorized deployment credentials are missing; see --help');
  const requireFromFunction = createRequire(resolve('cloudfunctions/oradv/package.json'));
  const cloudbase = requireFromFunction('@cloudbase/node-sdk');
  const database: Database = cloudbase.init({ env: envId, secretId, secretKey, sessionToken: process.env.TENCENTCLOUD_SESSIONTOKEN }).database();
  const owners = await database.collection('staff_roles').where({ clubId: 'oradv', role: 'owner', enabled: true }).limit(1).get();
  if (owners.code || !Array.isArray(owners.data)) throw new BootstrapError('Cannot verify existing owners');
  if (owners.data.length > 0) throw new BootstrapError('An owner already exists; use normal in-product role management');
  const actorId = `deployment:${createHash('sha256').update(secretId).digest('hex')}`;
  const traceId = randomUUID();
  const now = new Date().toISOString();
  await database.runTransaction(async (tx) => {
    await bootstrapOwner(withMetadata({
      get: async <T>(collection: string, id: string) => document<T>(await tx.collection(collection).doc(id).get()),
      set: async <T>(collection: string, id: string, value: T) => {
        const clean = value && typeof value === 'object' && !Array.isArray(value)
          ? Object.fromEntries(Object.entries(value).filter(([field]) => !['_id', '_openid'].includes(field))) : value;
        await put(tx.collection(collection).doc(id), clean);
      },
    }, now), { clubId: 'oradv', appId, memberId, actorId, traceId, envId, now });
  });
  console.log(JSON.stringify({ ok: true, traceId, memberNumber: 0, message: 'Owner granted; member zero reserved; one-time bootstrap closed' }));
}

main().catch((error) => {
  // SDK errors may contain credential details; never dump them to terminal logs.
  console.error(error instanceof BootstrapError || error instanceof DomainError ? error.message : 'Owner initialization failed. Check deployment permissions and database state. Use --help.');
  process.exitCode = 1;
});
