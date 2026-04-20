function isPascalCase(name) {
  return /^[A-Z][A-Za-z0-9]*$/.test(name || '');
}

function isHookName(name) {
  return /^use[A-Z0-9]/.test(name || '');
}

function detectReactType({ exportName, filePath, source }) {
  const isJsxFile = /\.(jsx|tsx)$/.test(filePath);
  if (isHookName(exportName)) return 'react_hook';
  if (isPascalCase(exportName) && isJsxFile) return 'react_component';
  if (isPascalCase(exportName) && source && /return\s*\(/.test(source)) return 'react_component';
  if (isPascalCase(exportName) && source && /React\.createElement\s*\(/.test(source)) return 'react_component';
  if (isPascalCase(exportName) && source && /createElement\s*\(/.test(source)) return 'react_component';
  return null;
}

module.exports = { detectReactType, isPascalCase, isHookName };
