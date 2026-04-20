const acorn = require('acorn');
const jsx = require('acorn-jsx');
const ARRAY_METHODS = new Set(['map', 'filter', 'reduce', 'forEach', 'find', 'some', 'every', 'flat', 'flatMap', 'slice', 'push', 'pop', 'shift', 'unshift', 'includes', 'join', 'at']);
const STRING_METHODS = new Set(['trim', 'toLowerCase', 'toUpperCase', 'split', 'match', 'replace', 'includes', 'startsWith', 'endsWith', 'substring', 'slice']);

function addExport(exports, exp) {
  if (!exp.exportName) return;
  const key = `${exp.exportName}:${exp.type}`;
  if (exports._seen.has(key)) return;
  exports._seen.add(key);
  exports.items.push(exp);
}

function parseWithAcorn({ source, isJsx }) {
  const Parser = isJsx ? acorn.Parser.extend(jsx()) : acorn.Parser;
  return Parser.parse(source, {
    ecmaVersion: 'latest',
    sourceType: 'module',
    allowHashBang: true,
  });
}

function detectExports({ filePath, source }) {
  const exports = { items: [], _seen: new Set() };
  const isJsx = /\.(jsx|tsx)$/.test(filePath);

  if (!/\.(jsx|tsx|js|cjs|mjs)$/.test(filePath)) {
    return [];
  }

  if (/\.tsx$/.test(filePath)) {
    return detectExportsByRegex({ source, exports }).items;
  }

  try {
    const ast = parseWithAcorn({ source, isJsx });
    for (const node of ast.body || []) {
      if (node.type === 'ExportNamedDeclaration') {
        if (node.declaration) {
          const decl = node.declaration;

          if (decl.type === 'FunctionDeclaration' || decl.type === 'ClassDeclaration') {
            const functionMeta = decl.type === 'FunctionDeclaration'
              ? getFunctionMeta(decl)
              : null;

            addExport(exports, {
              exportName: decl.id ? decl.id.name : null,
              type: decl.type === 'FunctionDeclaration' ? 'function' : 'class',
              params: functionMeta ? functionMeta.params : [],
              paramContracts: functionMeta ? functionMeta.paramContracts : [],
              returnContract: functionMeta ? functionMeta.returnContract : null,
            });
          }

          if (decl.type === 'VariableDeclaration') {
            for (const d of decl.declarations || []) {
              if (d.id && d.id.type === 'Identifier') {
                const init = d.init;
                const isFn = init && (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression');
                const functionMeta = isFn ? getFunctionMeta(init) : null;

                addExport(exports, {
                  exportName: d.id.name,
                  type: isFn ? 'function' : 'value',
                  params: functionMeta ? functionMeta.params : [],
                  paramContracts: functionMeta ? functionMeta.paramContracts : [],
                  returnContract: functionMeta ? functionMeta.returnContract : null,
                });
              }
            }
          }
        }

        if (node.specifiers && node.specifiers.length) {
          for (const spec of node.specifiers) {
            addExport(exports, {
              exportName: spec.exported.name,
              type: 'value',
              params: [],
              paramContracts: [],
              returnContract: null,
            });
          }
        }
      }

      if (node.type === 'ExportDefaultDeclaration') {
        const decl = node.declaration;
        const isFn = decl && (decl.type === 'FunctionDeclaration' || decl.type === 'FunctionExpression' || decl.type === 'ArrowFunctionExpression');
        const functionMeta = isFn ? getFunctionMeta(decl) : null;

        addExport(exports, {
          exportName: 'default',
          type: isFn ? 'function' : 'value',
          params: functionMeta ? functionMeta.params : [],
          paramContracts: functionMeta ? functionMeta.paramContracts : [],
          returnContract: functionMeta ? functionMeta.returnContract : null,
          displayName: decl && decl.id ? decl.id.name : null,
        });
      }
    }

    detectCommonJsExports({ source, exports });
  } catch (err) {
    detectExportsByRegex({ source, exports });
  }

  return exports.items;
}

function getFunctionMeta(fnNode) {
  const paramContracts = (fnNode.params || []).map((param, idx) => getParamContract(param, idx));
  const params = paramContracts.map((item) => item.name || `arg${item.index + 1}`);
  const symbols = buildFunctionSymbolTypes(fnNode, paramContracts);
  inferParamContractsFromUsage(fnNode, paramContracts, symbols);
  const returnContract = inferReturnContract(fnNode, symbols);
  return {
    params,
    paramContracts,
    returnContract,
  };
}

function buildFunctionSymbolTypes(fnNode, paramContracts) {
  const symbols = new Map();

  for (const param of paramContracts) {
    if (!param || !param.name) continue;
    symbols.set(param.name, {
      type: param.type || 'unknown',
      schema: param.schema,
      items: param.items,
    });
  }

  if (!fnNode || !fnNode.body || fnNode.body.type !== 'BlockStatement') return symbols;
  collectVariableDeclarators(fnNode.body, symbols, true);
  return symbols;
}

function collectVariableDeclarators(node, symbols, isRoot) {
  if (!node || typeof node !== 'object') return;

  if (!isRoot && (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression')) {
    return;
  }

  if (node.type === 'VariableDeclaration') {
    for (const decl of node.declarations || []) {
      if (!decl || !decl.id || decl.id.type !== 'Identifier' || !decl.init) continue;
      symbols.set(decl.id.name, inferExpressionType(decl.init, symbols));
    }
  }

  for (const value of Object.values(node)) {
    if (!value) continue;
    if (Array.isArray(value)) {
      for (const child of value) {
        collectVariableDeclarators(child, symbols, false);
      }
    } else if (value && typeof value === 'object' && value.type) {
      collectVariableDeclarators(value, symbols, false);
    }
  }
}

function getParamContract(param, index) {
  if (!param) {
    return createParamContract({ name: `arg${index + 1}`, type: 'unknown', required: true, index });
  }

  if (param.type === 'Identifier') {
    return createParamContract({ name: param.name, type: 'unknown', required: true, index });
  }

  if (param.type === 'AssignmentPattern') {
    const base = getParamContract(param.left, index);
    const defaultDescriptor = inferExpressionType(param.right);
    const next = {
      ...base,
      required: false,
    };

    if (next.type === 'unknown' && defaultDescriptor && defaultDescriptor.type && defaultDescriptor.type !== 'unknown') {
      next.type = defaultDescriptor.type;
      if (defaultDescriptor.schema) next.schema = defaultDescriptor.schema;
      if (defaultDescriptor.items) next.items = defaultDescriptor.items;
    }

    return next;
  }

  if (param.type === 'RestElement') {
    const name = param.argument && param.argument.type === 'Identifier'
      ? param.argument.name
      : `arg${index + 1}`;
    return createParamContract({ name, type: 'array', required: false, index });
  }

  if (param.type === 'ObjectPattern') {
    return createParamContract({
      name: `arg${index + 1}`,
      type: 'object',
      required: true,
      schema: extractObjectPatternSchema(param),
      bindings: extractObjectPatternBindings(param),
      index,
    });
  }

  if (param.type === 'ArrayPattern') {
    return createParamContract({ name: `arg${index + 1}`, type: 'array', required: true, index });
  }

  return createParamContract({ name: `arg${index + 1}`, type: 'unknown', required: true, index });
}

function createParamContract({ name, type, required, description = '', schema, items, bindings, index }) {
  const out = {
    name,
    type,
    required,
    description,
    index,
  };
  if (schema) out.schema = schema;
  if (items) out.items = items;
  if (bindings) out.bindings = bindings;
  return out;
}

function extractObjectPatternSchema(pattern) {
  const schema = {};
  for (const prop of pattern.properties || []) {
    if (prop.type === 'RestElement') {
      schema.__rest = { type: 'object', required: false, description: 'Additional keys allowed.' };
      continue;
    }
    if (prop.type !== 'Property') continue;

    const key = getPropertyKeyName(prop.key);
    if (!key) continue;

    const descriptor = inferPatternValueDescriptor(prop.value);
    schema[key] = {
      type: descriptor.type,
      required: descriptor.required,
      description: '',
    };
    if (descriptor.schema) schema[key].schema = descriptor.schema;
    if (descriptor.items) schema[key].items = descriptor.items;
  }
  return schema;
}

function inferPatternValueDescriptor(node) {
  if (!node) return { type: 'unknown', required: true };

  if (node.type === 'Identifier') {
    return { type: 'unknown', required: true };
  }

  if (node.type === 'AssignmentPattern') {
    const leftDesc = inferPatternValueDescriptor(node.left);
    const rightDesc = inferExpressionType(node.right);
    return {
      type: leftDesc.type !== 'unknown' ? leftDesc.type : rightDesc.type,
      required: false,
      schema: leftDesc.schema || rightDesc.schema,
      items: leftDesc.items || rightDesc.items,
    };
  }

  if (node.type === 'ObjectPattern') {
    return {
      type: 'object',
      required: true,
      schema: extractObjectPatternSchema(node),
    };
  }

  if (node.type === 'ArrayPattern') {
    return {
      type: 'array',
      required: true,
    };
  }

  if (node.type === 'RestElement') {
    return {
      type: 'array',
      required: false,
    };
  }

  return { type: 'unknown', required: true };
}

function extractObjectPatternBindings(pattern, prefix = []) {
  const out = [];
  for (const prop of pattern.properties || []) {
    if (prop.type !== 'Property') continue;
    const key = getPropertyKeyName(prop.key);
    if (!key) continue;
    const nextPath = [...prefix, key];
    const value = prop.value;
    if (!value) continue;

    if (value.type === 'Identifier') {
      out.push({ local: value.name, path: nextPath });
      continue;
    }
    if (value.type === 'AssignmentPattern') {
      if (value.left && value.left.type === 'Identifier') {
        out.push({ local: value.left.name, path: nextPath });
      } else if (value.left && value.left.type === 'ObjectPattern') {
        out.push(...extractObjectPatternBindings(value.left, nextPath));
      }
      continue;
    }
    if (value.type === 'ObjectPattern') {
      out.push(...extractObjectPatternBindings(value, nextPath));
    }
  }
  return out;
}

function inferParamContractsFromUsage(fnNode, paramContracts, symbols) {
  if (!fnNode || !fnNode.body) return;
  const directParams = new Map(paramContracts.map((contract) => [contract.name, contract]));
  const aliasBindings = new Map();

  for (const contract of paramContracts) {
    if (!Array.isArray(contract.bindings)) continue;
    for (const binding of contract.bindings) {
      aliasBindings.set(binding.local, { contract, path: binding.path });
    }
  }

  walkUsage(fnNode.body, true, (node) => {
    if (node.type === 'TemplateLiteral') {
      for (const expr of node.expressions || []) {
        applyTypeHintToExpression(expr, { type: 'string' }, directParams, aliasBindings, symbols);
      }
      return;
    }

    if (node.type === 'ForOfStatement') {
      applyTypeHintToExpression(node.right, { type: 'array' }, directParams, aliasBindings, symbols);
      return;
    }

    if (node.type === 'CallExpression' && node.callee && node.callee.type === 'MemberExpression') {
      const method = getPropertyKeyName(node.callee.property);
      if (method && ARRAY_METHODS.has(method)) {
        applyTypeHintToExpression(node.callee.object, { type: 'array' }, directParams, aliasBindings, symbols);
      }
      if (method && STRING_METHODS.has(method)) {
        applyTypeHintToExpression(node.callee.object, { type: 'string' }, directParams, aliasBindings, symbols);
      }
      return;
    }

    if (node.type === 'AssignmentExpression' && node.left && node.left.type === 'MemberExpression') {
      const access = getMemberAccessPath(node.left);
      if (!access) return;
      const rhs = inferExpressionType(node.right, symbols);
      updateParamPathFromAccess(access, rhs, directParams, aliasBindings, symbols);
      return;
    }

    if (node.type === 'MemberExpression') {
      const access = getMemberAccessPath(node);
      if (!access) return;
      applyTypeHintToExpression(node.object, { type: 'object' }, directParams, aliasBindings, symbols);
      updateParamPathFromAccess(access, { type: 'unknown' }, directParams, aliasBindings, symbols);
      return;
    }

    if (node.type === 'BinaryExpression') {
      if (['-', '*', '/', '%', '**', '|', '&', '^', '<<', '>>', '>>>'].includes(node.operator)) {
        applyTypeHintToExpression(node.left, { type: 'number' }, directParams, aliasBindings, symbols);
        applyTypeHintToExpression(node.right, { type: 'number' }, directParams, aliasBindings, symbols);
        return;
      }
      if (node.operator === '+') {
        const left = inferExpressionType(node.left, symbols);
        const right = inferExpressionType(node.right, symbols);
        const hint = (left.type === 'string' || right.type === 'string') ? { type: 'string' } : { type: 'string | number' };
        applyTypeHintToExpression(node.left, hint, directParams, aliasBindings, symbols);
        applyTypeHintToExpression(node.right, hint, directParams, aliasBindings, symbols);
      }
    }
  });
}

function walkUsage(node, isRoot, visitor) {
  if (!node || typeof node !== 'object') return;
  if (!isRoot && (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression')) {
    return;
  }
  visitor(node);
  for (const value of Object.values(node)) {
    if (!value) continue;
    if (Array.isArray(value)) {
      for (const child of value) {
        walkUsage(child, false, visitor);
      }
    } else if (value && typeof value === 'object' && value.type) {
      walkUsage(value, false, visitor);
    }
  }
}

function applyTypeHintToExpression(expr, hint, directParams, aliasBindings, symbols) {
  if (!expr || !hint || !hint.type) return;

  if (expr.type === 'Identifier') {
    const direct = directParams.get(expr.name);
    if (direct) {
      mergeTypeIntoContract(direct, hint);
      symbols.set(expr.name, mergeDescriptors([symbols.get(expr.name) || { type: 'unknown' }, hint]));
      return;
    }
    const alias = aliasBindings.get(expr.name);
    if (alias) {
      ensureObjectContract(alias.contract);
      setSchemaAtPath(alias.contract.schema, alias.path, hint);
      symbols.set(expr.name, mergeDescriptors([symbols.get(expr.name) || { type: 'unknown' }, hint]));
    }
    return;
  }

  if (expr.type === 'MemberExpression') {
    const access = getMemberAccessPath(expr);
    if (access) {
      updateParamPathFromAccess(access, hint, directParams, aliasBindings, symbols);
    }
  }
}

function getMemberAccessPath(node) {
  if (!node || node.type !== 'MemberExpression') return null;
  const parts = [];
  let current = node;
  while (current && current.type === 'MemberExpression') {
    const key = getPropertyKeyName(current.property);
    if (!key) return null;
    parts.unshift(key);
    current = current.object;
  }
  if (!current || current.type !== 'Identifier') return null;
  return { root: current.name, path: parts };
}

function updateParamPathFromAccess(access, descriptor, directParams, aliasBindings, symbols) {
  const direct = directParams.get(access.root);
  if (direct) {
    ensureObjectContract(direct);
    setSchemaAtPath(direct.schema, access.path, descriptor);
    symbols.set(access.root, { type: 'object', schema: direct.schema });
    return;
  }
  const alias = aliasBindings.get(access.root);
  if (alias) {
    ensureObjectContract(alias.contract);
    const path = [...alias.path, ...access.path];
    setSchemaAtPath(alias.contract.schema, path, descriptor);
    symbols.set(access.root, mergeDescriptors([symbols.get(access.root) || { type: 'unknown' }, descriptor]));
  }
}

function ensureObjectContract(contract) {
  if (!contract.schema || typeof contract.schema !== 'object') {
    contract.schema = {};
  }
  contract.type = 'object';
}

function setSchemaAtPath(schema, path, descriptor) {
  if (!schema || !Array.isArray(path) || path.length === 0) return;
  let cursor = schema;
  for (let i = 0; i < path.length; i += 1) {
    const key = path[i];
    const isLeaf = i === path.length - 1;
    if (!cursor[key]) {
      cursor[key] = {
        type: isLeaf ? (descriptor.type || 'unknown') : 'object',
        required: false,
        description: '',
      };
      if (!isLeaf) cursor[key].schema = {};
    }

    if (isLeaf) {
      cursor[key].type = mergeTypes(cursor[key].type, descriptor.type || 'unknown');
      if (descriptor.schema) cursor[key].schema = mergeSchema(cursor[key].schema, descriptor.schema);
      if (descriptor.items) cursor[key].items = descriptor.items;
    } else {
      cursor[key].type = mergeTypes(cursor[key].type, 'object');
      if (!cursor[key].schema) cursor[key].schema = {};
      cursor = cursor[key].schema;
    }
  }
}

function mergeTypeIntoContract(contract, descriptor) {
  contract.type = mergeTypes(contract.type || 'unknown', descriptor.type || 'unknown');
  if (descriptor.schema) {
    contract.schema = mergeSchema(contract.schema, descriptor.schema);
  }
  if (descriptor.items) {
    contract.items = descriptor.items;
  }
}

function mergeSchema(left, right) {
  const out = { ...(left || {}) };
  for (const [key, value] of Object.entries(right || {})) {
    if (!out[key]) {
      out[key] = value;
      continue;
    }
    out[key] = {
      ...out[key],
      ...value,
      type: mergeTypes(out[key].type || 'unknown', value.type || 'unknown'),
    };
    if (out[key].schema || value.schema) {
      out[key].schema = mergeSchema(out[key].schema, value.schema);
    }
  }
  return out;
}

function mergeTypes(a, b) {
  const left = (a || 'unknown').split('|').map((part) => part.trim()).filter(Boolean);
  const right = (b || 'unknown').split('|').map((part) => part.trim()).filter(Boolean);
  const set = new Set([...left, ...right]);
  if (set.has('unknown') && set.size > 1) set.delete('unknown');
  return Array.from(set).sort().join(' | ') || 'unknown';
}

function inferReturnContract(fnNode, symbols) {
  const expressions = getReturnExpressions(fnNode);
  if (expressions.length === 0) {
    return { type: 'void', description: '' };
  }

  const descriptors = expressions.map((expr) => inferExpressionType(expr, symbols));
  const merged = mergeDescriptors(descriptors);
  const out = {
    type: merged.type,
    description: '',
  };
  if (merged.schema) out.schema = merged.schema;
  if (merged.items) out.items = merged.items;

  if (fnNode.async) {
    out.type = `Promise<${out.type}>`;
  }

  return out;
}

function getReturnExpressions(fnNode) {
  if (!fnNode || !fnNode.body) return [];

  if (fnNode.body.type !== 'BlockStatement') {
    return [fnNode.body];
  }

  const returns = [];
  collectReturns(fnNode.body, returns, true);
  return returns;
}

function collectReturns(node, out, isRoot) {
  if (!node || typeof node !== 'object') return;

  if (!isRoot && (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression')) {
    return;
  }

  if (node.type === 'ReturnStatement') {
    out.push(node.argument || { type: 'Identifier', name: 'undefined' });
    return;
  }

  for (const value of Object.values(node)) {
    if (!value) continue;
    if (Array.isArray(value)) {
      for (const child of value) {
        collectReturns(child, out, false);
      }
    } else if (value && typeof value === 'object' && value.type) {
      collectReturns(value, out, false);
    }
  }
}

function inferExpressionType(expr, symbols = new Map()) {
  if (!expr || typeof expr !== 'object') return { type: 'unknown' };

  if (expr.type === 'Literal') {
    if (expr.value === null) return { type: 'null' };
    return { type: typeof expr.value };
  }

  if (expr.type === 'TemplateLiteral') return { type: 'string' };
  if (expr.type === 'ObjectExpression') return { type: 'object', schema: extractObjectExpressionSchema(expr, symbols) };
  if (expr.type === 'ArrayExpression') return { type: 'array', items: inferArrayItemsType(expr, symbols) };
  if (expr.type === 'ArrowFunctionExpression' || expr.type === 'FunctionExpression') return { type: 'function' };

  if (expr.type === 'Identifier') {
    return symbols.get(expr.name) || { type: 'unknown' };
  }

  if (expr.type === 'MemberExpression') {
    const access = getMemberAccessPath(expr);
    if (!access) return { type: 'unknown' };
    const root = symbols.get(access.root);
    if (!root || !root.schema) return { type: 'unknown' };
    return getDescriptorAtPath(root.schema, access.path) || { type: 'unknown' };
  }

  if (expr.type === 'CallExpression') {
    if (expr.callee && expr.callee.type === 'Identifier') {
      if (expr.callee.name === 'Number') return { type: 'number' };
      if (expr.callee.name === 'String') return { type: 'string' };
      if (expr.callee.name === 'Boolean') return { type: 'boolean' };
      if (expr.callee.name === 'Array') return { type: 'array', items: { type: 'unknown' } };
      if (expr.callee.name === 'Object') return { type: 'object', schema: {} };
    }
    if (expr.callee && expr.callee.type === 'MemberExpression') {
      const method = getPropertyKeyName(expr.callee.property);
      if (method && STRING_METHODS.has(method)) return { type: 'string' };
      if (method && ARRAY_METHODS.has(method)) return { type: 'array', items: { type: 'unknown' } };
    }
    return { type: 'unknown' };
  }

  if (expr.type === 'BinaryExpression') {
    const left = inferExpressionType(expr.left, symbols);
    const right = inferExpressionType(expr.right, symbols);
    if (expr.operator === '+') {
      if (left.type === 'string' || right.type === 'string') return { type: 'string' };
      if (left.type === 'number' && right.type === 'number') return { type: 'number' };
      return { type: 'string | number' };
    }
    if (['-', '*', '/', '%', '**', '|', '&', '^', '<<', '>>', '>>>'].includes(expr.operator)) {
      return { type: 'number' };
    }
    if (['==', '===', '!=', '!==', '>', '<', '>=', '<='].includes(expr.operator)) {
      return { type: 'boolean' };
    }
    return mergeDescriptors([left, right]);
  }

  if (expr.type === 'LogicalExpression') {
    return mergeDescriptors([
      inferExpressionType(expr.left, symbols),
      inferExpressionType(expr.right, symbols),
    ]);
  }

  if (expr.type === 'ConditionalExpression') {
    return mergeDescriptors([
      inferExpressionType(expr.consequent, symbols),
      inferExpressionType(expr.alternate, symbols),
    ]);
  }

  if (expr.type === 'UnaryExpression') {
    if (expr.operator === '!') return { type: 'boolean' };
    if (expr.operator === '+' || expr.operator === '-' || expr.operator === '~') return { type: 'number' };
    if (expr.operator === 'void') return { type: 'void' };
  }

  if (expr.type === 'AwaitExpression') {
    return inferExpressionType(expr.argument, symbols);
  }

  return { type: 'unknown' };
}

function extractObjectExpressionSchema(objectExpr, symbols = new Map()) {
  const schema = {};
  for (const prop of objectExpr.properties || []) {
    if (prop.type === 'SpreadElement') {
      schema.__spread = { type: 'object', required: false, description: 'Spread values included.' };
      continue;
    }
    if (prop.type !== 'Property') continue;

    const key = getPropertyKeyName(prop.key);
    if (!key) continue;

    const descriptor = inferExpressionType(prop.value, symbols);
    schema[key] = {
      type: descriptor.type,
      required: true,
      description: '',
    };
    if (descriptor.schema) schema[key].schema = descriptor.schema;
    if (descriptor.items) schema[key].items = descriptor.items;
  }
  return schema;
}

function inferArrayItemsType(arrayExpr, symbols = new Map()) {
  const descriptors = (arrayExpr.elements || [])
    .filter(Boolean)
    .map((element) => inferExpressionType(element, symbols));
  if (!descriptors.length) return { type: 'unknown' };
  return mergeDescriptors(descriptors);
}

function getDescriptorAtPath(schema, path) {
  let cursor = schema;
  for (let i = 0; i < path.length; i += 1) {
    const key = path[i];
    if (!cursor || !cursor[key]) return null;
    const descriptor = cursor[key];
    if (i === path.length - 1) return descriptor;
    cursor = descriptor.schema;
  }
  return null;
}

function mergeDescriptors(descriptors) {
  const normalized = descriptors.filter((d) => d && d.type).map((d) => d);
  if (!normalized.length) return { type: 'unknown' };

  const unique = [];
  for (const item of normalized) {
    if (!unique.some((u) => u.type === item.type)) {
      unique.push(item);
    }
  }

  if (unique.length === 1) return unique[0];

  const unionType = unique.map((item) => item.type).sort().join(' | ');
  return { type: unionType };
}

function getPropertyKeyName(keyNode) {
  if (!keyNode) return null;
  if (keyNode.type === 'Identifier') return keyNode.name;
  if (keyNode.type === 'Literal' && typeof keyNode.value === 'string') return keyNode.value;
  return null;
}

function detectCommonJsExports({ source, exports }) {
  const exportAssign = /(?:module\.)?exports\.([A-Za-z0-9_]+)/g;
  let match;
  while ((match = exportAssign.exec(source))) {
    addExport(exports, {
      exportName: match[1],
      type: 'value',
      params: [],
      paramContracts: [],
      returnContract: null,
    });
  }

  const moduleExportsObject = /module\.exports\s*=\s*\{([\s\S]*?)\}/m;
  const objMatch = moduleExportsObject.exec(source);
  if (objMatch) {
    const inner = objMatch[1];
    const props = inner.split(',').map((s) => s.trim()).filter(Boolean);
    for (const prop of props) {
      const name = prop.split(':')[0].trim();
      if (/^[A-Za-z0-9_]+$/.test(name)) {
        addExport(exports, {
          exportName: name,
          type: 'value',
          params: [],
          paramContracts: [],
          returnContract: null,
        });
      }
    }
  }
}

function detectExportsByRegex({ source, exports }) {
  const namedExport = /export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)/g;
  let match;
  while ((match = namedExport.exec(source))) {
    addExport(exports, { exportName: match[1], type: 'function', params: [], paramContracts: [], returnContract: null });
  }

  const constExport = /export\s+(?:const|let|var|class)\s+([A-Za-z0-9_]+)/g;
  while ((match = constExport.exec(source))) {
    addExport(exports, { exportName: match[1], type: 'value', params: [], paramContracts: [], returnContract: null });
  }

  if (/export\s+default/.test(source)) {
    addExport(exports, { exportName: 'default', type: 'value', params: [], paramContracts: [], returnContract: null });
  }

  detectCommonJsExports({ source, exports });
  return exports;
}

module.exports = { detectExports };
