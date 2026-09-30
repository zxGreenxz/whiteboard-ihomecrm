import { describe, expect, it } from 'vitest';
import { fetchAllRows } from '../supabaseFetchAll';
describe('export read failures', () => {
  it('preserves the server cause and code when the caller requests an exception', async () => {
    const error = {code:'42501',message:'permission denied'};
    await expect(fetchAllRows(async () => ({data:null,error}), {throwOnError:true})).rejects.toBe(error);
  });
  it('rejects a malformed page instead of producing an empty spreadsheet', async () => {
    await expect(fetchAllRows(async () => ({data:null,error:null}), {throwOnError:true})).rejects.toThrow();
  });
  it('identifies the size limit without losing the actual limit', async () => {
    await expect(fetchAllRows(async () => ({data:[1,2],error:null}), {pageSize:1,hardCap:1})).rejects.toMatchObject({code:'EXPORT_ROW_LIMIT',limit:1});
  });
});
