// scripts/functionIndexer2.js
// Enhanced + resilient function indexer (RETURN-JSON version):
// - Extracts detailed inputs/outputs per function
// - Adds best-effort param VALUE TYPE inference (string/number/boolean/object/array/function/promise/etc.)
// - Multi-pass parsing (module/script/topLevelReturnAwait/wrapped IIFE)
// - FALLBACK parse via acorn-loose (recovers from many "Unexpected token" cases)
// - Optionally ignores test folders (--ignore-tests)
// - BigInt-safe serialization
// - NO FILE OUTPUT: returns a JSON object (and CLI prints JSON to stdout)
//
// Usage:
//   node scripts/functionIndexer2.js [dir] [--ignore-tests] [--quiet]
// Programmatic:
//   const { indexFunctionsInDir } = require('./scripts/functionIndexer2');
//   const out = await indexFunctionsInDir('D:/Leumas', { ignoreTests: true, quiet: true });

const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const acornLoose = require('acorn-loose');
const walk = require('acorn-walk');

/* ---------------------------
   CLI
---------------------------- */

function parseArgs(argv) {
  const args = {
    dir: null,
    ignoreTests: false,
    quiet: false,
  };

  for (const a of argv) {
    if (a === '--ignore-tests') args.ignoreTests = true;
    else if (a === '--quiet') args.quiet = true;
    else if (!a.startsWith('--') && !args.dir) args.dir = a;
  }

  return args;
}

/* ---------------------------
   Directory Scanning
---------------------------- */

function getAllFunctionsInDir(dir, options = {}) {
  let results = {};
  let parseErrors = [];

  const baseExcludedDirs = [
    'node_modules', 'DesktopApplications', 'dist', 'build', '.git', 'assets',
    '.venv', 'mp-env', '.next', 'codex', 'imperium', 'venv', 'Marion',
    'doc', 'docs', 'NPM', 'LMSCoin copy', 'src2', 'templates',
  ];

  const testExcludedDirs = [
    'test', 'tests', '__tests__', '__test__', 'spec', 'specs', 'e2e', 'cypress', '.storybook',
  ];

  const excludedDirs = options.ignoreTests
    ? Array.from(new Set([...baseExcludedDirs, ...testExcludedDirs]))
    : baseExcludedDirs;

  let stats = {
    totalDirectoriesScanned: 0,
    totalFilesScanned: 0,
    totalJSFilesScanned: 0,
    totalFunctionsFound: 0,
    totalParseErrors: 0,
  };

  function readDirRecursive(currentDir) {
    stats.totalDirectoriesScanned++;

    let files;
    try {
      files = fs.readdirSync(currentDir);
    } catch (e) {
      return;
    }

    files.forEach(file => {
      const fullPath = path.join(currentDir, file);

      let stat;
      try {
        stat = fs.statSync(fullPath);
      } catch (e) {
        return;
      }

      if (stat.isDirectory()) {
        if (!excludedDirs.includes(file)) {
          readDirRecursive(fullPath);
        }
        return;
      }

      if (!stat.isFile()) return;

      stats.totalFilesScanned++;

      // Only parse .js by default
      if (path.extname(file) !== '.js') return;

      stats.totalJSFilesScanned++;

      const { functions, parseError } = getFunctionsFromFile(fullPath);

      if (parseError) {
        stats.totalParseErrors++;
        parseErrors.push({
          file: fullPath,
          message: parseError.message,
          loc: parseError.loc || null,
          pass: parseError.pass || null,
        });

        if (!options.quiet) {
          console.error(
            `Error parsing ${fullPath}: ${parseError.message}` +
            (parseError.loc ? ` (${parseError.loc.line}:${parseError.loc.column})` : '') +
            (parseError.pass ? ` [${parseError.pass}]` : '')
          );
        }
      }

      if (functions.length > 0) {
        results[fullPath] = functions;
        stats.totalFunctionsFound += functions.length;
      }
    });
  }

  readDirRecursive(dir);
  return { results, stats, parseErrors };
}

/* ---------------------------
   Cleaning / Parsing
---------------------------- */

