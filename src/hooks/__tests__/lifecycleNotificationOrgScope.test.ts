import { beforeEach, expect, it, vi } from 'vitest';
const io = vi.hoisted(()=>({org:'11111111-1111-4111-8111-111111111111' as string|null,configs:[] as Array<{queryKey:unknown[];queryFn:()=>Promise<unknown>}>,filters:[] as string[]}));
vi.mock('@/contexts/OrganizationContext',()=>({useOrganization:()=>({selectedOrganizationId:io.org})}));
vi.mock('@/hooks/useAuth',()=>({useAuth:()=>({data:{id:'user'}})}));
vi.mock('sonner',()=>({toast:{error:vi.fn(),success:vi.fn(),info:vi.fn()}}));
vi.mock('@tanstack/react-query',()=>({useQuery:(config:{queryKey:unknown[];queryFn:()=>Promise<unknown>})=>{io.configs.push(config);return config;},useMutation:vi.fn(),useQueryClient:vi.fn()}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{from:()=>{
  const query: Record<string,unknown>={};
  for(const name of ['select','eq','order','limit']) query[name]=()=>query;
  query.or=(filter:string)=>{io.filters.push(filter);return query;};
  query.then=(resolve:(value:unknown)=>unknown)=>Promise.resolve({data:[],count:0,error:null}).then(resolve);
  return query;
}}}));
import { useNotifications, useRecentNotifications, useUnreadNotificationsCount } from '../useNotifications';

// Bộ đánh giá tối thiểu cho đúng phần cú pháp PostgREST `or=` mà hook dùng
// (điều kiện `cột.eq|neq|is.giá trị`, nhóm `and(...)`), để kiểm DÒNG NÀO lọt qua
// chứ không chỉ so chuỗi. `neq` theo ngữ nghĩa NULL của SQL: NULL <> x không đúng.
type Row = { organization_id: string; event: string | null };
function splitTop(list: string): string[] {
  const out: string[] = []; let depth = 0; let cur = '';
  for (const ch of list) {
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    cur += ch;
  }
  return [...out, cur];
}
function holds(cond: string, row: Row): boolean {
  if (cond.startsWith('and(')) return splitTop(cond.slice(4, -1)).every(part => holds(part, row));
  const [column, op, ...rest] = cond.split('.');
  const value = rest.join('.');
  const actual = column === 'metadata->>event' ? row.event : column === 'organization_id' ? row.organization_id : undefined;
  if (op === 'is') return value === 'null' && actual === null;
  if (actual === null || actual === undefined) return false;
  if (op === 'eq') return actual === value;
  if (op === 'neq') return actual !== value;
  throw new Error(`toán tử chưa hỗ trợ: ${op}`);
}
const passes = (filter: string, row: Row) => splitTop(filter).some(cond => holds(cond, row));
const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '11111111-1111-4111-8111-111111111112';
const rows: Array<Row & { id: string }> = [
  { id: 'A-thuong', organization_id: ORG_A, event: null },
  { id: 'A-khac', organization_id: ORG_A, event: 'APPROVAL' },
  { id: 'A-lifecycle', organization_id: ORG_A, event: 'LIFECYCLE' },
  { id: 'B-thuong', organization_id: ORG_B, event: null },
  { id: 'B-khac', organization_id: ORG_B, event: 'APPROVAL' },
  { id: 'B-lifecycle', organization_id: ORG_B, event: 'LIFECYCLE' },
];

beforeEach(()=>{io.configs=[];io.filters=[];io.org=ORG_A;});
it('đã chốt công ty: cả 3 đường đọc chỉ hiện thông báo của công ty đó (kể cả thông báo thường), cache key tách theo công ty',async()=>{
  useNotifications(); useRecentNotifications(); useUnreadNotificationsCount();
  const initial=io.configs.map(config=>config.queryKey);
  for(const config of io.configs) await config.queryFn();
  expect(io.filters).toHaveLength(3);
  // Trước đây: lọt cả B-thuong, B-khac (thông báo thường của công ty KHÁC).
  for(const filter of io.filters) expect(rows.filter(row=>passes(filter,row)).map(row=>row.id)).toEqual(['A-thuong','A-khac','A-lifecycle']);
  io.org=ORG_B; io.configs=[]; io.filters=[];
  useNotifications(); useRecentNotifications(); useUnreadNotificationsCount();
  for(let i=0;i<3;i++) expect(io.configs[i].queryKey).not.toEqual(initial[i]);
  for(const config of io.configs) await config.queryFn();
  for(const filter of io.filters) expect(rows.filter(row=>passes(filter,row)).map(row=>row.id)).toEqual(['B-thuong','B-khac','B-lifecycle']);
});
it('chưa chốt công ty: giữ hành vi cũ — chỉ ẩn LIFECYCLE, thông báo thường và dòng không có event vẫn hiện',async()=>{
  io.org=null; useNotifications();
  await io.configs[0].queryFn();
  expect(io.filters).toEqual(['metadata->>event.neq.LIFECYCLE,metadata->>event.is.null']);
  expect(rows.filter(row=>passes(io.filters[0],row)).map(row=>row.id)).toEqual(['A-thuong','A-khac','B-thuong','B-khac']);
});
