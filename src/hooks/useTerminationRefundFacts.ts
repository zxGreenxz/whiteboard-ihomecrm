import {useContractSettlementFinancialFacts} from './useContractSettlementFinancialFacts';
export const TERMINATION_REFUND_FACTS_KEY='settlement-financial-context';
export const useTerminationRefundFacts=(voucherId:string|null|undefined,enabled=true)=>useContractSettlementFinancialFacts({roomId:null,contractId:null,voucherId:voucherId??null},enabled);
