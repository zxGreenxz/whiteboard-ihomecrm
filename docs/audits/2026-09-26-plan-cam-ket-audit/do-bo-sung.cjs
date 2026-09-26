// Audit only: each SQL runs inside BEGIN READ ONLY ... ROLLBACK.
// Usage from this folder: NODE_PATH=<repo>/node_modules node do-bo-sung.cjs <queries.json> <output.json>
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const pg = require('pg');
const REPO = path.resolve(__dirname, '../../..');
const REF = 'tryymsxyyckgbrmmvozx';
pg.types.setTypeParser(1082, v => v);
const queries = JSON.parse(fs.readFileSync(path.resolve(__dirname, process.argv[2]), 'utf8'));
const vault = fs.readFileSync(path.join(REPO, 'CLAUDE.local.md'), 'utf8');
const match = vault.match(/Persistent database password[^`]*`([^`]+)`/);
if (!match) throw new Error('Missing database credential');
const client = new pg.Client({
  host: 'aws-1-ap-southeast-1.pooler.supabase.com', port: 5432, database: 'postgres',
  user: 'postgres.' + REF, password: match[1], ssl: { rejectUnauthorized: false },
  statement_timeout: 60000, application_name: 'independent_plan_audit_read_only',
});
(async () => {
  let connected = false;
  const output = {
    started_at: new Date().toISOString(), project_ref: REF,
    code_ref: execFileSync('git', ['rev-parse', 'origin/main'], {cwd: REPO, encoding: 'utf8'}).trim(),
    transaction: 'BEGIN READ ONLY ... ROLLBACK', results: {},
  };
  try {
    await client.connect(); connected = true;
    await client.query('BEGIN READ ONLY');
    output.session = (await client.query("SELECT current_database() db, current_user actor, current_setting('transaction_read_only') read_only, now() at time zone 'Asia/Ho_Chi_Minh' time_vn")).rows;
    for (const { name, sql } of queries) {
      if (!/^\s*(select|with)\b/i.test(sql)) throw new Error('Only SELECT/WITH queries accepted: ' + name);
      await client.query('SAVEPOINT audit_query');
      try {
        const res = await client.query(sql);
        output.results[name] = { sql, rows: res.rows };
        await client.query('RELEASE SAVEPOINT audit_query');
        console.log('OK ' + name + ': ' + res.rowCount);
      } catch (e) {
        await client.query('ROLLBACK TO SAVEPOINT audit_query');
        output.results[name] = { sql, error: e.message.split('\n')[0] };
        console.log('ERROR ' + name + ': ' + e.message.split('\n')[0]);
      }
    }
  } finally {
    if (connected) { await client.query('ROLLBACK'); await client.end(); }
  }
  output.finished_at = new Date().toISOString();
  fs.writeFileSync(path.resolve(__dirname, process.argv[3]), JSON.stringify(output, null, 2) + '\n');
})().catch(e => { console.error(e.message.split('\n')[0]); process.exitCode = 1; });
