'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const ASSETS = new Set(['.js', '.json', '.wxml', '.wxss', '.svg', '.png', '.jpg', '.jpeg']);
const IGNORED = new Set(['project.private.config.json', '.DS_Store']);
const SDK_IGNORES = ['**/node_modules/**/*', '**/.git/**/*', '**/*.ts', '**/*.map', '**/project.private.config.json', '**/.DS_Store'];
function fail(message) { throw new Error('Asset inventory: ' + message); }
function privateName(name) {
  return /^secrets?([._-]|$)/i.test(name) || /(^|[._-])(private|credentials?)([._-]|$)/i.test(name)
    || /^\.env([._-]|$)/i.test(name) || /^local\.json$/i.test(name) || /\.(key|pem|p12|pfx)$/i.test(name);
}
function inventory(projectPath) {
  const root = path.resolve(projectPath);
  const stat = fs.lstatSync(root);
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail('Project must be a real directory');
  const files = [];
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (/[\\:\x00-\x1f]/.test(entry.name)) fail('Unsafe cross-platform filename');
      // Inspect links before exclusions: even a link disguised as TS is unsafe.
      if (entry.isSymbolicLink()) fail('Symbolic links are not allowed');
      if (IGNORED.has(entry.name)) continue;
      if (privateName(entry.name)) fail('Private or credential filename is not allowed');
      if (entry.isDirectory()) {
        if (['node_modules', '.git'].includes(entry.name)) continue;
        walk(full);
      } else if (entry.isFile()) {
        const extension = path.extname(entry.name);
        if (extension === '.ts' || extension === '.map') continue;
        if (!ASSETS.has(extension)) fail('Unsupported project file type');
        files.push(path.relative(root, full).split(path.sep).join('/'));
      } else fail('Unsupported filesystem entry');
    }
  }
  walk(root);
  return files.sort();
}
function hashes(projectPath) {
  return Object.fromEntries(inventory(projectPath).filter((file) => file !== 'build-meta.json').map((file) => [file,
    createHash('sha256').update(fs.readFileSync(path.join(projectPath, file))).digest('hex'),
  ]));
}
function verify(projectPath, meta) {
  if (!meta || !meta.artifactHashes || typeof meta.artifactHashes !== 'object' || Array.isArray(meta.artifactHashes)) fail('Build metadata has no artifact hashes; run a final build');
  const actual = hashes(projectPath);
  const expected = meta.artifactHashes;
  if (JSON.stringify(Object.keys(actual).sort()) !== JSON.stringify(Object.keys(expected).sort())
    || Object.entries(actual).some(([file, hash]) => hash !== expected[file])) fail('Compiled assets differ from the successful build; rebuild');
  return Object.keys(actual);
}
function safeOutputDirectory(repository, output) {
  const root = fs.realpathSync(repository);
  const target = path.resolve(output);
  const relative = path.relative(root, target);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) fail('Preview output must stay inside repository');
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) fail('Preview output cannot contain symbolic links');
  }
  fs.mkdirSync(target, { recursive: true });
  const resolved = fs.realpathSync(target);
  if (path.relative(root, resolved).startsWith('..')) fail('Preview output escapes repository');
  return resolved;
}

if (require.main === module) {
  try {
    const project = process.argv[2];
    if (!project || process.argv.length !== 3) fail('Usage: node asset-inventory.cjs PROJECT');
    inventory(project);
    const meta = JSON.parse(fs.readFileSync(path.join(project, 'build-meta.json'), 'utf8'));
    verify(project, meta);
    console.log(JSON.stringify(inventory(project)));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { inventory, hashes, verify, safeOutputDirectory, SDK_IGNORES };
