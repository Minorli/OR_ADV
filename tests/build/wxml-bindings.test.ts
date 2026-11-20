import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
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

function wxmlFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = resolve(dir, entry.name);
    return entry.isDirectory() ? wxmlFiles(full) : entry.name.endsWith('.wxml') ? [full] : [];
  });
}

test('all native conditional branches and lists across main and subpackages use dynamic WXML data bindings', () => {
  const config = JSON.parse(readFileSync(resolve(root, 'app.json'), 'utf8')) as {
    pages: string[];
    subpackages?: { root: string; pages: string[] }[];
  };
  const allPages = [
    ...config.pages,
    ...(config.subpackages ?? []).flatMap(pkg => pkg.pages.map(page => `${pkg.root.replace(/^\/+|\/+$/g, '')}/${page}`)),
  ];
  assert.equal(allPages.length, 17);
  for (const page of allPages) validateBindings(readFileSync(resolve(root, page + '.wxml'), 'utf8'), page);
  for (const file of wxmlFiles(root)) validateBindings(readFileSync(file, 'utf8'), file);
});

test('unbound conditions are rejected even when their text looks like a valid JavaScript expression', () => {
  for (const markup of ['<view wx:if="loading"/>', '<block wx:if="mode === \'queue\'"/>', '<block wx:elif="dossier"/>', '<view wx:for="items"/>', '<view wx:if="{{ }}"/>']) {
    assert.throws(() => validateBindings(markup, 'invalid fixture'));
  }
  for (const markup of ['<view wx:if="{{loading}}"/>', '<block wx:if="{{mode === \'queue\'}}"/>', '<block wx:elif="{{dossier}}"/>', '<view wx:for="{{items}}"/>', '<view wx:if="{{true}}"/>', '<view wx:else/>']) {
    assert.doesNotThrow(() => validateBindings(markup, 'valid fixture'));
  }
});
