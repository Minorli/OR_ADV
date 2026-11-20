import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';

const root = resolve(__dirname, '../../app/miniprogram');
function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith('.ts') ? [path] : [];
  });
}

test('native page navigation respects tab, main-package, and subpackage route boundaries', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'app.json'), 'utf8')) as {
    pages: string[];
    subpackages?: { root: string; name?: string; pages: string[] }[];
    tabBar: { list: { pagePath: string }[] };
  };
  const mainPages = new Set(manifest.pages.map((page) => '/' + page));
  const subPages = new Set((manifest.subpackages ?? []).flatMap((pkg) => {
    const cleanRoot = pkg.root.replace(/^\/+|\/+$/g, '');
    return pkg.pages.map((page) => `/${cleanRoot}/${page}`);
  }));
  const allPages = new Set([...mainPages, ...subPages]);
  const tabs = new Set(manifest.tabBar.list.map((item) => '/' + item.pagePath));
  for (const tab of tabs) assert.ok(mainPages.has(tab), `tabBar route ${tab} must stay in main package`);
  for (const sub of subPages) assert.ok(!mainPages.has(sub), `subpackage route ${sub} cannot duplicate main package`);
  assert.deepEqual([...mainPages].sort(), [...tabs].sort(), 'main package should contain only the four core tab pages');

  let checked = 0;
  for (const file of sourceFiles(root)) {
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    function visit(node: ts.Node) {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'wx') {
        const method = node.expression.name.text;
        const options = node.arguments[0];
        if (['navigateTo', 'redirectTo', 'switchTab'].includes(method) && options && ts.isObjectLiteralExpression(options)) {
          const property = options.properties.find((item) => ts.isPropertyAssignment(item) && item.name.getText(source) === 'url');
          if (property && ts.isPropertyAssignment(property)) {
            const value = property.initializer;
            const text = ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value) ? value.text
              : ts.isTemplateExpression(value) ? value.head.text : '';
            if (!text && relative(root, file) === 'custom-tab-bar/index.ts' && value.getText(source) === 'tabs[index].path') {
              const declaration = source.statements.filter(ts.isVariableStatement).flatMap(statement => [...statement.declarationList.declarations]).find(item => item.name.getText(source) === 'tabs');
              assert(declaration?.initializer && ts.isArrayLiteralExpression(declaration.initializer), 'custom tab routes must be a literal allowlist');
              const routes = declaration.initializer.elements.map(item => {
                assert(ts.isObjectLiteralExpression(item));
                const route = item.properties.find(field => ts.isPropertyAssignment(field) && field.name.getText(source) === 'path');
                assert(route && ts.isPropertyAssignment(route) && ts.isStringLiteral(route.initializer));
                return route.initializer.text;
              });
              assert.deepEqual(routes, manifest.tabBar.list.map(item => '/' + item.pagePath));
              assert.equal(method, 'switchTab'); checked += routes.length; return;
            }
            assert.ok(text.startsWith('/pages/') || text.startsWith('/subpackages/'), `${relative(root, file)}: navigation needs a registered page path`);
            const route = text.split('?')[0];
            assert.ok(allPages.has(route), `${relative(root, file)}: unknown route ${route}`);
            assert.equal(tabs.has(route), method === 'switchTab', `${relative(root, file)}: wx.${method} cannot target ${route}`);
            checked++;
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  assert.ok(checked > 0, 'native navigation calls were inspected');
});