function cleanFileContent(content) {
  content = content.replace(/^\uFEFF/, '');

  function stripInvalidHeaderLines(code) {
    const lines = code.split(/\r?\n/);
    let i = 0;

    while (i < lines.length) {
      const line = lines[i].trim();

      if (line.startsWith('#!')) {
        i++;
        continue;
      }

      const looksLikeJS = /^((import|export|const|let|var|function|class|async)\b|[({[])/.test(line);
      if (looksLikeJS) break;

      i++;
    }

    return lines.slice(i).join('\n');
  }

  return stripInvalidHeaderLines(content);
}

function getFunctionsFromFile(filePath) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    return { functions: [], parseError: { message: `readFileSync failed: ${e.message}` } };
  }

  const cleaned = cleanFileContent(content);

  // ✅ Multi-pass parse: strict acorn passes, then acorn-loose passes
  const parsePasses = [
    {
      pass: 'module',
      parse: (code) => acorn.parse(code, {
        ecmaVersion: 'latest',
        sourceType: 'module',
        locations: true,
        ranges: true,
        allowHashBang: true,
      }),
      transform: code => code,
    },
    {
      pass: 'script',
      parse: (code) => acorn.parse(code, {
        ecmaVersion: 'latest',
        sourceType: 'script',
        locations: true,
        ranges: true,
        allowHashBang: true,
      }),
      transform: code => code,
    },
    {
      pass: 'script+topLevelReturnAwait',
      parse: (code) => acorn.parse(code, {
        ecmaVersion: 'latest',
        sourceType: 'script',
        locations: true,
        ranges: true,
        allowHashBang: true,
        allowReturnOutsideFunction: true,
        allowAwaitOutsideFunction: true,
      }),
      transform: code => code,
    },
    {
      pass: 'wrapped-IIFE',
      parse: (code) => acorn.parse(code, {
        ecmaVersion: 'latest',
        sourceType: 'script',
        locations: true,
        ranges: true,
        allowHashBang: true,
        allowReturnOutsideFunction: true,
        allowAwaitOutsideFunction: true,
      }),
      transform: code => `(function(){\n${code}\n})();`,
    },

    // ✅ Loose fallbacks
    {
      pass: 'loose-wrapped-IIFE',
      parse: (code) => acornLoose.parse(code, {
        ecmaVersion: 'latest',
        sourceType: 'script',
        locations: true,
        ranges: true,
        allowHashBang: true,
      }),
      transform: code => `(function(){\n${code}\n})();`,
    },
    {
      pass: 'loose-script',
      parse: (code) => acornLoose.parse(code, {
        ecmaVersion: 'latest',
        sourceType: 'script',
        locations: true,
        ranges: true,
        allowHashBang: true,
      }),
      transform: code => code,
    },
  ];

  let lastErr = null;

  for (const p of parsePasses) {
    try {
      const code = p.transform(cleaned);
      const ast = p.parse(code);
      const functions = extractFunctionsFromAst(ast, code, p.pass);
      return { functions, parseError: null };
    } catch (e) {
      lastErr = { message: e.message, loc: e.loc || null, pass: p.pass };
    }
  }

  return { functions: [], parseError: lastErr || { message: 'Unknown parse error' } };
}

function extractFunctionsFromAst(ast, code, passName) {
  const functions = [];

  function pushFunctionRecord(name, paramsNodes, bodyNode, meta) {
    const fnInfo = analyzeFunction({
      name: name || '',
      paramsNodes,
      bodyNode,
      meta: { ...meta, parsePass: passName },
      source: code,
    });
    functions.push(fnInfo);
  }

  walk.simple(ast, {
    FunctionDeclaration(node) {
      pushFunctionRecord(node.id?.name, node.params, node.body, {
        kind: 'FunctionDeclaration',
        async: !!node.async,
        generator: !!node.generator,
        loc: node.loc,
        range: node.range,
      });
    },

    VariableDeclarator(node) {
      if (node.init && (node.init.type === 'FunctionExpression' || node.init.type === 'ArrowFunctionExpression')) {
        const name = node.id?.name || '(anonymous)';
        pushFunctionRecord(name, node.init.params, node.init.body, {
          kind: `VariableDeclarator:${node.init.type}`,
          async: !!node.init.async,
          generator: !!node.init.generator,
          loc: node.loc,
          range: node.range,
        });
      }
    },

    AssignmentExpression(node) {
      if (node.right && (node.right.type === 'FunctionExpression' || node.right.type === 'ArrowFunctionExpression')) {
        let name = '';
        if (node.left.type === 'Identifier') name = node.left.name;
        else if (node.left.type === 'MemberExpression') name = safePropName(node.left.property);

        pushFunctionRecord(name || '(anonymous)', node.right.params, node.right.body, {
          kind: `AssignmentExpression:${node.right.type}`,
          async: !!node.right.async,
          generator: !!node.right.generator,
          loc: node.loc,
          range: node.range,
        });
      }
    },

    MethodDefinition(node) {
      const name = safePropName(node.key) || '(method)';
      pushFunctionRecord(name, node.value.params, node.value.body, {
        kind: 'MethodDefinition',
        async: !!node.value.async,
        generator: !!node.value.generator,
        loc: node.loc,
        range: node.range,
      });
    },

    Property(node) {
      if (node.value && (node.value.type === 'FunctionExpression' || node.value.type === 'ArrowFunctionExpression')) {
        const name = safePropName(node.key) || '(property-fn)';
        pushFunctionRecord(name, node.value.params, node.value.body, {
          kind: `Property:${node.value.type}`,
          async: !!node.value.async,
          generator: !!node.value.generator,
          loc: node.loc,
          range: node.range,
        });
      }
    },
  });

  return functions;
}

/* ---------------------------
   Param Descriptors
---------------------------- */

function getParamDescriptor(param) {
  if (!param) return { type: 'unknown', text: 'unknown', valueTypes: ['unknown'], valueType: 'unknown' };

  switch (param.type) {
    case 'Identifier':
      return { type: 'Identifier', name: param.name, text: param.name, valueTypes: ['unknown'], valueType: 'unknown' };

    case 'AssignmentPattern': {
      const left = getParamDescriptor(param.left);
      const inferredFromDefault = inferValueTypeFromExpression(param.right);
      return {
        type: 'AssignmentPattern',
        left,
        right: summarizeExpression(param.right),
        text: `${left.text} = ${summarizeExpression(param.right).text}`,
        valueTypes: inferredFromDefault.types.length ? inferredFromDefault.types : ['unknown'],
        valueType: inferredFromDefault.primary || 'unknown',
      };
    }

    case 'RestElement':
      return {
        type: 'RestElement',
        argument: getParamDescriptor(param.argument),
        text: `...${getParamDescriptor(param.argument).text}`,
        valueTypes: ['array'],
        valueType: 'array',
      };

    case 'ObjectPattern':
      return {
        type: 'ObjectPattern',
        properties: (param.properties || []).map(p => summarizePatternProperty(p)),
        text: '{...}',
        valueTypes: ['object'],
        valueType: 'object',
      };

    case 'ArrayPattern':
      return {
        type: 'ArrayPattern',
        elements: (param.elements || []).map(el => (el ? getParamDescriptor(el) : { type: 'Hole', text: '' })),
        text: '[...]',
        valueTypes: ['array'],
        valueType: 'array',
      };

    default:
      return { type: param.type, text: param.type, valueTypes: ['unknown'], valueType: 'unknown' };
  }
}

function summarizePatternProperty(p) {
  if (!p) return { type: 'unknown' };
  if (p.type === 'RestElement') return { type: 'RestElement', text: `...${safeIdentifierName(p.argument)}` };

  const key = safePropName(p.key);
  if (p.value?.type === 'Identifier') {
    return {
      type: 'Property',
      key,
      value: p.value.name,
      text: key === p.value.name ? key : `${key}: ${p.value.name}`,
    };
  }

  return { type: 'Property', key, value: p.value?.type || 'unknown', text: key };
}

function safeIdentifierName(node) {
  return node && node.type === 'Identifier' ? node.name : 'unknown';
}

function safePropName(node) {
  if (!node) return '';
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'Literal') return String(node.value);
  return '';
}

