export interface PostingCashbook { id: string; name: string; organizationId: string }
type CustodyReader = () => Promise<unknown>;
type MetadataReader = (ids: string[]) => Promise<unknown>;
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_CASHBOOKS');
  return value as Record<string, unknown>;
};
const text = (value: unknown): string => { if (typeof value !== 'string' || !value) throw new Error('INVALID_CASHBOOKS'); return value; };

/** Existing custody RPC is authoritative; public account metadata is still subject to RLS. */
export async function readPostingCashbooks(organizationId: string, readCustody: CustodyReader, readMetadata: MetadataReader): Promise<PostingCashbook[]> {
  const raw = await readCustody(); if (!Array.isArray(raw)) throw new Error('INVALID_CASHBOOKS');
  const ids = [...new Set(raw.map(value => { const row = record(value); text(row.name); return text(row.id); }))].sort();
  const result: PostingCashbook[] = [];
  for (let offset = 0; offset < ids.length; offset += 100) {
    const chunk = ids.slice(offset, offset + 100), rows = await readMetadata(chunk), seen = new Set<string>();
    if (!Array.isArray(rows)) throw new Error('INVALID_CASHBOOKS');
    for (const value of rows) {
      const row = record(value), id = text(row.id), name = text(row.name), org = text(row.organization_id);
      if (!chunk.includes(id) || seen.has(id) || typeof row.is_virtual !== 'boolean' || !(row.deleted_at === null || typeof row.deleted_at === 'string')) throw new Error('INVALID_CASHBOOKS');
      seen.add(id);
      if (org === organizationId && row.deleted_at === null && row.is_virtual === false) result.push({ id, name, organizationId: org });
    }
  }
  return result.sort((a, b) => a.name.localeCompare(b.name, 'vi') || a.id.localeCompare(b.id));
}
