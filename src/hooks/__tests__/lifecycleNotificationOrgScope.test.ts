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
beforeEach(()=>{io.configs=[];io.filters=[];io.org='11111111-1111-4111-8111-111111111111';});
it('all inbox readers and unread count scope only lifecycle rows to selected org, with separate cache keys',async()=>{
  useNotifications(); useRecentNotifications(); useUnreadNotificationsCount();
  const initial=io.configs.map(config=>config.queryKey);
  for(const config of io.configs) await config.queryFn();
  expect(io.filters).toHaveLength(3);
  for(const filter of io.filters){
    expect(filter).toContain('metadata->>event.neq.LIFECYCLE');
    expect(filter).toContain('metadata->>event.is.null');
    expect(filter).toContain(`and(metadata->>event.eq.LIFECYCLE,organization_id.eq.${io.org})`);
  }
  io.org='11111111-1111-4111-8111-111111111112'; io.configs=[]; io.filters=[];
  useNotifications(); useRecentNotifications(); useUnreadNotificationsCount();
  for(let i=0;i<3;i++) expect(io.configs[i].queryKey).not.toEqual(initial[i]);
  for(const config of io.configs) await config.queryFn();
  expect(io.filters.every(filter=>filter.includes(io.org!))).toBe(true);
});
it('unresolved selected org excludes lifecycle only and preserves legacy/null-event notifications',async()=>{
  io.org=null; useNotifications();
  await io.configs[0].queryFn();
  expect(io.filters).toEqual(['metadata->>event.neq.LIFECYCLE,metadata->>event.is.null']);
});
