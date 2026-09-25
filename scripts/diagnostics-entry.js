// Compiled into diagnostics.js. Only the build CLI supplies this constant.
(() => {
  const enabled = __JAA_LOGGERS__;
  const entries = [];
  const allowed = new Set(['taskId', 'stage', 'iteration', 'maxIterations', 'provider', 'model', 'tool', 'action',
    'status', 'count', 'chars', 'durationMs', 'code', 'reason']);
  function safe(value) {
    return String(value).slice(0, 600)
      .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
      .replace(/\b(?:sk-|sk_)[a-z0-9_-]+/gi, '[redacted]')
      .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]')
      .replace(/https?:\/\/\S+/gi, '[url]');
  }
  Object.defineProperty(globalThis, 'jaaDiagnostics', { value: Object.freeze({
    enabled,
    log: enabled ? (event, data = {}) => {
      const record = { time: new Date().toISOString(), event: safe(event) };
      for (const [key, value] of Object.entries(data)) {
        if (allowed.has(key) && ['string', 'number', 'boolean'].includes(typeof value)) record[key] = typeof value === 'string' ? safe(value) : value;
      }
      entries.push(record);
      if (entries.length > 200) entries.shift();
      console.info('[ApplyOnce]', record);
    } : () => {},
    snapshot: enabled ? () => entries.map(entry => ({ ...entry })) : () => [],
    clear: () => { entries.length = 0; }
  }), configurable: false, writable: false });
})();
