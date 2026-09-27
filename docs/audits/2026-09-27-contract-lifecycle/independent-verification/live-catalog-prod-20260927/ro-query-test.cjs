// Read-only catalog reader for the TEST project (ihomecrm-test). Password read from vault, never printed.
// Usage: node ro-query-test.cjs <file.sql> <out.json>
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const ROOT = 'C:/Users/Nguyen Tam/whiteboard-ihomecrm-main';
const vault = fs.readFileSync(path.join(ROOT, 'CLAUDE.local.md'), 'utf8');
const pw = (vault.match(/^TEST_SUPABASE_DB_PASSWORD=(\S+)\s*$/m) || [])[1];
const ref = (vault.match(/^TEST_SUPABASE_REF=(\S+)\s*$/m) || [])[1];
const host = (vault.match(/^TEST_SUPABASE_POOLER_HOST=(\S+)\s*$/m) || [])[1];
if (!pw || ref !== 'hzulujxgonszuleqticb' || !host) { console.error('TEST credential lines not found / unexpected ref'); process.exit(3); }

const [, , sqlFile, outFile] = process.argv;
const text = fs.readFileSync(sqlFile, 'utf8');
const blocks = text.split(/^-- @@ /m).filter(s => s.trim()).map(p => {
  const nl = p.indexOf('\n');
  return { label: p.slice(0, nl).trim(), sql: p.slice(nl + 1).trim() };
});

(async () => {
  const client = new Client({ host, port: 5432, database: 'postgres', user: `postgres.${ref}`, password: pw,
    ssl: { rejectUnauthorized: false }, statement_timeout: 60000, application_name: 'audit-contract-lifecycle-readonly' });
  client.on('error', () => {});
  await client.connect();
  const out = { target: `project ${ref} (TEST)`, at: new Date().toISOString(), results: {} };
  try {
    await client.query('BEGIN READ ONLY');
    for (const b of blocks) {
      try {
        await client.query('SAVEPOINT s');
        const r = await client.query(b.sql);
        out.results[b.label] = { rowCount: r.rowCount, rows: r.rows };
        await client.query('RELEASE SAVEPOINT s');
      } catch (e) {
        out.results[b.label] = { error: String(e.message) };
        await client.query('ROLLBACK TO SAVEPOINT s');
      }
    }
    await client.query('ROLLBACK');
  } finally { await client.end(); }
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
  console.log('ok', Object.keys(out.results).length, 'blocks ->', outFile);
})().catch(e => { console.error('failed:', e.message); process.exit(1); });
