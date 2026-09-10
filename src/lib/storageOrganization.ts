import { supabase } from '@/integrations/supabase/client';
import { requireWorkingOrganization } from '@/lib/workingOrganization';

type ParentTable = 'income_expenses' | 'buildings' | 'rooms' | 'jobs' | 'customers' | 'invoices' | 'payments' | 'document_templates' | 'reservation_deposit_settlements';
export type StorageOrganizationSource =
  | { organizationId: string | null }
  | { table: ParentTable; id: string }
  | { table: ParentTable; ids: string[] };

const PRIVATE_COMPANY_BUCKETS = new Set([
  'customer-id-cards', 'customer-images', 'income-expense-attachments',
  'job-attachments', 'payment-receipts', 'meter-images', 'document-templates',
]);

/** A parent record wins over the working company; RLS still governs its lookup. */
export async function storageUploadMetadata(bucket: string, source?: StorageOrganizationSource): Promise<Record<string, string> | undefined> {
  if (!PRIVATE_COMPANY_BUCKETS.has(bucket)) return undefined;
  let organizationId: string | null;
  if (!source) organizationId = requireWorkingOrganization();
  else if ('organizationId' in source) organizationId = source.organizationId;
  else if ('ids' in source) {
    const ids = [...new Set(source.ids)];
    if (!ids.length) throw new Error('Hãy chọn dữ liệu cần đính ảnh trước.');
    const { data, error } = await supabase.from(source.table).select('id, organization_id').in('id', ids);
    if (error) throw error;
    const companies = new Set(data.map(row => row.organization_id));
    if (data.length !== ids.length || companies.size !== 1) throw new Error('Ảnh chung chỉ được gắn cho dữ liệu cùng một công ty.');
    organizationId = data[0]?.organization_id ?? null;
  }
  else {
    const { data, error } = await supabase.from(source.table).select('organization_id').eq('id', source.id).single();
    if (error) throw error;
    organizationId = data.organization_id;
  }
  if (!organizationId) throw new Error('Dữ liệu gốc chưa có công ty rõ ràng; cần kiểm tra trước khi tải ảnh.');
  return { ihomecrm_organization_id: organizationId };
}
