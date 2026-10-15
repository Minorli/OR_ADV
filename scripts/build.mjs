import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { selectBuild } from './build-config.mjs';
import assets from './asset-inventory.cjs';

const root = fileURLToPath(new URL('../', import.meta.url));
async function readConfig() {
  try { return JSON.parse(await fs.readFile(path.join(root, 'config/local.json'), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error('config/local.json must be valid JSON');
  }
}
async function sourceFiles(directory) {
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) files.push(full);
  }
  return files;
}
try {
  const args = process.argv.slice(2);
  const selected = selectBuild(args, await readConfig());
  const app = path.join(root, 'app/miniprogram');
  const writeJson = (name, value) => fs.writeFile(path.join(app, name), JSON.stringify(value, null, 2) + '\n');
  await fs.rm(path.join(app, 'build-meta.json'), { force: true });
  assets.inventory(app);
  await writeJson('runtime-config.json', selected);
  await writeJson('project.config.json', {
    appid: selected.appId || 'touristappid',
    projectname: 'OR ADV', compileType: 'miniprogram', miniprogramRoot: './',
    setting: { es6: true, minified: true, urlCheck: true },
    packOptions: { ignore: [{ type: 'suffix', value: '.ts' }] },
  });
  const appOptions = {
    entryPoints: await sourceFiles(app), outdir: app, outbase: app,
    bundle: true, platform: 'browser', format: 'cjs', target: 'es2017',
    minify: true, sourcemap: false, logLevel: 'warning',
    define: { __ORADV_MODE__: JSON.stringify(selected.mode) },
    plugins: [{
      name: 'shared-native-api-module',
      setup(build) {
        const api = path.join(app, 'services/api.ts');
        build.onResolve({ filter: /services\/api$/ }, (args) => {
          if (!args.importer || path.resolve(path.dirname(args.importer), args.path + '.ts') !== api) return;
          let relative = path.relative(path.dirname(args.importer), api).replaceAll(path.sep, '/').replace(/\.ts$/, '');
          if (!relative.startsWith('.')) relative = './' + relative;
          return { path: relative, external: true };
        });
      },
    }],
  };
  const serverOptions = {
    entryPoints: [path.join(root, 'cloudfunctions/oradv/index.ts')],
    outfile: path.join(root, 'cloudfunctions/oradv/lib/index.js'),
    bundle: true, platform: 'node', format: 'cjs', target: 'node18',
    external: ['wx-server-sdk'], sourcemap: false, logLevel: 'warning',
  };
  if (args.includes('--watch')) {
    const frontend = await esbuild.context(appOptions);
    const server = await esbuild.context(serverOptions);
    await frontend.watch();
    await server.watch();
    console.log(`Watching TypeScript (${selected.mode}/${selected.target}). Run a final npm run build before CI preview/upload or ZIP packaging; watch does not publish build metadata.`);
  } else {
    await esbuild.build(appOptions);
    await esbuild.build(serverOptions);
    await fs.writeFile(path.join(root, 'cloudfunctions/oradv/index.js'), "exports.main = require('./lib/index.js').main;\n");
    const bootstrap = path.join(root, 'scripts/cloud-bootstrap-owner.ts');
    try {
      await fs.access(bootstrap);
      await esbuild.build({
        entryPoints: [bootstrap], outfile: path.join(root, 'work/cloud-bootstrap-owner.cjs'),
        bundle: true, platform: 'node', format: 'cjs', target: 'node18',
        external: ['@cloudbase/node-sdk'], logLevel: 'warning',
      });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await writeJson('build-meta.json', { ...selected, artifactHashes: assets.hashes(app) });
    console.log(`Built ${selected.version}: ${selected.mode}/${selected.target}; ${appOptions.entryPoints.length} frontend entries and cloud function.`);
    console.log(selected.mode === 'mock' ? 'LOCAL MOCK: no WeChat login or cloud database has been verified.' : 'Cloud artifacts built; deployment and real-device verification still required.');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
