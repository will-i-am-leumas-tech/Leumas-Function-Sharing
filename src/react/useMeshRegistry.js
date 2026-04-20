const React = require('react');

function useMeshRegistry({ cacheUrl, cache } = {}) {
  const [state, setState] = React.useState({
    entries: [],
    loading: true,
    error: null,
  });

  React.useEffect(() => {
    let isMounted = true;

    async function load() {
      try {
        if (cache) {
          if (isMounted) setState({ entries: collectEntries(cache), loading: false, error: null });
          return;
        }
        if (cacheUrl && typeof fetch === 'function') {
          const res = await fetch(cacheUrl);
          const json = await res.json();
          if (isMounted) setState({ entries: collectEntries(json), loading: false, error: null });
          return;
        }
        if (isMounted) setState({ entries: [], loading: false, error: null });
      } catch (err) {
        if (isMounted) setState({ entries: [], loading: false, error: err });
      }
    }

    load();
    return () => {
      isMounted = false;
    };
  }, [cacheUrl, cache]);

  return state;
}

function collectEntries(cache) {
  if (!cache || !Array.isArray(cache.indexes)) return [];
  return cache.indexes.flatMap((idx) => idx.entries || []);
}

module.exports = { useMeshRegistry };
