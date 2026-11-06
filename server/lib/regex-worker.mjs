// Runs one regex job off the main thread so a catastrophic pattern can be
// killed by a timeout instead of freezing the server.

import { parentPort, workerData } from 'node:worker_threads';

const { pattern, flags, text, replace, max, cases } = workerData;

try {
  const global = new RegExp(pattern, flags.includes('g') ? flags : flags + 'g');
  const matches = [];
  let total = 0;
  for (const m of text.matchAll(global)) {
    total++;
    if (matches.length < max) {
      matches.push({ index: m.index, text: m[0], groups: m.slice(1), named: m.groups ? { ...m.groups } : null });
    }
    if (total >= 100_000) break;
  }
  const result = { ok: true, matches, total, capped: total >= 100_000, groupNames: null };
  if (replace !== undefined && replace !== null) result.replaced = text.replace(new RegExp(pattern, flags), replace);
  if (cases) {
    const single = new RegExp(pattern, flags.replace(/[gy]/g, ''));
    result.cases = cases.map((c) => {
      const m = single.exec(c);
      return { input: c, match: m ? m[0] : null, full: m ? m[0] === c : false, groups: m ? m.slice(1) : [] };
    });
  }
  parentPort.postMessage(result);
} catch (err) {
  parentPort.postMessage({ ok: false, error: err.message });
}
