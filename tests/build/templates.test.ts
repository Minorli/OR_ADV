import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

const appRoot = resolve(__dirname, '../../app/miniprogram');
const config = JSON.parse(readFileSync(resolve(appRoot, 'app.json'), 'utf8')) as {
  pages: string[]; usingComponents?: Record<string, string>;
};
const binaryOperators = new Set([
  ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.AsteriskToken,
  ts.SyntaxKind.SlashToken, ts.SyntaxKind.PercentToken, ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken,
]);

// This preflight covers the expression subset used by our native pages.
// It complements the official compiler; it does not replace device preview.
function validateExpression(expression: string, context: string): void {
  assert.doesNotMatch(expression, /&(?:[a-z]+|#\d+|#x[\da-f]+);/i,
    `${context}: use native operators inside bindings, not HTML entities`);
  const code = `const binding = (${expression});`;
  const parsed = ts.transpileModule(code, { reportDiagnostics: true });
  assert.equal(parsed.diagnostics?.length ?? 0, 0, `${context}: malformed binding expression`);
  const source = ts.createSourceFile('binding.ts', code, ts.ScriptTarget.Latest, true);
  const statement = source.statements[0];
  assert.ok(ts.isVariableStatement(statement), `${context}: expected one expression`);
  const value = statement.declarationList.declarations[0].initializer;
  assert.ok(value);
  function visit(node: ts.Node): void {
    if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)
      || [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(node.kind)) return;
    if (ts.isParenthesizedExpression(node)) { visit(node.expression); return; }
    if (ts.isPropertyAccessExpression(node)) {
      assert.ok(!node.questionDotToken, `${context}: optional chaining is not supported`);
      visit(node.expression); return;
    }
    if (ts.isElementAccessExpression(node)) { visit(node.expression); visit(node.argumentExpression); return; }
    if (ts.isConditionalExpression(node)) { visit(node.condition); visit(node.whenTrue); visit(node.whenFalse); return; }
    if (ts.isPrefixUnaryExpression(node)) {
      assert.ok([ts.SyntaxKind.ExclamationToken, ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken].includes(node.operator), `${context}: unsupported unary operator`);
      visit(node.operand); return;
    }
    if (ts.isBinaryExpression(node)) {
      assert.ok(binaryOperators.has(node.operatorToken.kind), `${context}: unsupported operator`);
      visit(node.left); visit(node.right); return;
    }
    assert.fail(`${context}: unsupported native expression ${ts.SyntaxKind[node.kind]}`);
  }
  visit(value);
}

function pageHandlers(source: string): Set<string> {
  const file = ts.createSourceFile('page.ts', source, ts.ScriptTarget.Latest, true);
  const handlers = new Set<string>();
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Page') {
      const definition = node.arguments[0];
      assert.ok(definition && ts.isObjectLiteralExpression(definition), 'native Page must have an object definition');
      for (const property of definition.properties) {
        if (ts.isMethodDeclaration(property) || (ts.isPropertyAssignment(property)
          && (ts.isArrowFunction(property.initializer) || ts.isFunctionExpression(property.initializer)))) {
          if (property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) handlers.add(property.name.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return handlers;
}

test('all routed native templates have valid expressions, components, and event handlers', () => {
  const native = new Set(['view', 'text', 'button', 'block', 'picker', 'input', 'textarea',
    'switch', 'checkbox-group', 'label', 'checkbox', 'scroll-view', 'image', 'navigator', 'form', 'rich-text']);
  assert.ok(config.pages.length > 0);
  for (const page of config.pages) {
    const markup = readFileSync(resolve(appRoot, page + '.wxml'), 'utf8');
    const source = readFileSync(resolve(appRoot, page + '.ts'), 'utf8');
    const pageConfig = JSON.parse(readFileSync(resolve(appRoot, page + '.json'), 'utf8')) as { usingComponents?: Record<string, string> };
    const components = new Set([...native, ...Object.keys(config.usingComponents ?? {}), ...Object.keys(pageConfig.usingComponents ?? {})]);
    const handlers = pageHandlers(source);
    const expressions = [...markup.matchAll(/\{\{([\s\S]*?)\}\}/g)];
    assert.ok(expressions.length > 0, `${page}: expected native data bindings`);
    for (const match of expressions) validateExpression(match[1], `${page} at ${match.index}`);
    // Quoted attributes may contain comparison operators such as >.
    const tags = markup.matchAll(/<\/?([a-z][\w-]*)\b(?:"[^"]*"|'[^']*'|[^'">])*>/gi);
    for (const match of tags) assert.ok(components.has(match[1]), `${page}: unknown native component ${match[1]}`);
    for (const match of markup.matchAll(/(?:bind|catch)[\w:]*="([\w]+)"/g)) {
      assert.ok(handlers.has(match[1]), `${page}: bound event handler ${match[1]} is missing`);
    }
  }
});

test('native expression preflight rejects HTML entities and JavaScript-only constructs', () => {
  for (const expression of ['ready &amp;&amp; !loading', 'count &gt; 0', 'item?.state', 'items.filter(x => x.visible)', 'ready ?? false', 'state = true']) {
    assert.throws(() => validateExpression(expression, 'invalid fixture'), expression);
  }
  for (const expression of ['ready && !loading', "member && score > 0 ? 'active' : ''", "'\\n'", 'items[index].state']) {
    assert.doesNotThrow(() => validateExpression(expression, 'valid fixture'), expression);
  }
});