/* ---------------------------
   Function Analysis (Inputs/Outputs + Param Types)
---------------------------- */

function analyzeFunction({ name, paramsNodes, bodyNode, meta }) {
  const params = (paramsNodes || []).map(getParamDescriptor);
  const paramNames = new Set(flattenParamNames(paramsNodes || []));

  const hasReqParam = paramNames.has('req');
  const hasResParam = paramNames.has('res');

  const functionBody = bodyNode && bodyNode.type === 'BlockStatement' ? bodyNode : null;
  const walkTarget = functionBody || bodyNode;

  const paramTypeHints = inferParamTypesFromBody({ walkTarget, paramNames });

  for (const p of params) {
    if (p.type === 'Identifier' && p.name) {
      const hint = paramTypeHints[p.name];
      if (hint && hint.types.length) {
        p.valueTypes = hint.types;
        p.valueType = hint.primary;
        p.typeEvidence = hint.evidence;
      }
    }
    if (p.type === 'AssignmentPattern' && p.left?.type === 'Identifier' && p.left?.name) {
      const hint = paramTypeHints[p.left.name];
      const merged = uniq([...(p.valueTypes || []), ...(hint?.types || [])].filter(Boolean));
      if (merged.length) {
        p.valueTypes = merged;
        p.valueType = pickPrimaryTypeFromList(merged, hint?.primary || p.valueType);
        p.typeEvidence = (hint?.evidence || []);
      }
    }
    if (p.type === 'RestElement' && p.argument?.type === 'Identifier' && p.argument?.name) {
      const hint = paramTypeHints[p.argument.name];
      const merged = uniq([...(p.valueTypes || []), ...(hint?.types || [])].filter(Boolean));
      if (merged.length) {
        p.valueTypes = merged;
        p.valueType = pickPrimaryTypeFromList(merged, hint?.primary || p.valueType);
        p.typeEvidence = (hint?.evidence || []);
      }
    }
  }

  const inputs = {
    params,
    paramNames: Array.from(paramNames),
    referencedParams: [],
    paramTypeHints,
    req: {
      used: hasReqParam,
      accessPaths: [],
      buckets: { params: [], query: [], body: [], headers: [], cookies: [], user: [], locals: [], other: [] },
      destructured: [],
      methods: [],
    },
  };

  const outputs = {
    returns: { count: 0, values: [], objectShapes: [] },
    res: { used: hasResParam, methods: [], statusCodes: [], payloadShapes: [], sends: [] },
    throws: [],
  };

  const referencedParamsSet = new Set();
  let lastStatusCode = null;

  if (walkTarget) {
    walk.ancestor(walkTarget, {
      Identifier(node, ancestors) {
        if (paramNames.has(node.name)) {
          const parent = ancestors[ancestors.length - 2];
          const isParamPosition =
            parent &&
            (parent.type === 'FunctionDeclaration' ||
              parent.type === 'FunctionExpression' ||
              parent.type === 'ArrowFunctionExpression') &&
            parent.params &&
            parent.params.includes(node);

          if (!isParamPosition) referencedParamsSet.add(node.name);
        }
      },

      VariableDeclarator(node) {
        if (!hasReqParam) return;
        if (!node.id) return;

        const initInfo = getReqMemberBase(node.init);
        if (!initInfo) return;

        const fromPath = initInfo.path;
        if (node.id.type === 'ObjectPattern') {
          const keys = node.id.properties
            .map(p => (p.type === 'Property' ? safePropName(p.key) : p.type === 'RestElement' ? '...rest' : ''))
            .filter(Boolean);

          inputs.req.destructured.push({ from: `req.${fromPath}`, keys, loc: node.loc || null });
          keys.forEach(k => recordReqPath(inputs.req, `${fromPath}.${k}`));
        }
      },

      MemberExpression(node) {
        const reqInfo = getMemberPathIfRoot(node, 'req');
        if (reqInfo && hasReqParam) recordReqPath(inputs.req, reqInfo.join('.'));
      },

      CallExpression(node) {
        if (hasResParam) {
          const calleePath = getCalleePath(node.callee);
          if (calleePath && calleePath.root === 'res') {
            const method = calleePath.path[0] || '(call)';
            outputs.res.methods.push(method);

            if (method === 'status' && node.arguments && node.arguments[0]) {
              const arg0 = node.arguments[0];
              if (arg0.type === 'Literal' && typeof arg0.value === 'number') {
                lastStatusCode = arg0.value;
                outputs.res.statusCodes.push(arg0.value);
              } else {
                lastStatusCode = null;
              }
            }

            if ((method === 'json' || method === 'send') && node.arguments && node.arguments[0]) {
              const payload = node.arguments[0];
              const payloadSummary = summarizeExpression(payload);

              outputs.res.sends.push({ method, status: lastStatusCode, argument: payloadSummary, loc: node.loc || null });

              const shape = extractObjectShape(payload);
              if (shape.length) outputs.res.payloadShapes.push({ method, status: lastStatusCode, keys: shape, loc: node.loc || null });
            }

            if (method === 'redirect' || method === 'render' || method === 'end') {
              outputs.res.sends.push({
                method,
                status: lastStatusCode,
                argument: node.arguments?.[0] ? summarizeExpression(node.arguments[0]) : { type: 'none', text: '' },
                loc: node.loc || null,
              });
            }
          }
        }

        if (hasReqParam) {
          const calleePath = getCalleePath(node.callee);
          if (calleePath && calleePath.root === 'req') {
            const method = calleePath.path[0] || '(call)';
            inputs.req.methods.push(method);
          }
        }
      },

      ReturnStatement(node) {
        outputs.returns.count++;
        if (!node.argument) {
          outputs.returns.values.push({ type: 'undefined', text: 'return;', loc: node.loc || null });
          return;
        }
        const summary = summarizeExpression(node.argument);
        outputs.returns.values.push({ ...summary, loc: node.loc || null });

        const shape = extractObjectShape(node.argument);
        if (shape.length) outputs.returns.objectShapes.push({ keys: shape, loc: node.loc || null });
      },

      ThrowStatement(node) {
        outputs.throws.push({
          argument: node.argument ? summarizeExpression(node.argument) : { type: 'unknown', text: 'throw' },
          loc: node.loc || null,
        });
      },
    });
  }

  inputs.referencedParams = Array.from(referencedParamsSet);

  inputs.req.accessPaths = uniq(inputs.req.accessPaths);
  inputs.req.methods = uniq(inputs.req.methods);
  outputs.res.methods = uniq(outputs.res.methods);
  outputs.res.statusCodes = uniq(outputs.res.statusCodes);

  return {
    name,
    kind: meta?.kind || 'unknown',
    async: !!meta?.async,
    generator: !!meta?.generator,
    parsePass: meta?.parsePass || null,
    loc: meta?.loc || null,
    range: meta?.range || null,
    inputs,
    outputs,
  };
}

