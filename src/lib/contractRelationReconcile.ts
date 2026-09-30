import {financialReadRows,financialReadNumber} from './financialReadValidation';
import { supabase } from '@/integrations/supabase/client';

export interface ContractRelationSnapshot {
  customers: Array<{ customer_id: string; is_representative: boolean; notes?: string | null }>;
  services: Array<{ service_id: string; unit_price: number; initial_reading?: number | null }>;
}

/** Read the authoritative relation rows before any recovery write. */
export async function readContractRelationSnapshot(contractId: string): Promise<ContractRelationSnapshot> {
  const [customers, services] = await Promise.all([
    supabase.from('contract_customers').select('customer_id,is_representative,notes').eq('contract_id', contractId),
    supabase.from('contract_services').select('service_id,unit_price,initial_reading').eq('contract_id', contractId),
  ]);
  if (customers.error) throw customers.error;
  if (services.error) throw services.error;
  const customerRows=financialReadRows(customers.data).map(row=>{
    if(typeof row.customer_id!=='string'||!row.customer_id||typeof row.is_representative!=='boolean'||(row.notes!==null&&typeof row.notes!=='string'))throw new TypeError('Chưa đọc được đầy đủ khách hàng hợp đồng.');return row;
  });
  const serviceRows=financialReadRows(services.data).map(row=>{
    if(typeof row.service_id!=='string'||!row.service_id)throw new TypeError('Chưa đọc được đúng dịch vụ hợp đồng.');
    return {...row,unit_price:financialReadNumber(row.unit_price),initial_reading:row.initial_reading===null?null:financialReadNumber(row.initial_reading)};
  });
  return { customers: customerRows, services: serviceRows };
}

const sortBy = <T>(items: readonly T[], key: (item: T) => string) => [...items].sort((a, b) => key(a).localeCompare(key(b)));
export function sameContractCustomers(actual: ContractRelationSnapshot['customers'], expected: ContractRelationSnapshot['customers']): boolean {
  const clean = (rows: ContractRelationSnapshot['customers']) => sortBy(rows.map(row => ({
    customer_id: row.customer_id, is_representative: row.is_representative, notes: row.notes ?? null,
  })), row => row.customer_id);
  return JSON.stringify(clean(actual)) === JSON.stringify(clean(expected));
}
export function sameContractServices(actual: ContractRelationSnapshot['services'], expected: ContractRelationSnapshot['services']): boolean {
  const clean = (rows: ContractRelationSnapshot['services']) => sortBy(rows.map(row => ({
    service_id: row.service_id, unit_price: financialReadNumber(row.unit_price), initial_reading: row.initial_reading ?? null,
  })), row => row.service_id);
  return JSON.stringify(clean(actual)) === JSON.stringify(clean(expected));
}
