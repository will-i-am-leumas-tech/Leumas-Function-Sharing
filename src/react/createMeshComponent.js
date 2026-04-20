function createMeshComponent({ modulePath, exportName }) {
  const React = require('react');
  return React.lazy(async () => {
    const mod = await import(/* @vite-ignore */ modulePath);
    const component = exportName === 'default' ? mod.default : mod[exportName];
    return { default: component };
  });
}

module.exports = { createMeshComponent };
