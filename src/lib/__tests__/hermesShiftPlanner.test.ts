import { describe, expect, it } from "vitest";
import { prepare, solve, type Building, type Person, type ShiftInput } from "../../../supabase/functions/hermes-shift-test/planner";
const building=(id:string,own=true):Building=>({id,key:id,label:id,week:[6],own,vacancies:0,lastFull:"2026-11-24",active:false});
const person:Person={id:"p",home:"H",anchor:null,off:false,buildings:[building("A"),building("B"),building("C",false)],jobs:[]};
const data:ShiftInput={date:"2026-11-28",at:"2026-11-28T00:30:00+07:00",reason:"shift",office:"A",metres:{H:{A:300,B:3000},A:{B:300,H:300},B:{A:300,H:3000}},people:[person]};
describe("Hermes shift plan",()=>{
  it("publishes the Saturday route without a user action and replans a new urgent job at its building",()=>{
    const base=solve(data,person,prepare(data,person));
    expect(base.stops.map(s=>s.label).sort()).toEqual(["A","B"]);
    const last=base.stops[1].label;
    const updated={...person,jobs:[{id:"j",title:"Sửa rò nước",building:last,priority:"URGENT",deadline:null}]};
    const visits=prepare(data,updated);
    const newPlan=solve(data,updated,visits,[10,10]);
    expect(newPlan.stops[0]).toMatchObject({label:last,urgent:true,full:true,taskIds:["j"]});
    expect(newPlan.stops).toHaveLength(2);
  });
  it("keeps an active inspection first and a completed FULL separate from a repair",()=>{
    const p={...person,buildings:[{...building("A"),active:true},{...building("B"),lastFull:data.date}],jobs:[{id:"j",title:"Sửa",building:"B",priority:"URGENT",deadline:null}]};
    const r=solve(data,p,prepare(data,p));
    expect(r.stops[0].active).toBe(true);
    expect(r.stops[1].full).toBe(false);
  });
  it("does not assign Sunday inspections or transfer the other manager’s building",()=>{
    const sunday={...data,date:"2026-11-29"};
    expect(prepare(sunday,person)).toEqual([]);
    expect(prepare(data,person).some(v=>v.label==="C")).toBe(false);
  });
  it("starts an urgent repair before lunch rather than moving it into the afternoon",()=>{
    const p={...person,jobs:[{id:"j",title:"Sửa",building:"A",priority:"URGENT",deadline:null}]};
    const change={...data,at:"2026-11-28T11:20:00+07:00",reason:"job"};
    expect(solve(change,p,prepare(change,p)).stops[0].start).toBeLessThan(690);
  });
  it("can keep a nearby appointment before an urgent job when both response windows fit",()=>{
    const v=prepare(data,person);
    v[0]={...v[0],duration:8,deadline:492};
    v[1]={...v[1],urgent:true,duration:35};
    const best=solve(data,person,v);
    expect(best.stops.map(s=>s.label)).toEqual(["A","B"]);
    expect(best.stops.every(s=>!s.late)).toBe(true);
  });
});
