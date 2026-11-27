export interface Building {
  id: string; label: string; key: string; week: number[]; own: boolean; vacancies: number; lastFull: string | null; active: boolean;
}
export interface Job { id: string; building: string | null; title: string; priority: string; deadline: string | null }
export interface Person { id: string; home: string; anchor: string | null; off: boolean; buildings: Building[]; jobs: Job[] }
export interface ShiftInput { date: string; at: string; reason: string; office: string; metres: Record<string,Record<string,number>>; people: Person[] }
export interface Visit {
  building: string | null; label: string; key: string; full: boolean; daysLeft: number | null; urgent: boolean;
  active: boolean; jobs: Job[]; duration: number; deadline: number;
}
export interface Stop {
  building: string | null; label: string; full: boolean; daysLeft: number | null; urgent: boolean; active: boolean;
  taskIds: string[]; start: number; end: number; late: boolean; approximate: boolean;
}
export interface ScoredRoute { stops: Stop[]; score: number[]; order: number[] }
export const MODEL = 'cx/gpt-6.2-astra(xhigh)';
const dayMs=86_400_000, shiftEnd=17*60+30, lunchStart=11*60+30, lunchEnd=13*60+30;
const stamp = (day: string) => Date.parse(day+'T00:00:00+07:00');
const minutes = (value: string, day: string) => Math.floor((Date.parse(value)-stamp(day))/60000);
export function jobKind(title: string) {
  const lower = title.toLocaleLowerCase('vi');
  if (/rò|rỉ|nước|ngập/.test(lower)) return 'nước';
  if (/điện|cháy|chập/.test(lower)) return 'điện';
  if (/thợ|lịch hẹn/.test(lower)) return 'hẹn thợ';
  if (/thu tiền|thu phí/.test(lower)) return 'thu tiền';
  return 'việc tại tòa';
}
export function prepare(input: ShiftInput, person: Person): Visit[] {
  const weekday = new Date(stamp(input.date)+7*3600000).getUTCDay();
  const off = person.off || weekday===0;
  const jobs = person.jobs.filter(j => !j.deadline || minutes(j.deadline,input.date)<1440 || j.priority==='URGENT');
  const buildings = new Map(person.buildings.map(b=>[b.id,b]));
  const grouped = new Map<string,Visit>();
  for (const b of person.buildings) {
    if (!b.own) continue;
    const gap = b.vacancies>0 ? 3 : 4;
    const left = b.lastFull ? gap-Math.round((stamp(input.date)-stamp(b.lastFull))/dayMs) : null;
    const should = !off && (left===null || left<=0 || (left===1 && weekday===6) || b.week.includes(weekday));
    if (!b.active && (!should || b.lastFull===input.date)) continue;
    grouped.set(b.id,{building:b.id,label:b.label,key:b.key,full:true,daysLeft:left,active:b.active,urgent:false,jobs:[],duration:15,deadline:shiftEnd});
  }
  for (const j of jobs) {
    if (off && j.priority!=='URGENT') continue;
    const b = j.building ? buildings.get(j.building) : undefined;
    const group = j.building || j.id;
    const stop = grouped.get(group) ?? {building:j.building,label:b?.label??'Việc ngoài tuyến',key:b?.key??group,full:false,daysLeft:null,active:false,urgent:false,jobs:[],duration:0,deadline:shiftEnd};
    stop.jobs.push(j);
    stop.duration+=jobKind(j.title)==='nước' ? 35 : 25;
    stop.urgent ||= j.priority==='URGENT';
    if (j.deadline) stop.deadline=Math.min(stop.deadline, Math.max(0,minutes(j.deadline,input.date)));
    grouped.set(group,stop);
  }
  return [...grouped.values()];
}
export function scoreOrder(data: ShiftInput,p: Person,visits: Visit[],order: number[]): ScoredRoute {
  const t0=data.reason==='shift'?480:Math.max(480,minutes(data.at,data.date));
  let t=t0, loc=p.anchor??(t>=lunchEnd?data.office:p.home), travel=0, urgentWait=0, responseOver=0,
      missed=0, lateMinutes=0, activeWait=0, breakTaken=t0>=lunchEnd;
  const stops: Stop[]=[];
  function drive(from:string,to:string) {
    if (from===to) return 0;
    const metres=data.metres[from]?.[to];
    return metres===undefined ? 18 : Math.max(1,Math.ceil(metres/300));
  }
  for (const idx of order) {
    const v=visits[idx];
    let leg=drive(loc,v.key);
    if (!breakTaken && !v.active && !v.urgent && t+leg+v.duration+drive(v.key,data.office)>lunchStart) {
      const via=drive(loc,data.office);
      t=Math.max(lunchEnd,t+via+Math.min(120,Math.max(0,lunchEnd-t-via)));
      travel+=via;loc=data.office;leg=drive(loc,v.key);breakTaken=true;
    }
    const approximate=loc!==v.key && data.metres[loc]?.[v.key]===undefined;
    const start=t+(v.active && !stops.length?0:leg), end=start+v.duration;
    if (v.urgent) { urgentWait+=start-t0; responseOver+=Math.max(0,start-t0-25); }
    if (v.active) activeWait+=start-t0;
    const late=Math.max(0,end-v.deadline);
    if (late>0) {missed++;lateMinutes+=late;}
    stops.push({building:v.building,label:v.label,full:v.full,daysLeft:v.daysLeft,urgent:v.urgent,active:v.active,
      taskIds:v.jobs.map(j=>j.id),start,end,late:late>0,approximate});
    travel+=leg;loc=v.key;t=end;
  }
  const homeLeg=drive(loc,p.home);
  return {order,stops,score:[activeWait,responseOver,missed,lateMinutes,Math.max(0,t+homeLeg-shiftEnd),urgentWait,travel+homeLeg]};
}
export function better(a:ScoredRoute,b:ScoredRoute) {
  for (let i=0;i<a.score.length;i++) if(a.score[i]!==b.score[i]) return a.score[i]<b.score[i];
  return false;
}
export function solve(data: ShiftInput,p:Person,visits:Visit[],hint?:number[]) {
  // Insert the hardest commitments first and evaluate every insertion against the same clock.
  const indices=visits.map((_,i)=>i).sort((a,b)=>Number(visits[b].active)-Number(visits[a].active)
    || Number(visits[b].urgent)-Number(visits[a].urgent) || visits[a].deadline-visits[b].deadline
    || (visits[a].daysLeft??-1000)-(visits[b].daysLeft??-1000));
  let best=scoreOrder(data,p,visits,[]);
  for(const id of indices){
    const order=best.order;let next:ScoredRoute|undefined;
    for(let at=0;at<=order.length;at++){
      const trial=scoreOrder(data,p,visits,[...order.slice(0,at),id,...order.slice(at)]);
      if(!next||better(trial,next))next=trial;
    }
    best=next!;
  }
  if(hint && hint.length===indices.length && new Set(hint).size===indices.length && hint.every(i=>Number.isInteger(i)&&i>=0&&i<indices.length)){
    const extra=scoreOrder(data,p,visits,hint);
    if(better(extra,best))best=extra;
  }
  // Try relocating one stop at a time, including after the proposed AI order.
  for(let pass=0;pass<3;pass++){
    const initial=best;
    for(let i=0;i<initial.order.length;i++){
      const shortened=initial.order.filter((_,at)=>at!==i);
      for(let at=0;at<=shortened.length;at++){
        const trial=scoreOrder(data,p,visits,[...shortened.slice(0,at),initial.order[i],...shortened.slice(at)]);
        if(better(trial,best))best=trial;
      }
    }
    if(best===initial)break;
  }
  return best;
}
