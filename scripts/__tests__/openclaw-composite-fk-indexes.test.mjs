import { describe, expect, it } from "vitest";

import { createDisposableOpenClawDatabase } from "../test-openclaw-migrations.mjs";

const MISSING_COMPOSITE_FK_INDEXES_SQL = `
  select
    child.relname as "tableName",
    constraint_row.conname as "constraintName",
    array_agg(attribute.attname order by key_column.ordinality) as columns
  from pg_catalog.pg_constraint constraint_row
  join pg_catalog.pg_class child
    on child.oid=constraint_row.conrelid
  join pg_catalog.pg_namespace namespace
    on namespace.oid=child.relnamespace
  cross join lateral pg_catalog.unnest(constraint_row.conkey)
    with ordinality key_column(attnum,ordinality)
  join pg_catalog.pg_attribute attribute
    on attribute.attrelid=constraint_row.conrelid
   and attribute.attnum=key_column.attnum
  where constraint_row.contype='f'
    and namespace.nspname='public'
    and child.relname like 'openclaw\\_%' escape '\\'
    and pg_catalog.cardinality(constraint_row.conkey)>1
    and not exists (
      select 1
      from pg_catalog.pg_index index_row
      where index_row.indrelid=constraint_row.conrelid
        and index_row.indisvalid
        and index_row.indisready
        and (
          select pg_catalog.array_agg(
            index_column.attnum order by index_column.ordinality
          )
          from pg_catalog.unnest(index_row.indkey)
            with ordinality index_column(attnum,ordinality)
          where index_column.ordinality <=
            pg_catalog.cardinality(constraint_row.conkey)
        ) = constraint_row.conkey
    )
  group by child.relname,constraint_row.conname
  order by child.relname,constraint_row.conname
`;

describe("OpenClaw composite foreign-key indexes", () => {
  it("indexes every composite FK with the complete FK sequence as a prefix", async () => {
    const database = await createDisposableOpenClawDatabase();
    try {
      const result = await database.query(MISSING_COMPOSITE_FK_INDEXES_SQL);
      expect(result.rows).toEqual([]);
    } finally {
      await database.close();
    }
  }, 30_000);

  it("detects a missing complete-prefix index through a catalog mutation", async () => {
    const database = await createDisposableOpenClawDatabase();
    try {
      const generated = await database.query(`
        select schemaname,indexname,tablename
        from pg_catalog.pg_indexes
        where schemaname='public'
          and indexname like 'openclaw_fk\\_%' escape '\\'
        order by indexname
        limit 1
      `);
      expect(generated.rows).toHaveLength(1);
      const { indexname, tablename } = generated.rows[0];
      expect(indexname).toMatch(/^openclaw_fk_[0-9a-f]{32}_idx$/);
      await database.exec(`drop index public."${indexname}"`);

      const result = await database.query(MISSING_COMPOSITE_FK_INDEXES_SQL);
      expect(result.rows).not.toEqual([]);
      expect(result.rows.some((row) => row.tableName === tablename)).toBe(true);
    } finally {
      await database.close();
    }
  }, 30_000);
});
