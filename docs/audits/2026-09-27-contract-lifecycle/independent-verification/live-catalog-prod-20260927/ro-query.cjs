// Read-only catalog/aggregate reader for the independent audit.
// - Reads the production pooler password from the vault file itself (never printed).
// - Runs every statement inside BEGIN READ ONLY ... ROLLBACK.
// Usage: node ro-query.cjs <file.sql> <out.json>
// The .sql file may contain several statements separated by a line "-- @@ <label>".
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const ROOT = 'C:/Users/Nguyen Tam/whiteboard-ihomecrm-main';
const vault = fs.readFileSync(path.join(ROOT, 'CLAUDE.local.md'), 'utf8');
const m = vault.match(/Persistent database password[^`]*`([^`]+)`/);
if (!m) { console.error('password line not found'); process.exit(3); }
const ref = fs.readFileSync(path.join(ROOT, 'supabase/.temp/project-ref'), 'utf8').trim();
if (ref !== 'tryymsxyyckgbrmmvozx') { console.error('unexpected project ref'); process.exit(3); }

const [, , sqlFile, outFile] = process.argv;
const text = fs.readFileSync(sqlFile, 'utf8');
const parts = text.split(/^-- @@ /m).filter(s => s.trim());
const blocks = parts.map(p => {
  const nl = p.indexOf('\n');
  return { label: p.slice(0, nl).trim(), sql: p.slice(nl + 1).trim() };
});

(async () => {
  const client = new Client({
    host: 'aws-1-ap-southeast-1.pooler.supabase.com', port: 5432, database: 'postgres',
    user: `postgres.${ref}`, password: m[1], ssl: { rejectUnauthorized: false },
    statement_timeout: 60000, application_name: 'audit-contract-lifecycle-readonly',
  });
  client.on('error', () => {});
  await client.connect();
  const out = { target: `project ${ref} (production)`, at: new Date().toISOString(), results: {} };
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout = '60s'");
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
  } finally {
    await client.end();
  }
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
  console.log('ok', Object.keys(out.results).length, 'blocks ->', outFile);
})().catch(e => { console.error('failed:', e.message); process.exit(1); });