/* ---------------------------
   Param Value Type Inference (best-effort)
---------------------------- */

function inferParamTypesFromBody({ walkTarget, paramNames }) {
  const out = {};
  for (const n of paramNames) out[n] = { types: [], primary: 'unknown', evidence: [] };
  if (!walkTarget) return out;

  function addHint(name, type, reason, loc) {
    if (!paramNames.has(name)) return;
    if (!out[name]) out[name] = { types: [], primary: 'unknown', evidence: [] };
    out[name].types.push(type);
    out[name].evidence.push({ type, reason, loc: loc || null });
  }

  const isParamId = (node) => node && node.type === 'Identifier' && paramNames.has(node.name);

  function handleTypeofBinary(node) {
    if (!node || node.type !== 'BinaryExpression') return;
    if (!['===', '==', '!==', '!='].includes(node.operator)) return;

    const left = node.left;
    const right = node.right;

    if (left?.type === 'UnaryExpression' && left.operator === 'typeof' && isParamId(left.argument) && right?.type === 'Literal') {
      const t = String(right.value);
      if (['string', 'number', 'boolean', 'function', 'object', 'undefined', 'symbol', 'bigint'].includes(t)) {
        addHint(left.argument.name, t, `typeof ${left.argument.name} ${node.operator} "${t}"`, node.loc);
      }
    }

    if (right?.type === 'UnaryExpression' && right.operator === 'typeof' && isParamId(right.argument) && left?.type === 'Literal') {
      const t = String(left.value);
      if (['string', 'number', 'boolean', 'function', 'object', 'undefined', 'symbol', 'bigint'].includes(t)) {
        addHint(right.argument.name, t, `"${t}" ${node.operator} typeof ${right.argument.name}`, node.loc);
      }
    }
  }

  function addStringHintForArgs(args, reasonPrefix, loc) {
    if (!Array.isArray(args)) return;
    for (const a of args) if (isParamId(a)) addHint(a.name, 'string', reasonPrefix, loc);
  }
  function addStringHintForFirstArg(args, reasonPrefix, loc) {
    const a0 = args?.[0];
    if (isParamId(a0)) addHint(a0.name, 'string', reasonPrefix, loc);
  }

  const PATH_STRING_METHODS = new Set(['join', 'resolve', 'normalize', 'basename', 'dirname', 'extname', 'format', 'parse', 'relative']);
  const FS_PATH_FIRSTARG_METHODS = new Set([
    'readFileSync','readFile','writeFileSync','writeFile','appendFileSync','appendFile',
    'readdirSync','readdir','statSync','stat','lstatSync','lstat',
    'existsSync','accessSync','mkdirSync','mkdir','rmSync','rm','unlinkSync','unlink',
    'createReadStream','createWriteStream','copyFileSync','copyFile','renameSync','rename','openSync','open'
  ]);

  walk.ancestor(walkTarget, {
    TemplateLiteral(node) {
      for (const expr of node.expressions || []) {
        if (isParamId(expr)) addHint(expr.name, 'string', `used in template literal \`\${${expr.name}}\``, node.loc);
      }
    },

    NewExpression(node) {
      if (node.callee?.type === 'Identifier' && node.callee.name === 'RegExp') {
        addStringHintForFirstArg(node.arguments, `new RegExp(...)`, node.loc);
      }
    },

    CallExpression(node) {
      if (node.callee?.type === 'Identifier' && paramNames.has(node.callee.name)) {
        addHint(node.callee.name, 'function', `${node.callee.name}(...) called`, node.loc);
      }

      if (node.callee?.type === 'Identifier') {
        const fn = node.callee.name;
        const a0 = node.arguments?.[0];
        if (a0 && isParamId(a0)) {
          if (fn === 'Number' || fn === 'parseInt' || fn === 'parseFloat') addHint(a0.name, 'number', `${fn}(${a0.name})`, node.loc);
          if (fn === 'String') addHint(a0.name, 'string', `String(${a0.name})`, node.loc);
          if (fn === 'Boolean') addHint(a0.name, 'boolean', `Boolean(${a0.name})`, node.loc);
        }
      }

      if (node.callee?.type === 'MemberExpression') {
        const calleePath = getMemberPath(node.callee);
        if (calleePath) {
          const root = calleePath.root;
          const method = calleePath.path?.[0] || '';

          if (root === 'path' && PATH_STRING_METHODS.has(method)) {
            addStringHintForArgs(node.arguments, `path.${method}(...)`, node.loc);
          }
          if (root === 'fs' && FS_PATH_FIRSTARG_METHODS.has(method)) {
            addStringHintForFirstArg(node.arguments, `fs.${method}(path, ...)`, node.loc);
          }
          if (root === 'Array' && method === 'isArray') {
            const a0 = node.arguments?.[0];
            if (a0 && isParamId(a0)) addHint(a0.name, 'array', `Array.isArray(${a0.name})`, node.loc);
          }
        }
      }
    },

    AwaitExpression(node) {
      if (isParamId(node.argument)) addHint(node.argument.name, 'promise', `await ${node.argument.name}`, node.loc);
    },

    BinaryExpression(node) {
      handleTypeofBinary(node);

      const numericOps = new Set(['-', '*', '/', '%', '**', '<<', '>>', '>>>', '|', '&', '^']);
      if (numericOps.has(node.operator)) {
        if (isParamId(node.left)) addHint(node.left.name, 'number', `${node.left.name} ${node.operator} ...`, node.loc);
        if (isParamId(node.right)) addHint(node.right.name, 'number', `... ${node.operator} ${node.right.name}`, node.loc);
      }

      if (node.operator === '+') {
        if (isParamId(node.left) && node.right?.type === 'Literal') {
          if (typeof node.right.value === 'string') addHint(node.left.name, 'string', `${node.left.name} + "..."`, node.loc);
          if (typeof node.right.value === 'number') addHint(node.left.name, 'number', `${node.left.name} + 1`, node.loc);
        }
        if (isParamId(node.right) && node.left?.type === 'Literal') {
          if (typeof node.left.value === 'string') addHint(node.right.name, 'string', `"..." + ${node.right.name}`, node.loc);
          if (typeof node.left.value === 'number') addHint(node.right.name, 'number', `1 + ${node.right.name}`, node.loc);
        }
      }
    },

    UnaryExpression(node) {
      if (node.operator === '!' && isParamId(node.argument)) addHint(node.argument.name, 'boolean', `!${node.argument.name}`, node.loc);
      if (node.operator === '+' && isParamId(node.argument)) addHint(node.argument.name, 'number', `+${node.argument.name}`, node.loc);
    },

    UpdateExpression(node) {
      if (isParamId(node.argument)) addHint(node.argument.name, 'number', `${node.argument.name}${node.operator}`, node.loc);
    },

    MemberExpression(node) {
      if (node.object && isParamId(node.object)) {
        const prop = getPropertyName(node.property, node.computed);

        if (prop === 'length') addHint(node.object.name, 'string|array', `${node.object.name}.length`, node.loc);

        const stringMethods = new Set(['toLowerCase','toUpperCase','trim','split','substring','slice','replace','match','includes','startsWith','endsWith','charAt']);
        if (stringMethods.has(prop)) addHint(node.object.name, 'string', `${node.object.name}.${prop}(...)`, node.loc);

        const arrayMethods = new Set(['map','filter','reduce','push','pop','shift','unshift','forEach','find','findIndex','some','every','join','slice','splice','concat']);
        if (arrayMethods.has(prop)) addHint(node.object.name, 'array', `${node.object.name}.${prop}(...)`, node.loc);

        const promiseMethods = new Set(['then','catch','finally']);
        if (promiseMethods.has(prop)) addHint(node.object.name, 'promise', `${node.object.name}.${prop}(...)`, node.loc);
      }
    },

    IfStatement(node) {
      if (node.test && isParamId(node.test)) addHint(node.test.name, 'truthy', `if (${node.test.name})`, node.loc);
    },
  });

  for (const k of Object.keys(out)) {
    const raw = out[k].types.flatMap(t => String(t).split('|'));
    const cleaned = uniq(raw.map(s => s.trim()).filter(Boolean));
    out[k].types = cleaned.length ? cleaned : ['unknown'];
    out[k].primary = pickPrimaryTypeFromList(out[k].types);
    out[k].evidence = (out[k].evidence || []).slice(0, 30);
  }

  return out;
}

