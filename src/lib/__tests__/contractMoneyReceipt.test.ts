import {expect,it} from 'vitest';
import {matchesContractMoneyReceipt} from '../contractMoneyReceipt';
it.each([[200,200],['200.00',200],[0.15,0.145],[-0.15,-0.145],[12000000,1.2e7]])('valid stored money %s confirms requested %s at actual SQL scale',async(actual,requested)=>{expect(matchesContractMoneyReceipt(actual,requested)).toBe(true);});
it.each([[201,200],[10,0],[0.14,0.145]])('wrong stored money %s cannot confirm %s',(actual,requested)=>{expect(matchesContractMoneyReceipt(actual,requested)).toBe(false);});
it.each([null,undefined,false,'',0.151])('invalid stored money %s cannot confirm a requested zero',value=>{expect(()=>matchesContractMoneyReceipt(value,0)).toThrow();});
it('matches PostgreSQL numeric(15,2) positive and negative decimal tie rounding',async()=>{const {PGlite}=await import('@electric-sql/pglite');const db=new PGlite();try{const {rows}=await db.query<{positive:string;negative:string}>("SELECT 0.145::numeric(15,2)::text positive,(-0.145)::numeric(15,2)::text negative");expect(matchesContractMoneyReceipt(rows[0].positive,0.145)).toBe(true);expect(matchesContractMoneyReceipt(rows[0].negative,-0.145)).toBe(true);}finally{await db.close();}});
