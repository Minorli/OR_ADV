import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import * as esbuild from 'esbuild';

const appRoot = resolve(__dirname, '../../app/miniprogram');

interface SubpackageManifest {
  root: string;
  name: string;
  pages: string[];
}

interface AppManifest {
  pages: string[];
  subpackages?: SubpackageManifest[];
  preloadRule?: Record<string, { network?: string; packages: string[] }>;
  tabBar: { list: { pagePath: string }[] };
  usingComponents?: Record<string, string>;
}

function walkFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? walkFiles(full) : [full];
  });
}

function ownerPackage(relPath: string, roots: string[]): string {
  const normalized = relPath.replace(/\\/g, '/');
  for (const root of roots) {
    if (normalized === root || normalized.startsWith(root + '/')) return root;
  }
  return '__MAIN__';
}

function resolveComponentTarget(fromFile: string, ref: string): string {
  const clean = ref.startsWith('/')
    ? resolve(appRoot, ref.slice(1))
    : resolve(dirname(fromFile), ref);
  return relative(appRoot, clean).replace(/\\/g, '/');
}

test('manifest defines five isolated high-data subpackages with non-overlapping roots and valid preload rules', () => {
  const manifest = JSON.parse(readFileSync(join(appRoot, 'app.json'), 'utf8')) as AppManifest;
  assert.deepEqual(manifest.pages, [
    'pages/activities/index',
    'pages/ranking/index',
    'pages/history/index',
    'pages/profile/index',
  ]);
  const subpackages = manifest.subpackages ?? [];
  assert.deepEqual(subpackages.map(pkg => pkg.name), [
    'pkg-trip',
    'pkg-archive',
    'pkg-academy',
    'pkg-rider',
    'pkg-ops',
  ]);
  const roots = subpackages.map(pkg => pkg.root);
  assert.deepEqual(roots, [
    'subpackages/trip',
    'subpackages/archive',
    'subpackages/academy',
    'subpackages/rider',
    'subpackages/ops',
  ]);
  const totalRoutes = manifest.pages.length + subpackages.reduce((sum, pkg) => sum + pkg.pages.length, 0);
  assert.equal(totalRoutes, 17, 'all 17 routes must remain registered across main and subpackages');

  const preload = manifest.preloadRule ?? {};
  assert.deepEqual(Object.keys(preload).sort(), [
    'pages/activities/index',
    'pages/history/index',
    'pages/profile/index',
  ]);
  for (const [trigger, rule] of Object.entries(preload)) {
    assert.ok(manifest.pages.includes(trigger), `preload trigger ${trigger} must be a main-package tab`);
    assert.ok(!rule.packages.includes('pkg-ops'), `${trigger} must not preload staff-only pkg-ops for ordinary riders`);
  }
});

test('main package never imports subpackages synchronously and subpackages never cross-import each other', () => {
  const manifest = JSON.parse(readFileSync(join(appRoot, 'app.json'), 'utf8')) as AppManifest;
  const roots = (manifest.subpackages ?? []).map(pkg => pkg.root);
  const allFiles = walkFiles(appRoot);

  for (const file of allFiles) {
    const rel = relative(appRoot, file).replace(/\\/g, '/');
    const callerPkg = ownerPackage(rel, roots);

    if (file.endsWith('.js')) {
      const tsTwin = file.slice(0, -3) + '.ts';
      assert.ok(existsSync(tsTwin), `Orphan compiled JS without TypeScript source: ${rel}`);
      const content = readFileSync(file, 'utf8');
      for (const match of content.matchAll(/require\(["']([^"']+)["']\)/g)) {
        const spec = match[1];
        if (!spec.startsWith('.') && !spec.startsWith('/')) continue;
        const base = spec.startsWith('/') ? resolve(appRoot, spec.slice(1)) : resolve(dirname(file), spec);
        const resolved = /\.(js|json)$/.test(base) ? base : `${base}.js`;
        assert.ok(existsSync(resolved), `${rel}: missing required module ${spec}`);
        const targetRel = relative(appRoot, resolved).replace(/\\/g, '/');
        const targetPkg = ownerPackage(targetRel, roots);
        if (callerPkg === '__MAIN__') {
          assert.equal(targetPkg, '__MAIN__', `Main package JS ${rel} cannot require subpackage file ${targetRel}`);
        } else {
          assert.ok(targetPkg === '__MAIN__' || targetPkg === callerPkg,
            `Subpackage JS ${rel} (${callerPkg}) cannot require across into ${targetRel} (${targetPkg})`);
        }
      }
    } else if (file.endsWith('.wxml')) {
      const content = readFileSync(file, 'utf8');
      for (const match of content.matchAll(/<(?:include|import)\s+[^>]*src=["']([^"']+)["']/g)) {
        const spec = match[1];
        const resolved = spec.startsWith('/') ? resolve(appRoot, spec.slice(1)) : resolve(dirname(file), spec);
        assert.ok(existsSync(resolved), `${rel}: missing WXML include/import ${spec}`);
        const targetRel = relative(appRoot, resolved).replace(/\\/g, '/');
        const targetPkg = ownerPackage(targetRel, roots);
        assert.equal(targetPkg, callerPkg, `WXML ${rel} (${callerPkg}) cannot include/import across package boundary ${targetRel} (${targetPkg})`);
      }
    } else if (file.endsWith('.wxss')) {
      const content = readFileSync(file, 'utf8');
      for (const match of content.matchAll(/@import\s+["']([^"']+)["']/g)) {
        const spec = match[1];
        const resolved = spec.startsWith('/') ? resolve(appRoot, spec.slice(1)) : resolve(dirname(file), spec);
        assert.ok(existsSync(resolved), `${rel}: missing WXSS @import ${spec}`);
        const targetRel = relative(appRoot, resolved).replace(/\\/g, '/');
        const targetPkg = ownerPackage(targetRel, roots);
        if (callerPkg === '__MAIN__') {
          assert.equal(targetPkg, '__MAIN__', `Main package WXSS ${rel} cannot @import subpackage style ${targetRel}`);
        } else {
          assert.ok(targetPkg === '__MAIN__' || targetPkg === callerPkg,
            `Subpackage WXSS ${rel} (${callerPkg}) cannot @import across into ${targetRel} (${targetPkg})`);
        }
      }
    } else if (file.endsWith('.json') && !['build-meta.json', 'runtime-config.json', 'project.config.json', 'sitemap.json'].includes(rel)) {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
        usingComponents?: Record<string, string>;
        componentPlaceholder?: Record<string, string>;
      };
      const using = parsed.usingComponents ?? {};
      const placeholders = parsed.componentPlaceholder ?? {};
      for (const [tag, ref] of Object.entries(using)) {
        const targetRel = resolveComponentTarget(file, ref);
        assert.ok(existsSync(join(appRoot, targetRel + '.json')), `${rel}: missing component ${ref}`);
        const targetPkg = ownerPackage(targetRel, roots);
        if (targetPkg !== '__MAIN__' && targetPkg !== callerPkg) {
          const placeholderTag = placeholders[tag];
          assert.ok(placeholderTag, `${rel}: cross-package component "${tag}" -> ${targetRel} must declare componentPlaceholder`);
          if (placeholderTag !== 'view') {
            const placeholderRef = using[placeholderTag];
            assert.ok(placeholderRef, `${rel}: custom componentPlaceholder "${placeholderTag}" must be declared in usingComponents`);
            const placeholderRel = resolveComponentTarget(file, placeholderRef);
            assert.equal(ownerPackage(placeholderRel, roots), callerPkg,
              `${rel}: componentPlaceholder "${placeholderTag}" must reside in the same package (${callerPkg})`);
          }
        }
      }
    }
  }
});