function pickPrimaryTypeFromList(types, preferred) {
  if (preferred && types.includes(preferred)) return preferred;
  const order = ['string','number','boolean','array','object','function','promise','bigint','symbol','undefined','null','truthy','unknown'];
  for (const t of order) if (types.includes(t)) return t;
  return types[0] || 'unknown';
}

function inferValueTypeFromExpression(expr) {
  if (!expr) return { types: [], primary: null };

  switch (expr.type) {
    case 'Literal':
      if (typeof expr.value === 'string') return { types: ['string'], primary: 'string' };
      if (typeof expr.value === 'number') return { types: ['number'], primary: 'number' };
      if (typeof expr.value === 'boolean') return { types: ['boolean'], primary: 'boolean' };
      if (expr.value === null) return { types: ['null'], primary: 'null' };
      if (typeof expr.value === 'bigint') return { types: ['bigint'], primary: 'bigint' };
      return { types: ['unknown'], primary: 'unknown' };

    case 'ObjectExpression':
      return { types: ['object'], primary: 'object' };

    case 'ArrayExpression':
      return { types: ['array'], primary: 'array' };

    case 'ArrowFunctionExpression':
    case 'FunctionExpression':
      return { types: ['function'], primary: 'function' };

    case 'Identifier':
      if (expr.name === 'undefined') return { types: ['undefined'], primary: 'undefined' };
      return { types: ['unknown'], primary: 'unknown' };

    default:
      return { types: ['unknown'], primary: 'unknown' };
  }
}

