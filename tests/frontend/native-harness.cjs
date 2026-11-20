const path = require('node:path');
const fs = require('node:fs');

function resolvePageFile(root, name, ext = '.js') {
  const clean = String(name).replace(/^\/+/, '').replace(/\.(js|ts|wxml|wxss|json)$/, '');
  const directRel = clean.startsWith('pages/') || clean.startsWith('subpackages/') ? clean : `pages/${clean}`;
  const direct = path.join(root, directRel + ext);
  if (fs.existsSync(direct)) return direct;
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'));
  const subRel = clean.startsWith('pages/') ? clean : `pages/${clean}`;
  const matches = [];
  for (const pkg of manifest.subpackages || []) {
    const subRoot = pkg.root.replace(/^\/+|\/+$/g, '');
    const candidate = path.join(root, subRoot, subRel + ext);
    if (fs.existsSync(candidate)) matches.push(candidate);
  }
  if (matches.length !== 1) {
    throw new Error(`Unable to resolve unique native page file for "${name}" (${ext}): found ${matches.length}`);
  }
  return matches[0];
}

// A native page and its extracted controller are one module unit. Reload both
// after a test replaces the API module so every instance uses that same API.
function freshPageModule(file) {
  const controller = path.join(path.dirname(file), 'controller.js');
  if (fs.existsSync(controller)) delete require.cache[require.resolve(controller)];
  delete require.cache[require.resolve(file)];
  return require(file);
}

module.exports = { freshPageModule, resolvePageFile };
