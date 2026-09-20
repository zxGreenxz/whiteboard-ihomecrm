import { supabase } from '@/integrations/supabase/client';
import type { SettlementPageReader } from './contractSettlementReader';
type ReaderRpc = (name: 'read_contract_settlement_page_v1', args: {p_organization_id:string;p_building_ids:string[];p_cursor:string|null;p_revision:string|null;p_limit:number}) => PromiseLike<{data:unknown;error:{message:string;code?:string}|null}>;
export const readSettlementPage: SettlementPageReader = async (scope,cursor,revision) => {
 const result = await (supabase.rpc as unknown as ReaderRpc)('read_contract_settlement_page_v1', {p_organization_id:scope.organizationId,p_building_ids:[...new Set(scope.buildingIds)].sort(),p_cursor:cursor,p_revision:revision,p_limit:250});
 if(result.error) throw new Error(result.error.code === 'PT409' ? 'SETTLEMENT_CHANGED_RELOAD' : result.error.code === '42501' ? 'SETTLEMENT_READ_DENIED' : 'SETTLEMENT_READ_FAILED');
 return result.data;
};
