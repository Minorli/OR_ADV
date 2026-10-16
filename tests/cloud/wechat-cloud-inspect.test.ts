import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const nodeRequire = createRequire(__filename);
const tool = nodeRequire('../../scripts/wechat-cloud-inspect.cjs');
const appId = 'wx0123456789abcdef', envId = 'oradv-test-123', region = 'ap-shanghai';
function withConfig(run: (file: string) => unknown) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oradv-cloud-test-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ appId, clubId: 'oradv', projectPath: 'app/miniprogram', privateKeyPath: path.join(dir, 'absent.key'), environments: { test: { envId, region }, production: { envId: 'different-production' } } }));
  return Promise.resolve().then(() => run(file)).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}
function environment() {
  return { envId, status: 'NORMAL', databases: [{ instanceId: 'actual-database-instance', region, status: 'RUNNING' }], functions: [{ region, namespace: envId }], storages: [{ region, bucket: 'private-test-bucket' }] };
}

test('environment inspect is offline by default without loading SDK, connecting or reading an absent upload key', async () => {
  await withConfig(async file => {
    let connections = 0;
    const before = Object.keys(nodeRequire.cache).filter(file => file.includes('miniprogram-ci'));
    const result = await tool.main(['inspect', '--env', 'test', '--config', file], { connect: () => { connections++; throw new Error('network forbidden'); }, output: () => {} });
    assert.equal(connections, 0);
    assert.equal(result.privateKeyRead, false); assert.equal(result.sdkLoaded, false); assert.equal(result.networkCalled, false);
    assert.deepEqual(Object.keys(nodeRequire.cache).filter(file => file.includes('miniprogram-ci')), before);
  });
});

test('environment inspect rejects mismatched explicit targets and production before SDK or network', async () => {
  await withConfig(async file => {
    let connected = false;
    for (const extra of [[], ['--app-id', appId, '--env-id', 'wrong-target'], ['--app-id', 'wx1111111111111111', '--env-id', envId]]) {
      await assert.rejects(tool.main(['inspect', '--env', 'test', '--config', file, '--execute', ...extra], { connect: () => { connected = true; }, output: () => {} }), { code: 'TARGET_CONFIRMATION_REQUIRED' });
    }
    assert.equal(connected, false);
    const original = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...original, environments: { ...original.environments, production: { envId } } }));
    assert.throws(() => tool.loadContext({ action: 'inspect', env: 'test', config: file }), { code: 'PRODUCTION_TARGET_REFUSED' });
  });
});

test('environment inspect only accepts read-only inspect action and rejects malformed config or arguments', async () => {
  for (const action of ['apply', 'create', 'purchase', 'billing', 'deploy']) assert.throws(() => tool.parse([action, '--env', 'test', '--config', 'unused']), { code: 'INVALID_ACTION' });
  for (const args of [['inspect', '--env', 'production', '--config', 'unused'], ['inspect', '--env', 'test', '--config', 'unused', '--env', 'test'], ['inspect', '--env', 'test', '--config', 'unused', '--unknown']]) assert.throws(() => tool.parse(args), tool.CloudInspectError);
  await withConfig(file => {
    const original = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const change of [{ appId: 'not-wx' }, { clubId: 'another' }, { privateKeyPath: path.resolve('key-inside-repo.key') }, { projectPath: '../arbitrary' }, { environments: { test: { envId, region: '' } } }]) {
      fs.writeFileSync(file, JSON.stringify({ ...original, ...change }));
      assert.throws(() => tool.loadContext({ action: 'inspect', env: 'test', config: file }), tool.CloudInspectError);
    }
  });
});

test('environment inspect verifies exact target, region, namespace and running resource states', () => {
  const expected = environment(), context = { selected: { envId, region } };
  assert.equal(tool.validateEnvironment({ envList: [expected] }, context), expected);
  for (const mutate of [
    (e: any) => { e.envId = 'some-other-environment'; },
    (e: any) => { e.status = 'SUSPENDED'; },
    (e: any) => { e.databases[0].status = 'INIT'; },
    (e: any) => { e.databases[0].region = 'ap-guangzhou'; },
    (e: any) => { e.functions[0].namespace = 'another-namespace'; },
    (e: any) => { e.storages[0].bucket = ''; },
  ]) {
    const changed = structuredClone(expected); mutate(changed);
    assert.throws(() => tool.validateEnvironment({ envList: [changed] }, context), tool.CloudInspectError);
  }
  assert.throws(() => tool.validateEnvironment({ envList: [expected, expected] }, context), { code: 'BOUND_ENVIRONMENT_NOT_FOUND' });
});

test('environment inspect rejects loose or symlinked keys before loading SDK or connecting', async () => {
  await withConfig(async file => {
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(config.privateKeyPath, 'fictional-not-a-private-key', { mode: 0o644 });
    const context = tool.loadContext({ action: 'inspect', env: 'test', config: file, execute: true, appId, envId });
    await assert.rejects(tool.connect(context), { code: 'KEY_MODE_600_REQUIRED' });
    const destination = config.privateKeyPath + '.real';
    fs.renameSync(config.privateKeyPath, destination); fs.chmodSync(destination, 0o600);
    fs.symlinkSync(destination, config.privateKeyPath);
    await assert.rejects(tool.connect(context), { code: 'SYMLINK_REFUSED' });
  });
});

test('successful environment inspection reports only metadata and explicitly leaves business/security/billing checks not run', async () => {
  await withConfig(async file => {
    let saved: any, output = '';
    const report = await tool.main(['inspect', '--env', 'test', '--config', file, '--execute', '--app-id', appId, '--env-id', envId], {
      connect: (context: any) => ({ ...context, environment: environment() }),
      saveReport: (report: any) => { saved = report; return 'work/cloud-reports/fake.json'; },
      output: (message: string) => { output = message; },
    });
    assert.equal(saved, report);
    assert.equal(report.metadataVerification, 'VERIFIED');
    assert.equal(report.mutationsPerformed, false);
    assert.ok(Object.values(report.remoteVerification).every(value => value === 'NOT_RUN'));
    assert.equal(JSON.stringify(report).includes('private-test-bucket'), false);
    assert.equal(JSON.stringify(report).includes('actual-database-instance'), false);
    assert.equal(output.includes('privateKeyPath'), false);
    assert.equal(JSON.parse(output).remoteChecks, 'NOT_RUN');
  });
});

test('SDK errors are sanitized without exposing private response details', async () => {
  const sentinel = 'private-token-and-personal-data';
  let caught: any;
  try { await tool.cloudCall('environment', async () => { throw new Error(sentinel); }); } catch (error) { caught = error; }
  assert.equal(tool.safeError(caught), 'CLOUD_CALL_FAILED (stage: environment)');
  assert.equal(tool.safeError(new Error(sentinel)).includes(sentinel), false);
  assert.equal(JSON.stringify(caught).includes(sentinel), false);
  await assert.rejects(tool.cloudCall('environment', async () => { throw new Error('-1 invalid cloud api action DescribeSafeRule'); }), { code: 'UNSUPPORTED_CLOUD_ACTION' });
});
