const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
test('custom tab bar restores current route, uses registered tabs, and ignores hidden or invalid clicks', () => {
  const manifest = require('../../app/miniprogram/app.json');
  let definition; const calls = [];
  global.Component = value => { definition = value; };
  global.getCurrentPages = () => [{ route: 'pages/profile/index' }];
  global.wx = { switchTab: value => calls.push(value.url) };
  const file = path.resolve(__dirname, '../../app/miniprogram/custom-tab-bar/index.js');
  delete require.cache[require.resolve(file)]; require(file);
  const host = { ...definition.methods, data: structuredClone(definition.data), setData(values) { Object.assign(this.data, values); } };
  definition.lifetimes.attached.call(host); assert.equal(host.data.selected, 3);
  for (let index = 0; index < 4; index++) { host.data.selected = -1; host.choose({ currentTarget: { dataset: { index } } }); }
  assert.deepEqual(calls, manifest.tabBar.list.map(row => '/' + row.pagePath));
  const count = calls.length; host.data.hidden = true; host.choose({ currentTarget: { dataset: { index: 0 } } });
  host.data.hidden = false; for (const index of [-1, 8, 'unknown', 1.5]) host.choose({ currentTarget: { dataset: { index } } });
  host.data.selected = 0; host.choose({ currentTarget: { dataset: { index: 0 } } }); assert.equal(calls.length, count);
});
