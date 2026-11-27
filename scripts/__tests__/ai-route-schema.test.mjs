import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

test('routing schema is closed to end users, legacy by default, and concurrent sync cannot inherit a stale probe', async () => {
  const db = new PGlite();
  try {
    await db.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;');
    const sql = await readFile(new URL('../../supabase/migrations/20261127170740_ai_application_routes.sql',import.meta.url),'utf8');
    await db.exec(sql); await db.exec(sql);
    for (const role of ['anon','authenticated']) {
      await db.exec('SET ROLE ' + role);
      for (const cmd of ["SELECT * FROM public.ai_route_catalogs", "UPDATE public.ai_application_routes SET routes='[]'", "SELECT public.record_ai_route_probe('nous',now(),'openai/model',true)"])
        await assert.rejects(db.exec(cmd), err => err.code === '42501');
      await db.exec('RESET ROLE');
    }
    await db.exec('SET ROLE service_role');
    assert.equal((await db.query("SELECT count(*)::int n FROM public.ai_application_routes WHERE routes='[]' AND revision=0")).rows[0].n,4);
    await db.query("INSERT INTO public.ai_route_catalogs(provider,models,synced_at) VALUES ('nous',$1,'2026-01-02Z')",[JSON.stringify([{id:'openai/model',vision:true}])]);
    for (const [date,model,expected] of [['2026-01-01Z','openai/model',false],['2026-01-02Z','openai/other',false],['2026-01-02Z','openai/model',true]]) {
      assert.equal((await db.query("SELECT public.record_ai_route_probe('nous',$1,$2,true) ok",[date,model])).rows[0].ok,expected);
    }
    assert.deepEqual((await db.query('SELECT models FROM public.ai_route_catalogs')).rows[0].models,[{id:'openai/model', vision:true, tested:true, verified:true}]);
  } finally { await db.close(); }
}, 30000);