test('each package stays well within WeChat 2 MiB budget and cloud mode strips mock fixtures from services/api.js', async () => {
  const manifest = JSON.parse(readFileSync(join(appRoot, 'app.json'), 'utf8')) as AppManifest;
  const subpackages = manifest.subpackages ?? [];
  const roots = subpackages.map(pkg => pkg.root);
  const sizes = new Map<string, number>([['__MAIN__', 0], ...roots.map(r => [r, 0] as [string, number])]);

  for (const file of walkFiles(appRoot)) {
    const rel = relative(appRoot, file).replace(/\\/g, '/');
    if (rel === 'project.private.config.json' || rel.endsWith('.ts') || rel.endsWith('.map')) continue;
    const pkg = ownerPackage(rel, roots);
    sizes.set(pkg, (sizes.get(pkg) ?? 0) + statSync(file).size);
  }

  const WECHAT_SINGLE_PACKAGE_LIMIT = 2 * 1024 * 1024;
  const mainBytes = sizes.get('__MAIN__') ?? 0;
  assert.ok(mainBytes < 1600 * 1024, `Main package (${mainBytes} bytes) exceeded 1600 KiB raw budget`);
  for (const pkg of subpackages) {
    const pkgBytes = sizes.get(pkg.root) ?? 0;
    assert.ok(pkgBytes > 0, `Subpackage ${pkg.name} cannot be empty`);
    assert.ok(pkgBytes < 512 * 1024, `Subpackage ${pkg.name} (${pkgBytes} bytes) exceeded 512 KiB current budget (keep >1.5 MiB growth headroom)`);
    assert.ok(pkgBytes < WECHAT_SINGLE_PACKAGE_LIMIT);
  }

  const byName = new Map(subpackages.map(pkg => [pkg.name, sizes.get(pkg.root) ?? 0]));
  for (const [trigger, rule] of Object.entries(manifest.preloadRule ?? {})) {
    const preloadBytes = rule.packages.reduce((sum, name) => sum + (byName.get(name) ?? 0), 0);
    assert.ok(preloadBytes < WECHAT_SINGLE_PACKAGE_LIMIT, `preloadRule on ${trigger} (${preloadBytes} bytes) exceeded WeChat 2 MiB preload cap`);
  }

  const cloudBundle = await esbuild.build({
    entryPoints: [join(appRoot, 'services/api.ts')],
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'cjs',
    target: 'es2017',
    minify: true,
    define: { __ORADV_MODE__: '"cloud"' },
    external: ['../runtime-config.json', './profile-avatar', './member-media-local'],
  });
  const cloudApiText = cloudBundle.outputFiles[0].text;
  assert.ok(Buffer.byteLength(cloudApiText) < 10 * 1024, `Cloud services/api.js (${Buffer.byteLength(cloudApiText)} bytes) must stay < 10 KiB`);
  assert.doesNotMatch(cloudApiText, /fictional-member|createShowcaseStore|seedLearningDemo/);
});
