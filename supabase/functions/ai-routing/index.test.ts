import { manage } from './index.ts';
import { probe } from './probe.ts';
import { catalogModels, endpoint, routePair } from '../_shared/ai-routing.ts';
import { CRM_AI_VPS, OWNER_NOUS_BASE, viaHermesVps } from '../_shared/hermes-vps.ts';

const equal = (a: unknown,b: unknown) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw Error(JSON.stringify([a,b])); };
const nus = { id: 'openai/gpt-6-luna', billing_mode: 'subscription', architecture: { input_modalities: ['text','image'], output_modalities: ['text'] }, supported_parameters: ['response_format'] };
const cx = { id: 'cx/gpt-6-luna[1m]', owned_by: 'cx', capabilities: { vision: true } };
const ag = { id: 'ag/gemini', owned_by: 'ag', capabilities: { vision: true } };
Deno.test('only the authenticated owner receives the personal Nous connector', async () => {
  const owner = '11111111-1111-4111-8111-111111111111';
  const values: Record<string, string> = { CRM_AI_OWNER_ID: owner, CRM_AI_VPS_KEY: 'gateway', CRM_AI_OWNER_CONNECTOR_KEY: 'private' };
  const env = (k: string) => values[k];
  equal(endpoint('nous', env), null);
  equal(endpoint('nous', env, 'different'), null);
  equal(endpoint('nous', env, owner), { base: OWNER_NOUS_BASE, key: 'private' });
  values.AI_NOUS_API_KEY = 'shared';
  equal(endpoint('nous', env, owner), endpoint('nous', env, 'different'));
  const unknown = viaHermesVps('9router', env, () => { throw Error('unexpected_fetch'); });
  const error = await unknown('https://other.invalid/v1/models').then(() => '', e => e.message);
  equal(error, 'invalid_ai_destination');
  for (const [provider, base, op, path] of [['nous', OWNER_NOUS_BASE, '/models', 'nous-owner'],
    ['9router', 'https://ai.chillhome.io.vn/v1', '/chat/completions', '9router']]) {
    const forward = viaHermesVps(provider, env, (input, init) => {
      equal(String(input), CRM_AI_VPS + '/' + path + op);
      equal(new Headers(init?.headers).get('X-CRM-AI-Key'), 'gateway');
      equal(init?.redirect, 'error');
      return Promise.resolve(new Response());
    });
    await forward(base + op);
  }
});
const configuration = { routes: [{ provider: 'nous', model: nus.id }, { provider: '9router', model: cx.id }], app: 'quick_read', revision: 2, action: 'save' };
const env = (k: string) => ({ SUPABASE_URL: 'https://crm.invalid', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service', AI_NOUS_API_KEY: 'shared', QUICK_ENTRY_NINEROUTER_BASE_URL: 'https://nine.invalid/v1', QUICK_ENTRY_NINEROUTER_KEY: 'nine' })[k];
function fixture(body: unknown, role: boolean, conflict = false) {
  const stored: unknown[] = [], calls: string[] = [];
  const send: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith('/is_super_admin')) { equal(new Headers(init?.headers).get('Authorization'), 'Bearer user'); return Response.json(role); }
    if (url.endsWith('/models')) return Response.json({ data: url.includes('nine.invalid') ? [cx,ag] : [{ ...nus, billing_mode: 'credits' }] });
    if (url.includes('/ai_route_catalogs?on_conflict')) { stored.push(JSON.parse(String(init?.body))); return new Response(null,{ status:201 }); }
    if (url.endsWith('&provider=eq.9router')) return Response.json([]);
    if (url.includes('/ai_route_catalogs?select')) return Response.json([
      { provider:'nous', models:catalogModels('nous',{data:[nus]}).map(m => ({...m,verified:true})) }, { provider:'9router',models:catalogModels('9router',{data:[cx,ag]}).map(m => ({...m, verified:m.id === cx.id})) }]);
    if (init?.method === 'PATCH') { equal(url.endsWith('app=eq.quick_read&revision=eq.2'), true); stored.push(JSON.parse(String(init.body))); return Response.json(conflict ? [] : [{}]); }
    if (url.includes('/ai_application_routes?select')) return Response.json([]);
    throw Error(url);
  };
  const res = manage(new Request('https://crm.invalid/functions/v1/ai-routing', { method:'POST', headers:{ Authorization:'Bearer user' }, body:JSON.stringify(body) }),env,send);
  return { res, calls, stored };
}

Deno.test('Only the subscription-marked OpenAI catalog and the two matching 9router connector namespaces are eligible', () => {
  equal(catalogModels('nous',{ data:[nus,{...nus,id:'openai/x:batch'}, {...nus,id:'gemini/x'},{...nus,id:'openai/paid',billing_mode:'credits'}, {id:'openai/public'}] }).map(m=>[m.id,m.vision]), [[nus.id,true],['openai/x:batch',false]]);
  equal(catalogModels('9router',{ data:[cx,ag,{...cx,owned_by:'ag'}, {...ag,id:'oc/x'},{...ag,id:'ag/image',capabilities:{vision:true,imageOutput:true}}] }).map(m=>[m.id,m.vision]), [[ag.id,true],['ag/image',false],[cx.id,true]]);
  equal(routePair(configuration.routes),true);
  equal(routePair([configuration.routes[0],{provider:'9router',model:'oc/paid'}]),false);
  equal(routePair([configuration.routes[0],configuration.routes[0]]),false);
});
Deno.test('A model timeout or invalid payload does not block subsequent probes, but an account limit pauses this source',async () => {
  const target = { base:'https://fixture.invalid',key:'fixture' };
  const model = catalogModels('9router',{data:[cx]})[0];
  for (const send of [async () => {throw new Error('timeout');}, async () => new Response('bad json'), async () => Response.json({choices:[null]})]) {
    equal(await probe('9router',target,model,send),{passed:false,stop:false});
  }
  equal(await probe('9router',target,model,async () => new Response(null,{status:429})),{passed:false,stop:true});
});

Deno.test('Denied callers never contact service stores or model providers',async () => {
  const f=fixture(configuration,false); equal((await f.res).status,403); equal(f.calls.length,1);
});
Deno.test('A failed subscription sync preserves its snapshot, while updating the available router',async () => {
  const f=fixture({action:'sync'},true); const response=await f.res; equal(response.status,200);
  equal((await response.json()).syncErrors,['nous']); equal(f.stored.length,1);
  equal((f.stored[0] as {provider:string}).provider,'9router');
});
Deno.test('Revision conflicts and incompatible or unlisted models cannot overwrite working routes',async () => {
  equal((await fixture(configuration,true,true).res).status,409);
  equal((await fixture(configuration,true).res).status,200);
  for (const bad of [{...configuration,app:'quick_stt'}, {...configuration,routes:[configuration.routes[0],{provider:'9router',model:ag.id}]},
    {...configuration,routes:[{provider:'nous',model:'openai/credits'},configuration.routes[1]]}]) {
    const f=fixture(bad,true); equal((await f.res).status,422); equal(f.stored,[]);
  }
});
