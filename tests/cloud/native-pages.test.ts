import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { createCloudHandler } from '../../cloudfunctions/oradv/handler';
import { createDemoStore } from '../../shared/demo';
import { createService } from '../../shared/service';
import { userIdFor } from '../../shared/models';

const app = resolve(__dirname, '../../app/miniprogram');
const runtime = { mode: 'cloud', appId: 'wx0123456789abcdef', envId: 'native-pages-offline', version: 'offline-native-test' };
function nativeSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? nativeSources(path) : entry.name.endsWith('.ts') ? [path] : [];
  });
}

test('cloud-mode native tabs, consented login and private dossier accept enriched platform events through the real handler', async t => {
  const output = mkdtempSync(join(tmpdir(), 'oradv-native-cloud-')), sources = nativeSources(app), modules = new Set(sources);
  const load = createRequire(__filename), globals = globalThis as unknown as Record<string, any>;
  const originalWx = globals.wx, originalPage = globals.Page;
  t.after(() => {
    globals.wx = originalWx; globals.Page = originalPage;
    for (const key of Object.keys(load.cache)) if (key.startsWith(output + sep)) delete load.cache[key];
    rmSync(output, { recursive: true, force: true });
  });
  // Separate outputs and a fixed public config make this independent of the
  // normal mock build, local credentials and whichever artifact is deployed.
  await build({ entryPoints: sources, outbase: app, outdir: output, bundle: true, platform: 'browser', format: 'cjs', target: 'es2017',
    define: { __ORADV_MODE__: '"cloud"' }, logLevel: 'silent', plugins: [{ name: 'isolated-native-cloud', setup(builder) {
      builder.onResolve({ filter: /^\.{1,2}\// }, args => {
        const candidate = resolve(dirname(args.importer), args.path.endsWith('.ts') ? args.path : args.path + '.ts');
        if (!modules.has(candidate)) return;
        let path = relative(dirname(args.importer), candidate).split(sep).join('/').replace(/\.ts$/, '');
        if (!path.startsWith('.')) path = './' + path;
        return { path, external: true };
      });
      builder.onLoad({ filter: /runtime-config\.json$/ }, () => ({ contents: JSON.stringify(runtime), loader: 'json' }));
    } }] });

  const now = '2026-10-16T12:00:00.000Z', store = createDemoStore(now), service = createService(store, { now: () => now });
  const trusted = { OPENID: 'native-pages-trusted-user', APPID: runtime.appId, ENV: runtime.envId };
  const forged = { appId: 'wxffffffffffffffff', openId: 'untrusted-event-user', roles: ['owner'], memberNumber: 0 };
  const requests: string[] = [], failures: { action: string; code: string }[] = [];
  const handler = createCloudHandler({ config: () => ({ ...runtime, runtimeEnvId: runtime.envId }), context: () => trusted, store: () => store,
    now: () => Date.parse(now), invoke: (request, identity, traceId) => {
      assert.equal((request as unknown as Record<string, unknown>).userInfo, undefined);
      assert.deepEqual(identity, { appId: runtime.appId, openId: trusted.OPENID });
      return service.handle(request, identity, traceId);
    } });
  const storage = new Map<string, unknown>();
  globals.wx = {
    env: { USER_DATA_PATH: '/offline-native-data' },
    getStorageSync: (key: string) => structuredClone(storage.get(key)), setStorageSync: (key: string, value: unknown) => storage.set(key, structuredClone(value)),
    getStorageInfoSync: () => ({ keys: [...storage.keys()] }), removeStorageSync: (key: string) => storage.delete(key),
    showToast() {}, showModal: async () => ({ confirm: true }), navigateTo() {}, switchTab() {}, stopPullDownRefresh() {},
    cloud: { async callFunction({ name, data }: { name: string; data: Record<string, unknown> }) {
      assert.equal(name, 'oradv');
      // WeChat serializes the client's object, then enriches the function event.
      const wire = JSON.parse(JSON.stringify(data));
      requests.push(wire.action);
      const result = await handler({ ...wire, userInfo: forged });
      if (!result.ok) failures.push({ action: wire.action, code: result.error.code });
      return { result: JSON.parse(JSON.stringify(result)) };
    } },
  };
  function page(name: string): any {
    let definition: any; globals.Page = (value: unknown) => { definition = value; };
    load(join(output, 'pages', name + '.js'));
    assert(definition, `${name} registers the actual native Page`);
    const instance = { ...definition, data: structuredClone(definition.data) };
    instance.setData = (values: Record<string, unknown>, callback?: () => void) => {
      for (const [key, value] of Object.entries(values)) {
        const parts = key.split('.'); let target = instance.data;
        for (const part of parts.slice(0, -1)) target = target[part];
        target[parts[parts.length - 1]] = value;
      }
      callback?.();
    };
    return instance;
  }
  const api = load(join(output, 'services/api.js'));
  assert.equal(api.isMock, false);
  const tabs = ['activities/index', 'ranking/index', 'history/index', 'profile/index'].map(page);
  for (const tab of tabs) { await tab.load(); assert.equal(tab.data.error, ''); }
  assert(tabs[0].data.items.length > 0, 'public activities remain browseable before consent');
  assert.equal(tabs[3].data.member, null);
  assert.equal(Object.values(store.snapshot().users).some((row: any) => row.wxOpenId === trusted.OPENID), false, 'browsing does not establish membership');
  tabs[3].consent({ detail: { value: ['accepted'] } }); await tabs[3].save();
  assert.equal(tabs[3].data.error, ''); assert(tabs[3].data.member);
  assert.deepEqual(tabs[3].data.member.roles, []); assert(tabs[3].data.member.memberNumber > 0);
  const identity = { appId: runtime.appId, openId: trusted.OPENID };
  assert.equal((store.snapshot().users[userIdFor(identity)] as any).wxOpenId, trusted.OPENID);
  assert.equal(store.snapshot().users[userIdFor({ appId: forged.appId, openId: forged.openId })], undefined);
  for (const tab of tabs) { await tab.load(); assert.equal(tab.data.error, ''); }
  assert.equal(tabs[1].data.ownRanking.rank, null); assert.equal(tabs[1].data.ownRanking.publicCount, null);
  const dossier = page('dossier/index'); dossier.onLoad({}); await dossier.load(); assert.equal(dossier.data.error, '');
  dossier.field({ currentTarget: { dataset: { field: 'riderName' } }, detail: { value: '私人成员资料' } });
  await dossier.save(); assert.equal(dossier.data.error, ''); assert.equal(dossier.data.dossier.draft.riderName, '私人成员资料');
  for (const name of ['learning/index', 'skills/index']) { const item = page(name); await item.load(); assert.equal(item.data.error, ''); }
  assert(failures.every(row => row.code === 'UNAUTHENTICATED'), JSON.stringify(failures));
  for (const action of ['activity.list', 'ranking.list', 'recommendation.list', 'club.public', 'club.content.get', 'identity.me', 'identity.ensure', 'ranking.mine', 'dossier.mine', 'dossier.save', 'learning.catalog', 'skills.mine']) {
    assert(requests.includes(action), `${action} crossed the native JSON/enriched-event transport`);
  }
  await assert.rejects(api.call('dossier.mine', { injected: true }), (error: any) => error instanceof api.ApiError && error.code === 'INVALID_INPUT', 'business field validation still returns the real cloud ApiError');
});
