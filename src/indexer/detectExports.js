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
    const moduleSymbols = buildModuleSymbols(ast);
    for (const node of ast.body || []) {
      if (node.type === 'ExportNamedDeclaration') {
        if (node.declaration) {
          const decl = node.declaration;

          if (decl.type === 'FunctionDeclaration' || decl.type === 'ClassDeclaration') {
            const functionMeta = decl.type === 'FunctionDeclaration'
              ? getFunctionMeta(decl, decl.id ? decl.id.name : null)
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
                const functionMeta = isFn ? getFunctionMeta(init, d.id.name) : null;

                addExport(exports, {
                  exportName: d.id.name,
                  type: isFn ? 'function' : 'value',
                  params: functionMeta ? functionMeta.params : [],
                  paramContracts: functionMeta ? functionMeta.paramContracts : [],
                  returnContract: functionMeta ? functionMeta.returnContract : null,
                  valueContract: !isFn && init ? inferExpressionType(init, moduleSymbols) : null,
                });
              }
            }
          }
        }

        if (node.specifiers && node.specifiers.length) {
          for (const spec of node.specifiers) {
            const symbolName = spec.local && spec.local.name ? spec.local.name : spec.exported.name;
            const symbol = moduleSymbols.get(symbolName) || null;
            addExport(exports, {
              exportName: spec.exported.name,
              type: symbol && symbol.kind === 'function_meta' ? 'function' : 'value',
              params: symbol && symbol.kind === 'function_meta' ? symbol.params : [],
              paramContracts: symbol && symbol.kind === 'function_meta' ? symbol.paramContracts : [],
              returnContract: symbol && symbol.kind === 'function_meta' ? symbol.returnContract : null,
              valueContract: symbol && symbol.kind !== 'function_meta' ? symbol : null,
            });
          }
        }
      }

      if (node.type === 'ExportDefaultDeclaration') {
        const decl = node.declaration;
        const functionMeta = resolveFunctionLikeMeta(decl, moduleSymbols, 'default');
        const isFn = Boolean(functionMeta);
        const valueContract = !isFn && decl ? resolveValueContract(decl, moduleSymbols) : null;

        addExport(exports, {
          exportName: 'default',
          type: isFn ? 'function' : 'value',
          params: functionMeta ? functionMeta.params : [],
          paramContracts: functionMeta ? functionMeta.paramContracts : [],
          returnContract: functionMeta ? functionMeta.returnContract : null,
          valueContract,
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

function buildModuleSymbols(ast) {
  const symbols = new Map();
  for (const node of ast.body || []) {
    if (node.type === 'FunctionDeclaration' && node.id && node.id.name) {
      const meta = getFunctionMeta(node, node.id.name);
      symbols.set(node.id.name, { kind: 'function_meta', ...meta });
      continue;
    }
    if (node.type !== 'VariableDeclaration') continue;
    for (const decl of node.declarations || []) {
      if (!decl || !decl.id || decl.id.type !== 'Identifier' || !decl.init) continue;
      const functionMeta = resolveFunctionLikeMeta(decl.init, symbols, decl.id.name);
      if (functionMeta) {
        symbols.set(decl.id.name, { kind: 'function_meta', ...functionMeta });
        continue;
      }
      symbols.set(decl.id.name, inferExpressionType(decl.init, symbols));
    }
  }
  return symbols;
}

function resolveFunctionLikeMeta(node, symbols, functionName) {
  if (!node || typeof node !== 'object') return null;
  if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') {
    return getFunctionMeta(node, functionName || (node.id ? node.id.name : null));
  }
  if (node.type === 'Identifier') {
    const symbol = symbols.get(node.name);
    return symbol && symbol.kind === 'function_meta' ? symbol : null;
  }
  if (node.type === 'CallExpression') {
    const firstArg = (node.arguments || []).find((arg) => arg && (
      arg.type === 'FunctionExpression' ||
      arg.type === 'ArrowFunctionExpression' ||
      arg.type === 'Identifier'
    ));
    if (firstArg) {
      return resolveFunctionLikeMeta(firstArg, symbols, functionName);
    }
  }
  return null;
}

function resolveValueContract(node, symbols) {
  if (!node || typeof node !== 'object') return null;
  if (node.type === 'Identifier') {
    const symbol = symbols.get(node.name);
    if (!symbol) return null;
    if (symbol.kind === 'function_meta') {
      return symbol.returnContract || { type: 'unknown' };
    }
    return symbol;
  }
  return inferExpressionType(node, symbols);
}

function getFunctionMeta(fnNode, functionName) {
  const paramContracts = (fnNode.params || []).map((param, idx) => getParamContract(param, idx));
  const params = paramContracts.map((item) => item.name || `arg${item.index + 1}`);
  const symbols = buildFunctionSymbolTypes(fnNode, paramContracts);
  inferParamContractsFromUsage(fnNode, paramContracts, symbols);
  const returnContract = inferReturnContract(fnNode, symbols);
  applyHeuristicFallbacks({ paramContracts, returnContract, functionName });
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

  walkUsage(fnNode.body, true, null, (node, parent) => {
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
      if (parent && parent.type === 'CallExpression' && parent.callee === node) {
        return;
      }
      const access = getMemberAccessPath(node);
      if (!access) return;
      if (access.path.length === 1 && access.path[0] === 'length') {
        applyTypeHintToExpression(node.object, { type: 'array | string' }, directParams, aliasBindings, symbols);
        return;
      }
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

function walkUsage(node, isRoot, parent, visitor) {
  if (!node || typeof node !== 'object') return;
  if (!isRoot && (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression')) {
    return;
  }
  visitor(node, parent);
  for (const value of Object.values(node)) {
    if (!value) continue;
    if (Array.isArray(value)) {
      for (const child of value) {
        walkUsage(child, false, node, visitor);
      }
    } else if (value && typeof value === 'object' && value.type) {
      walkUsage(value, false, node, visitor);
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
    if (access.path.length === 1 && access.path[0] === 'length') {
      mergeTypeIntoContract(direct, { type: 'array | string' });
      symbols.set(access.root, mergeDescriptors([symbols.get(access.root) || { type: 'unknown' }, { type: direct.type }]));
      return;
    }
    ensureObjectContract(direct);
    setSchemaAtPath(direct.schema, access.path, descriptor);
    symbols.set(access.root, { type: 'object', schema: direct.schema });
    return;
  }
  const alias = aliasBindings.get(access.root);
  if (alias) {
    if (access.path.length === 1 && access.path[0] === 'length') {
      ensureObjectContract(alias.contract);
      setSchemaAtPath(alias.contract.schema, alias.path, { type: 'array | string' });
      symbols.set(access.root, mergeDescriptors([symbols.get(access.root) || { type: 'unknown' }, { type: 'number' }]));
      return;
    }
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

function applyHeuristicFallbacks({ paramContracts, returnContract, functionName }) {
  const seen = new WeakSet();
  for (const contract of paramContracts || []) {
    applyNameHeuristicsToContract(contract, contract.name, seen);
  }

  if (returnContract) {
    applyNameHeuristicsToContract(returnContract, functionName || 'result', seen);
  }
}

function applyNameHeuristicsToContract(contract, nameHint, seen = new WeakSet(), depth = 0) {
  if (!contract || typeof contract !== 'object') return;
  if (seen.has(contract) || depth > 6) return;
  seen.add(contract);

  if (!contract.type || contract.type === 'unknown') {
    const hintedType = inferTypeFromName(nameHint);
    if (hintedType) {
      contract.type = hintedType;
    }
  }

  if (contract.type === 'null') {
    const hintedType = inferTypeFromName(nameHint);
    if (hintedType) {
      contract.type = mergeTypes(contract.type, hintedType);
    }
  }

  if (typeof contract.type === 'string' && contract.type.includes('|')) {
    const hintedType = inferTypeFromName(nameHint);
    if (hintedType === 'array' && contract.type.includes('array') && contract.type.includes('string')) {
      contract.type = 'array';
    }
  }

  if (contract.schema && typeof contract.schema === 'object') {
    for (const [key, value] of Object.entries(contract.schema)) {
      applyNameHeuristicsToContract(value, key, seen, depth + 1);
    }
  }

  if (contract.type === 'array' && !contract.items) {
    const itemType = inferArrayItemTypeFromName(nameHint);
    if (itemType) {
      contract.items = { type: itemType };
    }
  }

  if (contract.type === 'array' && contract.items && contract.items.type === 'unknown') {
    const itemType = inferArrayItemTypeFromName(nameHint);
    if (itemType) {
      contract.items.type = itemType;
    }
  }

  if (contract.items && typeof contract.items === 'object') {
    applyNameHeuristicsToContract(contract.items, singularizeName(nameHint), seen, depth + 1);
  }
}

function inferTypeFromName(name) {
  const normalized = normalizeName(name);
  if (!normalized) return null;

  if (/^(is|has|can|should|will|show|hide|enable|disable|open|close|expand|collapse|active)[a-z0-9]/.test(normalized) || /(enabled|disabled|visible|hidden|ready|ok|success|valid|invalid|truncated|directed|open|closed|expanded|collapsed|active)$/.test(normalized)) {
    return 'boolean';
  }
  if (/^(max|min|count|total|sum|size|length|offset|limit|timeout|retries|retry|port|age|duration|ms|seconds|minutes|hours|score|amount|price|qty|quantity|num|density|width|height|radius|weight|filesize|megabytes|kilobytes)/.test(normalized) || /(count|total|sum|size|length|offset|limit|timeout|retries|retry|port|age|duration|seconds|minutes|hours|score|amount|price|qty|quantity|density|width|height|radius|weight|filesize|mb|kb)$/.test(normalized)) {
    return 'number';
  }
  if (/(^id$|id$)/.test(normalized)) {
    return 'string | number';
  }
  if (/^(on|handle)[a-z0-9]/.test(normalized) || /(callback|handler|fn|predicate|mapper|transformer)$/.test(normalized)) {
    return 'function';
  }
  if (/^(list|items|values|keys|entries|results|transforms|steps|errors|warnings|ids|nodes|edges|exts|extensions|files|types|routes|relations)/.test(normalized) || /(list|items|values|keys|entries|results|transforms|steps|errors|warnings|ids|nodes|edges|exts|extensions|files|types|routes|relations)$/.test(normalized)) {
    return 'array';
  }
  if (/^(options|opts|config|cfg|params|payload|data|body|query|headers|meta|metadata|context|ctx|state|props|adapter|adapters|variables|knownvariables|map|record|dictionary|result|response|request|highlight|pairhighlight|layout|position|stats|render|similarity|graph|start|goal)/.test(normalized) || /(options|config|payload|context|state|props|adapter|variables|result|response|request|highlight|layout|position|stats|render|similarity|graph|start|goal)$/.test(normalized)) {
    return 'object';
  }
  if (/^(name|title|label|path|url|uri|key|token|message|status|mode|format|type|unit|text|description)/.test(normalized) || /(name|title|label|path|url|uri|key|token|message|status|mode|format|type|unit|text|description)$/.test(normalized)) {
    return 'string';
  }
  if (/^(list|getall|findall|collect|enumerate)/.test(normalized) || /(items|values|entries|results|transforms)$/.test(normalized)) {
    return 'array';
  }
  if (/^(create|build|make|compose|merge|resolve|convert|transform|map|physics)/.test(normalized)) {
    return 'object';
  }
  if (/^(format|stringify|serialize)/.test(normalized)) {
    return 'string';
  }
  return null;
}

function normalizeName(name) {
  return String(name || '')
    .replace(/[^A-Za-z0-9]+/g, '')
    .toLowerCase();
}

function singularizeName(name) {
  let normalized = String(name || '');
  normalized = normalized.replace(/^(list|getall|findall|collect|enumerate)/i, '');
  if (normalized.endsWith('ies')) return `${normalized.slice(0, -3)}y`;
  if (normalized.endsWith('s') && normalized.length > 1) return normalized.slice(0, -1);
  return normalized || 'item';
}

function inferArrayItemTypeFromName(name) {
  const normalized = normalizeName(singularizeName(name));
  if (!normalized) return null;
  if (/(id)$/.test(normalized)) return 'string | number';
  if (/^(warning|error|message|label|name|path|key|token|ext|extension|type)$/.test(normalized)) return 'string';
  if (/^(function|relation|route|node|edge|result|entry|item|file)$/.test(normalized)) return 'object';
  return null;
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
  if (expr.type === 'JSXElement' || expr.type === 'JSXFragment') return { type: 'React.ReactElement' };
  if (expr.type === 'ObjectExpression') return { type: 'object', schema: extractObjectExpressionSchema(expr, symbols) };
  if (expr.type === 'ArrayExpression') return { type: 'array', items: inferArrayItemsType(expr, symbols) };
  if (expr.type === 'ArrowFunctionExpression' || expr.type === 'FunctionExpression') return { type: 'function' };

  if (expr.type === 'Identifier') {
    const symbol = symbols.get(expr.name);
    if (!symbol) return { type: 'unknown' };
    if (symbol.kind === 'function_meta') return symbol.returnContract || { type: 'unknown' };
    return symbol;
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
      if (expr.callee.name === 'parseInt' || expr.callee.name === 'parseFloat') return { type: 'number' };
    }
    if (expr.callee && expr.callee.type === 'MemberExpression') {
      const method = getPropertyKeyName(expr.callee.property);
      const calleeRoot = getCalleeRootName(expr.callee);
      if (method && STRING_METHODS.has(method)) return { type: 'string' };
      if (method && ARRAY_METHODS.has(method)) return { type: 'array', items: { type: 'unknown' } };
      if (calleeRoot === 'Math') return { type: 'number' };
      if (calleeRoot === 'JSON' && method === 'parse') return { type: 'object' };
      if (calleeRoot === 'JSON' && method === 'stringify') return { type: 'string' };
      if (calleeRoot === 'Object' && ['keys', 'values', 'entries'].includes(method)) return { type: 'array', items: { type: 'unknown' } };
      if (calleeRoot === 'Array' && method === 'isArray') return { type: 'boolean' };
      if (method === 'test') return { type: 'boolean' };
      if (method === 'then' || method === 'catch' || method === 'finally') return { type: 'Promise<unknown>' };
    }
    return { type: 'unknown' };
  }

  if (expr.type === 'NewExpression') {
    if (expr.callee && expr.callee.type === 'Identifier') {
      if (expr.callee.name === 'Map' || expr.callee.name === 'Set' || expr.callee.name === 'Date' || expr.callee.name === 'URL' || expr.callee.name === 'RegExp') {
        return { type: 'object' };
      }
      if (expr.callee.name === 'Promise') {
        return { type: 'Promise<unknown>' };
      }
      if (expr.callee.name === 'Array') {
        return { type: 'array', items: { type: 'unknown' } };
      }
    }
    return { type: 'object' };
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

  if (normalized.length === 1) return normalized[0];

  const out = { type: 'unknown' };
  for (const item of normalized) {
    out.type = mergeTypes(out.type, item.type);
    if (item.schema) {
      out.schema = mergeSchema(out.schema, item.schema);
    }
    if (item.items) {
      out.items = out.items ? mergeDescriptors([out.items, item.items]) : item.items;
    }
  }
  return out;
}

function getPropertyKeyName(keyNode) {
  if (!keyNode) return null;
  if (keyNode.type === 'Identifier') return keyNode.name;
  if (keyNode.type === 'Literal' && typeof keyNode.value === 'string') return keyNode.value;
  return null;
}

function getCalleeRootName(memberExpr) {
  let current = memberExpr;
  while (current && current.type === 'MemberExpression') {
    current = current.object;
  }
  return current && current.type === 'Identifier' ? current.name : null;
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