/* ---------------------------
   Member Path Helpers
---------------------------- */

function flattenParamNames(paramsNodes) {
  const names = [];

  function rec(node) {
    if (!node) return;
    switch (node.type) {
      case 'Identifier': names.push(node.name); return;
      case 'AssignmentPattern': rec(node.left); return;
      case 'RestElement': rec(node.argument); return;
      case 'ObjectPattern':
        (node.properties || []).forEach(p => {
          if (p.type === 'Property') rec(p.value);
          else if (p.type === 'RestElement') rec(p.argument);
        });
        return;
      case 'ArrayPattern':
        (node.elements || []).forEach(el => rec(el));
        return;
      default: return;
    }
  }

  paramsNodes.forEach(rec);
  return names.filter(Boolean);
}

function getMemberPathIfRoot(memberExpr, rootName) {
  const info = getMemberPath(memberExpr);
  if (!info) return null;
  if (info.root !== rootName) return null;
  return info.path;
}

function getMemberPath(node) {
  if (!node || node.type !== 'MemberExpression') return null;

  const pathParts = [];
  let cur = node;

  while (cur && cur.type === 'MemberExpression') {
    const prop = getPropertyName(cur.property, cur.computed);
    if (prop == null) break;
    pathParts.unshift(prop);
    cur = cur.object;
  }

  if (cur && cur.type === 'Identifier') return { root: cur.name, path: pathParts };
  return null;
}

