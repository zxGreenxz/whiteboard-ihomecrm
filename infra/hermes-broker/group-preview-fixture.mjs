import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {setup} from './group-preview-sql-fixture.mjs';
import {ORG,USER,ACCOUNT,CONNECTION,SESSION,ASSISTANT,GENERATION,FOREIGN} from '../hermes-zalo-router/private-command-fixture.mjs';
import {createSupabaseGroupPreviewReads,createGroupPreviewAuthAdapter,createGroupPreviewDecisions} from './group-preview-adapter.mjs';
import {createGroupRoomPreviewService} from './group-room-preview.mjs';
import {createDurableAuthority} from './durable-authority.mjs';
import {createDurableConnectionStore} from './durable-connection-store.mjs';
import {createSessionCrypto} from './session-crypto.mjs';
import {createDependencyScope} from './dependency-scope.mjs';
import {createRoomReadService,createSupabaseRoomReads} from './room-read-service.mjs';
const hash=x=>createHash('sha256').update(x).digest('hex');
export const token='hc_'+'A'.repeat(43); const digest=hash(token);
const uid40='1'.repeat(40),code=c=>e=>e.code===c;

export async function setupMount(t,hooks={}) {
  const {f,baseline,body,SCOPE,BUILDING,ROOM,GROUP,CLAIM}=await setup(t);
  // Match the real public reader's SECURITY DEFINER boundary; its fixture table
  // remains unreadable directly by authenticated. This reader's facts are synthetic.
  await f.db.exec('ALTER FUNCTION public.copilot_available_rooms_v1(uuid) SECURITY DEFINER');
  const events=[];
  const crypto=createSessionCrypto({activeKeyVersion:'test',keys:new Map([['test',randomBytes(32)]])});t.after(()=>crypto.destroy());
  const expiresAt=(Math.floor(Date.now()/1000)+3600)*1000;
  // Deliberately unsigned synthetic bearer. It is parsed by the fixed transports,
  // but verified only by the explicit synthetic Auth port below: NOT real JWT proof.
  const accessToken=['header',Buffer.from(JSON.stringify({role:'authenticated',sub:USER,session_id:SESSION,exp:expiresAt/1000})).toString('base64url'),'signature'].join('.');
  const envelope=crypto.seal({accessToken,refreshToken:'SYNTHETIC_PRIVATE_REFRESH',expiresAt},{assistantId:ASSISTANT,userId:USER,organizationId:ORG,sessionId:SESSION});
  await f.db.query('UPDATE app_private.hermes_sessions SET envelope=$1::jsonb,expires_at=to_timestamp($2/1000.0)',[JSON.stringify(envelope),expiresAt]);
  await f.db.query('UPDATE app_private.hermes_connection_tokens SET token_digest=$1',[digest]);
  await f.db.query('UPDATE public.zalo_accounts SET zalo_uid=$1',[uid40]);
  await f.db.query('UPDATE app_private.hermes_zalo_ingress_sessions SET own_uid=$1',[uid40]);
  // Fixed path→SQL mapping, no echoed snapshots: output bodies below originate in
  // the real candidate SQL or the real room-map helper executed by PostgreSQL.
  const specs={
    hermes_group_action_context_v1:{keys:['p_organization_id'],sql:'SELECT public.hermes_group_action_context_v1($1::uuid) result'},
    hermes_group_directory_v1:{keys:['p'],sql:'SELECT public.hermes_group_directory_v1($1::jsonb) result'},
    hermes_group_preview_decision_v1:{keys:['p'],sql:'SELECT public.hermes_group_preview_decision_v1($1::jsonb) result'},
    hermes_room_scope_map_v1:{keys:['p_organization_id','p_scope_ids','p_connection_id','p_token_digest','p_expected_epoch','p_expected_policy_version','p_expected_membership_id','p_expected_authorization_version','p_expected_session_revision'],sql:'SELECT public.hermes_room_scope_map_v1($1::uuid,$2::uuid[],$3::uuid,$4::text,$5::bigint,$6::bigint,$7::uuid,$8::bigint,$9::bigint) result'},
    copilot_available_rooms_v1:{keys:['p_organization_id'],sql:'SELECT public.copilot_available_rooms_v1($1::uuid) result'},
  };
  let beforeDecision=null;
  async function fetch(url,options){
    if(hooks.beforeFetch) { const response=await hooks.beforeFetch(url,options); if(response)return response; }
    assert.equal(options.headers.authorization,'Bearer '+accessToken);
    assert.equal(options.headers.apikey,'sb_publishable_test');assert.equal(options.redirect,'error');
    const u=new URL(url);assert.equal(u.origin,'https://example.invalid');
    const name=u.pathname.slice('/rest/v1/rpc/'.length),spec=specs[name];assert(spec);
    const args=JSON.parse(options.body);assert.deepEqual(Object.keys(args).sort(),[...spec.keys].sort());
    if(name==='hermes_group_preview_decision_v1'&&beforeDecision){const hook=beforeDecision;beforeDecision=null;await hook();}
    events.push(name);
    await f.db.exec('SAVEPOINT joint_http; SET LOCAL ROLE authenticated');
    try{
      await f.db.query("SELECT set_config('request.jwt.claim.role','authenticated',true),set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.session',$2,true)",[USER,SESSION]);
      const result=(await f.db.query(spec.sql,spec.keys.map(k=>k==='p'?JSON.stringify(args[k]):args[k]))).rows[0].result;
      await f.db.exec('RESET ROLE; RELEASE SAVEPOINT joint_http');
      return Response.json(result);
    }catch(e){
      await f.db.exec('ROLLBACK TO SAVEPOINT joint_http; RELEASE SAVEPOINT joint_http; RESET ROLE');
      return Response.json({code:e.code,message:e.message},{status:e.code==='42501'?403:e.code==='PT409'?409:400});
    }
  }
  const scope=createDependencyScope();t.after(()=>scope.close());
  const config={url:'https://example.invalid/',publishableKey:'sb_publishable_test',dependencyScope:scope,fetch};
  const groupReads=createSupabaseGroupPreviewReads(config),roomReads=createSupabaseRoomReads(config);
  const baseAuth={
    async verifySession({accessToken:given}){assert.equal(given,accessToken);events.push('synthetic-auth');return{userId:USER,sessionId:SESSION,expiresAt};},
    async readAuthorization(){
      const a=(await f.db.query('SELECT * FROM public.fixture_authority')).rows[0];
      return {userId:USER,isSuperadmin:a.superadmin,activeOrganizationIds:[ORG],epoch:hash(JSON.stringify(a)),
        membership:{organizationId:ORG,status:'ACTIVE',revokedAt:null,validFrom:null,validTo:null,membershipId:USER,authorizationVersion:a.version},
        permissions:{read:a.rooms?['rooms.view']:[],action:[]},companyCeilings:{read:['rooms.view'],action:[]},
        scopesByPermission:{'rooms.view':{buildingIds:[BUILDING],cashbookIds:[]}}};
    }
  };
  const auth=createGroupPreviewAuthAdapter({baseAuth,reads:groupReads});
  const connectionStore=createDurableConnectionStore({transport:{async call(operation,payload){assert.equal(operation,'readConnection');events.push('real-store-read');return scope.track(()=>f.rpc('app_private.hermes_store_read_connection_v1',payload));}}});
  const authority=createDurableAuthority({connectionStore,crypto,auth});
  const create=()=>createGroupRoomPreviewService({
    roomReads:createRoomReadService({authority,connectionStore,crypto,auth,reads:roomReads}),
    decisions:createGroupPreviewDecisions({authority,connectionStore,crypto,auth,reads:groupReads,commandContext:{commandId:baseline.commandId,claimId:CLAIM}}),
  });
  const options={signal:new AbortController().signal},selection={roomIds:[ROOM],conversationIds:[GROUP]};
  return {f,baseline,body,SCOPE,BUILDING,ROOM,GROUP,CLAIM,scope,crypto,baseAuth,connectionStore,auth,authority,config,events,selection,
    identities:{connectionId:CONNECTION,assistantId:ASSISTANT,userId:USER,organizationId:ORG},
    async reset(){events.length=0;beforeDecision=null;await f.db.exec('UPDATE public.zalo_worker_lease SET heartbeat_at=clock_timestamp()');},
    beforeDecision(fn){beforeDecision=fn;}};
}
