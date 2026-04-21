const acorn = require('acorn');
const walk = require('acorn-walk');

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'all']);

function detectExpressRoutes({ filePath, source } = {}) {
  if (!source || !/\.(js|cjs|mjs)$/.test(filePath || '')) return [];
  if (!/\bexpress\b|\.Router\s*\(|\.(get|post|put|patch|delete|head|options|all)\s*\(/.test(source)) return [];

  const ast = parseJavaScript(source);
  if (!ast) return detectRoutesByRegex(source);

  const expressNames = new Set(['express']);
  const routeObjects = new Set(['app', 'router']);
  const routes = [];

  walk.simple(ast, {
    VariableDeclarator(node) {
      if (!node.id || node.id.type !== 'Identifier' || !node.init) return;
      if (isExpressRequire(node.init)) {
        expressNames.add(node.id.name);
        return;
      }
      if (isExpressAppCall(node.init, expressNames) || isExpressRouterCall(node.init, expressNames)) {
        routeObjects.add(node.id.name);
      }
    },
    ImportDeclaration(node) {
      if (node.source && node.source.value === 'express') {
        for (const spec of node.specifiers || []) {
          if (spec.local && spec.local.name) expressNames.add(spec.local.name);
        }
      }
    },
  });

  walk.simple(ast, {
    CallExpression(node) {
      const route = getRouteCall(node, routeObjects);
      if (route) routes.push(route);

      const chainedRoute = getChainedRouteCall(node, routeObjects);
      if (chainedRoute) routes.push(chainedRoute);
    },
  });

  return dedupeRoutes(routes);
}

function parseJavaScript(source) {
  for (const sourceType of ['module', 'script']) {
    try {
      return acorn.parse(source, {
        ecmaVersion: 'latest',
        sourceType,
        allowHashBang: true,
      });
    } catch (err) {
      // Try the next source type.
    }
  }
  return null;
}

function isExpressRequire(node) {
  return node
    && node.type === 'CallExpression'
    && node.callee
    && node.callee.type === 'Identifier'
    && node.callee.name === 'require'
    && node.arguments
    && node.arguments[0]
    && node.arguments[0].type === 'Literal'
    && node.arguments[0].value === 'express';
}

function isExpressAppCall(node, expressNames) {
  return node
    && node.type === 'CallExpression'
    && node.callee
    && node.callee.type === 'Identifier'
    && expressNames.has(node.callee.name);
}

function isExpressRouterCall(node, expressNames) {
  if (!node || node.type !== 'CallExpression' || !node.callee || node.callee.type !== 'MemberExpression') return false;
  const object = node.callee.object;
  const property = getPropertyName(node.callee.property);
  if (property !== 'Router') return false;
  if (object.type === 'Identifier' && expressNames.has(object.name)) return true;
  return isExpressRequire(object);
}

function getRouteCall(node, routeObjects) {
  if (!node.callee || node.callee.type !== 'MemberExpression') return null;
  const method = getPropertyName(node.callee.property);
  if (!HTTP_METHODS.has(method)) return null;
  const object = node.callee.object;
  if (!object || object.type !== 'Identifier' || !routeObjects.has(object.name)) return null;
  const routePath = getStringArg(node.arguments && node.arguments[0]);
  if (!routePath) return null;

  return {
    method: method.toUpperCase(),
    path: routePath,
    routerName: object.name,
    handlerName: getHandlerName((node.arguments || [])[1]),
    middlewareCount: Math.max(0, (node.arguments || []).length - 2),
  };
}

function getChainedRouteCall(node, routeObjects) {
  if (!node.callee || node.callee.type !== 'MemberExpression') return null;
  const method = getPropertyName(node.callee.property);
  if (!HTTP_METHODS.has(method)) return null;
  const routeCall = node.callee.object;
  if (!routeCall || routeCall.type !== 'CallExpression' || !routeCall.callee || routeCall.callee.type !== 'MemberExpression') return null;
  if (getPropertyName(routeCall.callee.property) !== 'route') return null;
  const object = routeCall.callee.object;
  if (!object || object.type !== 'Identifier' || !routeObjects.has(object.name)) return null;
  const routePath = getStringArg(routeCall.arguments && routeCall.arguments[0]);
  if (!routePath) return null;

  return {
    method: method.toUpperCase(),
    path: routePath,
    routerName: object.name,
    handlerName: getHandlerName((node.arguments || [])[0]),
    middlewareCount: Math.max(0, (node.arguments || []).length - 1),
  };
}

function getPropertyName(property) {
  if (!property) return null;
  if (property.type === 'Identifier') return property.name;
  if (property.type === 'Literal') return String(property.value);
  return null;
}

function getStringArg(node) {
  if (!node) return null;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0 && node.quasis[0]) {
    return node.quasis[0].value.cooked || node.quasis[0].value.raw;
  }
  return null;
}

function getHandlerName(node) {
  if (!node) return null;
  if (node.type === 'Identifier') return node.name;
  if ((node.type === 'FunctionExpression' || node.type === 'FunctionDeclaration') && node.id && node.id.name) return node.id.name;
  if (node.type === 'MemberExpression') {
    const objectName = node.object && node.object.type === 'Identifier' ? node.object.name : null;
    const propertyName = getPropertyName(node.property);
    return [objectName, propertyName].filter(Boolean).join('.');
  }
  if (node.type === 'ArrowFunctionExpression') return 'inline';
  if (node.type === 'FunctionExpression') return 'inline';
  return null;
}

function detectRoutesByRegex(source) {
  const routes = [];
  const pattern = /\b(app|router)\.(get|post|put|patch|delete|head|options|all)\s*\(\s*(['"`])([^'"`]+)\3/g;
  let match;
  while ((match = pattern.exec(source))) {
    routes.push({
      method: match[2].toUpperCase(),
      path: match[4],
      routerName: match[1],
      handlerName: null,
      middlewareCount: 0,
    });
  }
  return dedupeRoutes(routes);
}

function dedupeRoutes(routes) {
  const seen = new Set();
  const out = [];
  for (const route of routes) {
    const key = `${route.method}:${route.path}:${route.routerName}:${route.handlerName || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(route);
  }
  return out;
}

module.exports = { detectExpressRoutes };