function getPropertyName(property, computed = false) {
  if (!property) return null;

  if (!computed) {
    if (property.type === 'Identifier') return property.name;
    if (property.type === 'Literal') return String(property.value);
  } else {
    if (property.type === 'Literal') return String(property.value);
    return '[computed]';
  }

  return null;
}

function getCalleePath(callee) {
  if (!callee) return null;
  if (callee.type === 'Identifier') return { root: callee.name, path: [] };
  if (callee.type === 'MemberExpression') return getMemberPath(callee);
  return null;
}

function getReqMemberBase(node) {
  const info = getMemberPath(node);
  if (!info) return null;
  if (info.root !== 'req') return null;
  return { path: info.path.join('.') };
}

/* ---------------------------
   req tracking
---------------------------- */

function recordReqPath(reqObj, fullPath) {
  reqObj.accessPaths.push(fullPath);

  const top = (fullPath.split('.')[0] || '').trim();
  const rest = fullPath.split('.').slice(1).join('.') || '';

  if (top === 'params') reqObj.buckets.params.push(rest || '*');
  else if (top === 'query') reqObj.buckets.query.push(rest || '*');
  else if (top === 'body') reqObj.buckets.body.push(rest || '*');
  else if (top === 'headers') reqObj.buckets.headers.push(rest || '*');
  else if (top === 'cookies') reqObj.buckets.cookies.push(rest || '*');
  else if (top === 'user') reqObj.buckets.user.push(rest || '*');
  else if (top === 'locals') reqObj.buckets.locals.push(rest || '*');
  else reqObj.buckets.other.push(fullPath);

  Object.keys(reqObj.buckets).forEach(k => {
    reqObj.buckets[k] = uniq(reqObj.buckets[k].filter(Boolean));
  });
}

/* ---------------------------
   Expression summarizers
---------------------------- */

