import type { ReactNode } from 'react';
import { QueryRegion, type RegionQuery } from '@/components/errors/QueryRegion';
import type { LoadingVariant } from '@/components/loading/LoadingState';

export interface ContractDetailQueries {
 invoices: RegionQuery;
 deposits: RegionQuery;
 pending: RegionQuery;
 termination?: RegionQuery;
 vehicles?: RegionQuery;
 services: RegionQuery;
 buildingServices?: RegionQuery;
 history: RegionQuery;
}

/**
 * Each section declares its required sources so failed reads cannot become empty data.
 * Lúc chờ: khối xám đúng hình của khu (`skeleton`/`rows`), hoặc `loading` khi khu cần
 * giữ khung riêng (đầu thẻ, nền trắng) — chủ chốt 02/10/2026, không chữ "Đang tải…".
 */
export function ContractDetailRegion({label,queries,children,skeleton,rows,loading}:{
 label:string;queries:readonly (RegionQuery|undefined)[];children:ReactNode;
 skeleton?:LoadingVariant;rows?:number;loading?:ReactNode;
}){
 const required=queries.filter((query):query is RegionQuery=>query!=null);
 return required.length?<QueryRegion label={label} queries={required} skeleton={skeleton} rows={rows} loading={loading}>{children}</QueryRegion>:<>{children}</>;
}
