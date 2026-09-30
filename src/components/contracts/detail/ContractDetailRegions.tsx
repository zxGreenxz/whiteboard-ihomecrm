import type { ReactNode } from 'react';
import { QueryRegion, type RegionQuery } from '@/components/errors/QueryRegion';

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

/** Each section declares its required sources so failed reads cannot become empty data. */
export function ContractDetailRegion({label,queries,children}:{
 label:string;queries:readonly (RegionQuery|undefined)[];children:ReactNode;
}){
 const required=queries.filter((query):query is RegionQuery=>query!=null);
 return required.length?<QueryRegion label={label} queries={required}>{children}</QueryRegion>:<>{children}</>;
}
