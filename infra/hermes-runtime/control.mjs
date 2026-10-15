#!/usr/bin/env node
const [op, actor] = process.argv.slice(2);
if (!['health', 'stats', 'revoke'].includes(op) || (op === 'revoke' && !['a', 'b'].includes(actor))) throw new Error('Invalid fixture control command');
const response = await fetch('http://127.0.0.1:8081/control', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ op, ...(actor ? { actor } : {}) }), signal: AbortSignal.timeout(5_000),
});
if (!response.ok) throw new Error(`Fixture control rejected (${response.status})`);
console.log(JSON.stringify(await response.json()));
