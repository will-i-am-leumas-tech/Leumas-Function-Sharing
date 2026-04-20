const fs = require('fs');

function normalizeRuntimePath(value, options = {}) {
  if (typeof value !== 'string' || !value) return value;

  const platform = options.platform || process.platform;
  const candidates = getRuntimePathCandidates(value, platform);
  const exists = options.exists || ((candidate) => {
    try {
      return fs.existsSync(candidate);
    } catch (err) {
      return false;
    }
  });

  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }
  return candidates[0] || value;
}

function normalizeRuntimeArgs(args, options = {}) {
  if (!Array.isArray(args)) return args;
  return args.map((arg) => normalizeRuntimePath(arg, options));
}

function normalizeEntryForRuntime(entry, options = {}) {
  if (!entry || !entry.execution) return entry;
  const execution = entry.execution;
  return {
    ...entry,
    execution: {
      ...execution,
      modulePath: normalizeRuntimePath(execution.modulePath, options),
      projectRoot: normalizeRuntimePath(execution.projectRoot, options),
      filePath: normalizeRuntimePath(execution.filePath, options),
      cwd: normalizeRuntimePath(execution.cwd, options),
      command: normalizeRuntimePath(execution.command, options),
      args: normalizeRuntimeArgs(execution.args, options),
    },
  };
}

function getRuntimePathCandidates(value, platform = process.platform) {
  const text = String(value);
  const candidates = [text];
  const wslToWindows = toWindowsDrivePath(text);
  const windowsToWsl = toWslDrivePath(text);

  if (platform === 'win32' && wslToWindows) {
    candidates.unshift(wslToWindows);
  } else if (platform !== 'win32' && windowsToWsl) {
    candidates.unshift(windowsToWsl);
  } else {
    if (wslToWindows) candidates.push(wslToWindows);
    if (windowsToWsl) candidates.push(windowsToWsl);
  }

  return [...new Set(candidates)];
}

function toWindowsDrivePath(value) {
  const match = String(value).match(/^\/mnt\/([a-zA-Z])(?:\/(.*))?$/);
  if (!match) return null;
  const drive = match[1].toUpperCase();
  const rest = match[2] ? match[2].replace(/\//g, '\\') : '';
  return rest ? `${drive}:\\${rest}` : `${drive}:\\`;
}

function toWslDrivePath(value) {
  const match = String(value).match(/^([a-zA-Z]):[\\/]*(.*)$/);
  if (!match) return null;
  const drive = match[1].toLowerCase();
  const rest = match[2] ? match[2].replace(/\\/g, '/') : '';
  return rest ? `/mnt/${drive}/${rest}` : `/mnt/${drive}`;
}

module.exports = {
  normalizeRuntimePath,
  normalizeRuntimeArgs,
  normalizeEntryForRuntime,
  getRuntimePathCandidates,
  toWindowsDrivePath,
  toWslDrivePath,
};
