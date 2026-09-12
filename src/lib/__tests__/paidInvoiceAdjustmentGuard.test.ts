import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { boChuThichSql } from '../../../scripts/lib/bo-chu-thich.mjs';

// Execute the latest trigger source, not a TypeScript copy of its conditions.
function liveDefinitionOf() {
  for (const name of readdirSync('supabase/migrations').filter(name => name.endsWith('.sql')).sort().reverse()) {
    const source = readFileSync(`supabase/migrations/${name}`, 'utf8');
    const match = boChuThichSql(source).match(/CREATE OR REPLACE FUNCTION public\.guard_paid_invoice_direct_adjustment\(\)[\s\S]*?END\s*\$\$;/);
    if (match) return match[0];
  }
  throw new Error('Missing production guard definition');
}
const guard = liveDefinitionOf();

describe('paid invoice adjustment guard on both trigger row types', () => {
  const db = new PGlite();
  beforeAll(async () => {
    await db.exec(`
      CREATE ROLE authenticated;
      CREATE ROLE anon;
      CREATE TABLE public.invoices (id int PRIMARY KEY, paid_amount numeric, total_amount numeric,
        subtotal numeric, discount_amount numeric, previous_debt numeric, notes text);
      CREATE TABLE public.invoice_items (id int PRIMARY KEY, invoice_id int REFERENCES public.invoices, amount numeric);
      INSERT INTO public.invoices VALUES (1, 3239000, 5239000, 5239000, 0, 0, NULL), (2, 0, 100, 100, 0, 0, NULL);
      INSERT INTO public.invoice_items VALUES (1, 1, 5239000), (2, 2, 100);
      GRANT SELECT, INSERT, UPDATE, DELETE ON public.invoices, public.invoice_items TO authenticated, anon;
      ${guard}
      ${guard}
      CREATE TRIGGER guard_paid_invoice_direct_adjustment BEFORE UPDATE ON public.invoices
        FOR EACH ROW EXECUTE FUNCTION public.guard_paid_invoice_direct_adjustment();
      CREATE TRIGGER guard_paid_invoice_item_direct_adjustment BEFORE INSERT OR UPDATE OR DELETE ON public.invoice_items
        FOR EACH ROW EXECUTE FUNCTION public.guard_paid_invoice_direct_adjustment();
    `);
  }, 30000);
  afterAll(async () => { await db.close(); });

  async function asRole(role: 'authenticated' | 'anon' | 'owner', sql: string) {
    await db.exec(`BEGIN; ${role === 'owner' ? '' : `SET LOCAL ROLE ${role};`}`);
    try { return await db.query(sql); } finally { await db.exec('ROLLBACK;'); }
  }

  it('allows the payment writer to finish collecting a partially paid invoice', async () => {
    const result = await asRole('owner', 'UPDATE public.invoices SET paid_amount=5239000 WHERE id=1 RETURNING paid_amount');
    expect(result.rows).toEqual([{ paid_amount: '5239000' }]);
  });
  it('allows notes and unchanged money values on a paid invoice', async () => {
    const result = await asRole('authenticated', "UPDATE public.invoices SET notes='receipt', total_amount=total_amount WHERE id=1 RETURNING notes");
    expect(result.rows).toEqual([{ notes: 'receipt' }]);
  });
  it.each(['total_amount', 'subtotal', 'discount_amount', 'previous_debt'])(
    'blocks direct changes to paid invoice %s', async field => {
      await expect(asRole('authenticated', `UPDATE public.invoices SET ${field}=${field}+1 WHERE id=1`)).rejects.toMatchObject({ code: '42501' });
    },
  );
  it('allows the authorized RPC owner to adjust invoice totals', async () => {
    const result = await asRole('owner', 'UPDATE public.invoices SET total_amount=6239000 WHERE id=1 RETURNING total_amount');
    expect(result.rows).toEqual([{ total_amount: '6239000' }]);
  });
  it.each([
    'INSERT INTO public.invoice_items VALUES (3,1,50)',
    'UPDATE public.invoice_items SET amount=50 WHERE id=1',
    'DELETE FROM public.invoice_items WHERE id=1',
    'UPDATE public.invoice_items SET invoice_id=2 WHERE id=1',
    'UPDATE public.invoice_items SET invoice_id=1 WHERE id=2',
  ])('blocks direct edits of either paid parent: %s', async sql => {
    await expect(asRole('authenticated', sql)).rejects.toMatchObject({ code: '42501' });
  });
  it.each([
    'INSERT INTO public.invoice_items VALUES (3,2,50) RETURNING id',
    'UPDATE public.invoice_items SET amount=50 WHERE id=2 RETURNING id',
    'DELETE FROM public.invoice_items WHERE id=2 RETURNING id',
  ])('preserves unpaid item operations: %s', async sql => {
    const result = await asRole('authenticated', sql);
    expect(result.rows).toHaveLength(1);
  });
  it('allows RPC owner item writes without evaluating invoice-only fields', async () => {
    const result = await asRole('owner', 'UPDATE public.invoice_items SET amount=50 WHERE id=1 RETURNING amount');
    expect(result.rows).toEqual([{ amount: '50' }]);
  });
  it('also rejects anonymous direct edits of paid invoice items', async () => {
    await expect(asRole('anon', 'DELETE FROM public.invoice_items WHERE id=1')).rejects.toMatchObject({ code: '42501' });
  });
});
