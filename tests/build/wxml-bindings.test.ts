import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(__dirname, '../../app/miniprogram');
function validateBindings(markup: string, page: string) {
  for (const match of markup.matchAll(/wx:(if|elif|for)\s*=\s*(["'])([\s\S]*?)\2/g)) {
    const value = match[3].trim();
    assert.ok(value.startsWith('{{') && value.endsWith('}}'),
      `${page}: wx:${match[1]} must bind an expression with {{ }}; an unbound value is a literal`);
    assert.ok(value.slice(2, -2).trim(), `${page}: empty wx:${match[1]} binding`);
  }
}

test('all native conditional branches and lists use dynamic WXML data bindings', () => {
  const config = JSON.parse(readFileSync(resolve(root, 'app.json'), 'utf8')) as { pages: string[] };
  assert.ok(config.pages.length > 0);
  for (const page of config.pages) validateBindings(readFileSync(resolve(root, page + '.wxml'), 'utf8'), page);
});

test('unbound conditions are rejected even when their text looks like a valid JavaScript expression', () => {
  for (const markup of ['<view wx:if="loading"/>', '<block wx:if="mode === \'queue\'"/>', '<block wx:elif="dossier"/>', '<view wx:for="items"/>', '<view wx:if="{{ }}"/>']) {
    assert.throws(() => validateBindings(markup, 'invalid fixture'));
  }
  for (const markup of ['<view wx:if="{{loading}}"/>', '<block wx:if="{{mode === \'queue\'}}"/>', '<block wx:elif="{{dossier}}"/>', '<view wx:for="{{items}}"/>', '<view wx:if="{{true}}"/>', '<view wx:else/>']) {
    assert.doesNotThrow(() => validateBindings(markup, 'valid fixture'));
  }
});
