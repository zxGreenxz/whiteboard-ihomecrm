import assert from 'node:assert/strict';

// Migrations and seeds are identical for all probes. Roll back both the
// control's writes and the changed function body before starting another case.
export async function testTaskSqlMutations(t, fixture, cases) {
  for (const [label, sql, probe] of cases) {
    await t.test(label, async () => {
      await fixture.rollbackCase(async () => {
        assert.equal(await probe(fixture), true, 'bản gốc phải đạt');
      });
      await fixture.rollbackCase(async () => {
        await fixture.db.exec(sql);
        assert.equal(await probe(fixture), false, 'đột biến phải làm cùng phép kiểm thất bại');
      });
    });
  }
}
