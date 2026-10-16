const path = require('node:path');
const fs = require('node:fs');

// A native page and its extracted controller are one module unit. Reload both
// after a test replaces the API module so every instance uses that same API.
function freshPageModule(file) {
  const controller = path.join(path.dirname(file), 'controller.js');
  if (fs.existsSync(controller)) delete require.cache[require.resolve(controller)];
  delete require.cache[require.resolve(file)];
  return require(file);
}
module.exports = { freshPageModule };
