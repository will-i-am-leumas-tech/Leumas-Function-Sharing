const { pathToFileURL } = require('url');

async function main() {
  const payloadRaw = process.argv[2];
  if (!payloadRaw) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'Missing payload' }));
    return;
  }

  try {
    const payload = JSON.parse(payloadRaw);
    const mod = await import(pathToFileURL(payload.modulePath).href);
    const fn = payload.exportName === 'default' ? mod.default : mod[payload.exportName];
    if (typeof fn !== 'function') {
      process.stdout.write(JSON.stringify({ ok: false, error: 'Export is not a function' }));
      return;
    }
    const result = await fn(...(payload.args || []));
    process.stdout.write(JSON.stringify({ ok: true, result }));
  } catch (err) {
    process.stdout.write(JSON.stringify({ ok: false, error: err.message || String(err) }));
  }
}

main();