function summarizeExpression(node) {
  if (!node) return { type: 'unknown', text: '' };

  switch (node.type) {
    case 'Literal': {
      if (typeof node.value === 'bigint') return { type: 'BigInt', value: node.value.toString(), text: `${node.value.toString()}n` };
      return { type: 'Literal', value: node.value, text: JSON.stringify(node.value) };
    }
    case 'Identifier': return { type: 'Identifier', name: node.name, text: node.name };
    case 'TemplateLiteral': return { type: 'TemplateLiteral', text: '`...`' };
    case 'ObjectExpression': {
      const keys = extractObjectShape(node);
      return { type: 'ObjectExpression', text: `{ ${keys.slice(0, 12).join(', ')}${keys.length > 12 ? ', ...' : ''} }` };
    }
    case 'ArrayExpression': return { type: 'ArrayExpression', text: '[...]' };
    case 'CallExpression': return { type: 'CallExpression', text: summarizeCall(node) };
    case 'AwaitExpression': return { type: 'AwaitExpression', text: `await ${summarizeExpression(node.argument).text}` };
    case 'BinaryExpression':
    case 'LogicalExpression':
      return { type: node.type, text: `${summarizeExpression(node.left).text} ${node.operator} ${summarizeExpression(node.right).text}` };
    case 'UnaryExpression': return { type: 'UnaryExpression', text: `${node.operator}${summarizeExpression(node.argument).text}` };
    case 'MemberExpression': {
      const info = getMemberPath(node);
      if (info) return { type: 'MemberExpression', text: `${info.root}.${info.path.join('.')}` };
      return { type: 'MemberExpression', text: 'obj.prop' };
    }
    default: return { type: node.type, text: node.type };
  }
}

function summarizeCall(node) {
  const calleePath = getCalleePath(node.callee);

  const calleeText = calleePath
    ? `${calleePath.root}${calleePath.path.length ? '.' + calleePath.path.join('.') : ''}`
    : summarizeExpression(node.callee).text;

  const argTexts = (node.arguments || []).slice(0, 4).map(a => summarizeExpression(a).text);
  const more = (node.arguments || []).length > 4 ? ', ...' : '';
  return `${calleeText}(${argTexts.join(', ')}${more})`;
}

/* ---------------------------
   Object shape extraction
---------------------------- */

function extractObjectShape(node) {
  if (!node) return [];
  if (node.type === 'ObjectExpression') {
    const keys = [];
    for (const prop of node.properties || []) {
      if (prop.type === 'Property') {
        const k = safePropName(prop.key);
        if (k) keys.push(k);
      } else if (prop.type === 'SpreadElement') {
        keys.push('...spread');
      }
    }
    return keys;
  }
  return [];
}

/* ---------------------------
   Utilities
---------------------------- */

function uniq(arr) {
  return Array.from(new Set(arr));
}

function safeJsonStringify(obj, pretty = false) {
  return JSON.stringify(
    obj,
    (key, value) => (typeof value === 'bigint' ? value.toString() : value),
    pretty ? 2 : 0
  );
}

/* ---------------------------
   Public API
---------------------------- */

async function indexFunctionsInDir(dir, options = {}) {
  const targetDir = dir || process.cwd();
  const { results, stats, parseErrors } = getAllFunctionsInDir(targetDir, {
    ignoreTests: !!options.ignoreTests,
    quiet: !!options.quiet,
  });

  return {
    meta: {
      dir: targetDir,
      generatedAt: new Date().toISOString(),
      format: 'json',
      version: 'functionIndexer2-return-json',
    },
    stats,
    parseErrors,
    results, // { [filePath]: [functionRecord, ...] }
  };
}

module.exports = { indexFunctionsInDir };

/* ---------------------------
   CLI Main (prints JSON to stdout)
---------------------------- */

if (require.main === module) {
  (async function main() {
    const cli = parseArgs(process.argv.slice(2));
    const dir = cli.dir || process.cwd();

    if (!cli.quiet) {
      console.error(`Scanning directory: ${dir}`);
      if (cli.ignoreTests) console.error(`Ignoring test folders: enabled`);
      console.error(`Output: printing JSON to stdout (no files written).`);
    }

    const out = await indexFunctionsInDir(dir, { ignoreTests: cli.ignoreTests, quiet: cli.quiet });

    // Print ONLY JSON on stdout so piping works cleanly:
    process.stdout.write(safeJsonStringify(out, true) + '\n');
  })().catch(err => {
    // keep stderr for errors; stdout reserved for JSON
    console.error(err && err.stack ? err.stack : String(err));
    process.exitCode = 1;
  });
}
