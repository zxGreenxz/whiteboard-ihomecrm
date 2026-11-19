import { PGlite } from '@electric-sql/pglite';

/** Build a committed fixture once. Each test opens its own copy with loadDataDir.
 * @param {(db: PGlite) => Promise<unknown>} seed
 */
export async function snapshotPGliteFixture(seed) {
  const db = new PGlite();
  try {
    await seed(db);
    return await db.dumpDataDir('none');
  } finally {
    await db.close();
  }
}
