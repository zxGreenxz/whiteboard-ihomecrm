import { describe, expect, it, vi } from "vitest";
import { readReservationReceivedFacts } from "../reservationDepositReceived";
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
describe("received facts boundary",()=>{
  it("deduplicates, sorts and pages 401 voucher IDs within max200, preserving missing as unknown",async()=>{
    const invoke=vi.fn(async(_name:string,args:{p_voucher_ids:string[]})=>({
      error:null,data:args.p_voucher_ids.filter(v=>v!==id(7)).map(v=>({voucher_id:v,reservation_id:id(500),received_amount:10})),
    }));
    const facts=await readReservationReceivedFacts(invoke,id(999),[...Array.from({length:401},(_,n)=>id(401-n)),id(1)]);
    expect(invoke.mock.calls.map(([,a])=>a.p_voucher_ids.length)).toEqual([200,200,1]);
    expect(invoke.mock.calls.flatMap(([,a])=>a.p_voucher_ids)).toEqual(Array.from({length:401},(_,n)=>id(n+1)));
    expect(facts.size).toBe(400);expect(facts.has(id(7))).toBe(false);
  });
  it.each([
    [{voucher_id:id(1),reservation_id:null,received_amount:-1}],
    [{voucher_id:id(1),reservation_id:null,received_amount:0.5}],
    [{voucher_id:id(2),reservation_id:null,received_amount:1}],
    [{voucher_id:id(1),reservation_id:null,received_amount:1},{voucher_id:id(1),reservation_id:null,received_amount:1}],
    null,
  ].map(data=>({data})))("rejects malformed, foreign or repeated facts $data",async({data})=>{
    await expect(readReservationReceivedFacts(async()=>({data,error:null}),id(999),[id(1)])).rejects.toThrow();
  });
  it("returns only verified facts and leaves a missing visible voucher unknown",async()=>{
    const fact={voucher_id:id(1),reservation_id:null,received_amount:500000};
    const result=await readReservationReceivedFacts(async()=>({data:[fact],error:null}),id(999),[id(1),id(2)]);
    expect(result.get(id(1))).toEqual(fact);expect(result.has(id(2))).toBe(false);
  });
  it("propagates a failed later page instead of returning partially known money",async()=>{
    const error={code:"42501",message:"denied"};
    const invoke=vi.fn().mockResolvedValueOnce({data:[],error:null}).mockResolvedValueOnce({data:null,error});
    await expect(readReservationReceivedFacts(invoke,id(999),Array.from({length:201},(_,n)=>id(n+1)))).rejects.toBe(error);
  });
});
