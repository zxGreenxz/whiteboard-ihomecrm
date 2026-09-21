#!/usr/bin/env node
// Operator mutation for the disposable settlement_t7 database only.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';

const node=process.execPath;
const psql='C:/Program Files/PostgreSQL/17/bin/psql.exe';
const url='postgresql://postgres@127.0.0.1:55488/settlement_t7';
const migration='supabase/migrations/20260921004455_contract_settlement_termination_breakdown.sql';
const env={...process.env,PATH:path.dirname(node)+';'+process.env.PATH};

if(process.argv.includes('--verify-mutant')){
  execFileSync(psql,[url,'-v','ON_ERROR_STOP=1','-f',migration],{stdio:'pipe',env});
  execFileSync(node,['scripts/test-settlement-financial-reader-local.mjs'],{stdio:'inherit',env});
  process.exit(0);
}

const db=new pg.Client({connectionString:url});
await db.connect();
const helper=(await db.query("SELECT pg_get_functiondef('app_private.settlement_termination_breakdown_v1(uuid,uuid,uuid,uuid,boolean,boolean)'::regprocedure) body")).rows[0].body;
const reader=(await db.query("SELECT pg_get_functiondef('public.read_contract_settlement_financial_facts_v1(uuid,uuid,uuid,uuid,uuid,uuid)'::regprocedure) body")).rows[0].body;
try{
  execFileSync(node,['scripts/dot-bien.mjs','--file',migration,
    '--tim',"WHEN COALESCE(t.early_termination_fee,0)>0 AND settlement_invoice_id IS NULL THEN 'SETTLEMENT_ITEMS_UNAVAILABLE'",
    '--thay',"WHEN false THEN 'SETTLEMENT_ITEMS_UNAVAILABLE'",
    '--suite','node scripts/test-settlement-termination-breakdown-mutation-local.mjs --verify-mutant',
    '--mong-doi-chua','missing detail stays unavailable'],{stdio:'inherit',env});
}finally{
  await db.query(helper);
  await db.query(reader);
  await db.query("NOTIFY pgrst,'reload schema'");
  await db.end();
}
