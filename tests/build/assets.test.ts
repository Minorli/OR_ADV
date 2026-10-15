import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
const assets = require('../../scripts/asset-inventory.cjs') as {
  inventory(project: string): string[];
  hashes(project: string): Record<string, string>;
  verify(project: string, meta: object): string[];
  safeOutputDirectory(root: string, output: string): string;
};

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'oradv-assets-'));
  const app = join(root, 'app');
  mkdirSync(app);
  writeFileSync(join(app, 'app.js'), 'App({})');
  writeFileSync(join(app, 'app.json'), '{"pages":["pages/home"]}');
  writeFileSync(join(app, 'runtime-config.json'), '{"mode":"mock","envId":""}');
  return { root, app, clean: () => rmSync(root, { recursive: true, force: true }) };
}
test('successful-build hashes reject tampered/stale compiled assets and added files', () => {
  const f = fixture();
  try {
    const meta = { artifactHashes: assets.hashes(f.app) };
    assert.doesNotThrow(() => assets.verify(f.app, meta));
    writeFileSync(join(f.app, 'app.js'), 'App({staleCloudEnv:"test"})');
    assert.throws(() => assets.verify(f.app, meta), /Compiled assets differ/);
    assert.throws(() => assets.verify(f.app, {}), /no artifact hashes/);
    const changed = { artifactHashes: assets.hashes(f.app) };
    writeFileSync(join(f.app, 'old.js'), 'old build');
    assert.throws(() => assets.verify(f.app, changed), /Compiled assets differ/);
  } finally { f.clean(); }
});
test('one inventory rejects private files, unknown assets and symlinks before suffix exclusions', () => {
  const f = fixture();
  try {
    for (const name of ['secrets.txt', 'secret-config.json', 'private.upload.key', 'local.json', 'notes.txt']) {
      writeFileSync(join(f.app, name), 'harmless canary');
      assert.throws(() => assets.inventory(f.app), /Private|Unsupported/);
      rmSync(join(f.app, name));
    }
    writeFileSync(join(f.root, 'outside.json'), 'harmless outside canary');
    symlinkSync(join(f.root, 'outside.json'), join(f.app, 'innocent.json'));
    assert.throws(() => assets.inventory(f.app), /Symbolic links/);
    rmSync(join(f.app, 'innocent.json'));
    symlinkSync(join(f.root, 'outside.json'), join(f.app, 'ignored.ts'));
    assert.throws(() => assets.inventory(f.app), /Symbolic links/);
  } finally { f.clean(); }
});
test('private tool settings and source files are consistently excluded; output links cannot escape', () => {
  const f = fixture();
  const outside = mkdtempSync(join(tmpdir(), 'oradv-outside-'));
  try {
    writeFileSync(join(f.app, 'project.private.config.json'), '{}');
    writeFileSync(join(f.app, 'source.ts'), 'source');
    writeFileSync(join(f.app, 'app.js.map'), '{}');
    assert(!assets.inventory(f.app).some((name: string) => /private|\.ts$|\.map$/.test(name)));
    symlinkSync(outside, join(f.root, 'escape'));
    assert.throws(() => assets.safeOutputDirectory(f.root, join(f.root, 'escape/output')), /symbolic links/);
    assert.throws(() => assets.safeOutputDirectory(f.root, outside), /inside repository/);
    assert.equal(assets.safeOutputDirectory(f.root, join(f.root, 'work/output')), join(f.root, 'work/output'));
  } finally { f.clean(); rmSync(outside, { recursive: true, force: true }); }
});
