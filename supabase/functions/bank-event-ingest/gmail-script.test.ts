// Chạy đúng script Apps Script CRM sinh ra trên Google giả lập (Gmail, hẹn giờ, đồng hồ), rồi đưa mọi tin nó gửi
// qua handler ingest thật: script và máy chủ không thể lệch hợp đồng mà test vẫn xanh.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createHandler} from './index.ts';
import {decryptPayload,JsonObject} from '../_shared/bank-events.ts';
import {buildGmailScript,gmailSearchQuery} from '../../../src/lib/bank-events/gmailScript.ts';

const token='f'.repeat(64),url='https://example.test/functions/v1/bank-event-ingest';
const env=(name:string)=>({BANK_EVENT_KEY_ID:'v1',BANK_EVENT_ENCRYPTION_KEYS:JSON.stringify({v1:btoa('x'.repeat(32))})})[name];
const VN=7*3600_000;
const vn=(text:string)=>Date.parse(`${text}+07:00`);
interface Sent {url:string;headers:Record<string,string>;contentType:string;body:Uint8Array<ArrayBuffer>}
interface Mail {id:string;date:number;from:string;subject:string;body:string}

function google(options:{now:number;mails?:Mail[];status?:number[];elapsed?:number}) {
  const clock={now:options.now},mails=options.mails??[],status=[...(options.status??[])],sent:Sent[]=[],queries:string[]=[];
  const properties:Record<string,string>={};let triggers:{handler:string;minutes?:number;at?:number}[]=[];
  class FakeDate extends Date {
    constructor(...args:unknown[]) { if(args.length)super(args[0] as number);else super(clock.now); }
    static override now() { const value=clock.now;clock.now+=options.elapsed??0;return value; }
  }
  const message=(mail:Mail)=>({getId:()=>mail.id,getDate:()=>new Date(mail.date),getFrom:()=>mail.from,getSubject:()=>mail.subject,getPlainBody:()=>mail.body});
  const services={
    Date:FakeDate,console:{warn(){}},
    GmailApp:{
      search(query:string,start:number,max:number){queries.push(query);assert.equal(start,0);assert.equal(max,50);
        const after=Number(/after:(\d+)$/.exec(query)?.[1])*1000;return mails.filter(mail=>mail.date>=after).map(mail=>[message(mail)]);},
      getMessagesForThreads:(threads:unknown[])=>threads,
    },
    UrlFetchApp:{fetch(target:string,init:{headers:Record<string,string>;contentType:string;payload:Uint8Array<ArrayBuffer>;muteHttpExceptions:boolean;followRedirects:boolean}){
      assert.equal(init.muteHttpExceptions,true);assert.equal(init.followRedirects,false);
      sent.push({url:target,headers:init.headers,contentType:init.contentType,body:init.payload});
      const code=status.length?status.shift()!:201;return {getResponseCode:()=>code};
    }},
    PropertiesService:{getScriptProperties:()=>({
      getProperty:(key:string)=>properties[key]??null,setProperty:(key:string,value:string)=>{properties[key]=value;},
      deleteProperty:(key:string)=>{delete properties[key];},getProperties:()=>({...properties}),
      setProperties:(values:Record<string,string>)=>{for(const [key,value] of Object.entries(values))properties[key]=String(value);},
      deleteAllProperties:()=>{for(const key of Object.keys(properties))delete properties[key];},
    })},
    ScriptApp:{
      getProjectTriggers:()=>triggers.map(trigger=>({...trigger,getHandlerFunction:()=>trigger.handler})),
      deleteTrigger:(trigger:{handler:string;minutes?:number;at?:number})=>{triggers=triggers.filter(item=>item.handler!==trigger.handler||item.minutes!==trigger.minutes||item.at!==trigger.at);},
      newTrigger:(handler:string)=>({timeBased:()=>({
        everyMinutes:(minutes:number)=>{assert.ok([1,5,10,15,30].includes(minutes));return {create:()=>{triggers.push({handler,minutes});}};},
        at:(date:Date)=>({create:()=>{triggers.push({handler,at:date.getTime()});}}),
      })}),
    },
    LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock(){}})},
    Utilities:{
      getUuid:()=>'30000000-0000-4000-8000-000000000001',DigestAlgorithm:{SHA_256:'sha256'},Charset:{UTF_8:'utf8'},
      computeDigest:(_algorithm:string,value:string)=>Array.from(createHash('sha256').update(value,'utf8').digest(),byte=>byte>127?byte-256:byte),
      newBlob:()=>({setDataFromString:(value:string,charset:string)=>{assert.equal(charset,'UTF-8');return {getBytes:()=>new TextEncoder().encode(value)};}}),
    },
  };
  const names=Object.keys(services);
  const script=buildGmailScript({ingestUrl:url,token,label:'CRM Ngân hàng',includeBanks:true});
  const api=new Function(...names,`${script}\nreturn {caiDat:caiDat,quetGmail:quetGmail,goCaiDat:goCaiDat};`)(...Object.values(services)) as Record<'caiDat'|'quetGmail'|'goCaiDat',()=>void>;
  return {api,clock,sent,queries,properties,mails,status,get triggers(){return triggers;}};
}
const mail=(id:string,date:number,body='Tài khoản: xxxx5847\nGhi có +1,000,000 VND\nNGUYEN VAN A CHUYEN TIEN'):Mail=>({id,date,from:'"ACB" <mailalert@acb.com.vn>',subject:'Thông báo biến động số dư',body});

async function deliver(sent:Sent):Promise<{status:number;args:JsonObject}> {
  let args:JsonObject={};
  const handler=createHandler({env,rpc:async(_name,input)=>{args=input;const heartbeat=input.p_event_type==='gateway.heartbeat';
    return {data:{status:heartbeat?'heartbeat':'accepted',sourceId:'10000000-0000-4000-8000-000000000001',eventId:heartbeat?null:'20000000-0000-4000-8000-000000000001',externalId:input.p_external_id,acceptedAt:'2026-10-09T03:00:00Z'},error:null};}});
  const response=await handler(new Request(sent.url,{method:'POST',headers:{...sent.headers,'content-type':sent.contentType},body:sent.body}));
  return {status:response.status,args};
}

Deno.test('installed script sends bank emails and a gmail heartbeat the real ingest accepts',async()=>{
  const now=vn('2026-10-09T10:00:00');
  const g=google({now,mails:[mail('m-1',now-3600_000),mail('m-2',now-60_000),mail('m-old',now-3*86400_000)]});
  g.api.caiDat();
  assert.match(g.queries[0],/^\(from:\(acb\.com\.vn OR .*\) OR label:crm-ngân-hàng\) after:\d+$/);
  assert.deepEqual(g.triggers,[{handler:'quetGmail',minutes:1}]);
  assert.equal(g.sent.length,3);
  const [first,second,heartbeat]=await Promise.all(g.sent.map(deliver));
  assert.equal(first.status,201);assert.equal(second.status,201);assert.equal(heartbeat.status,200);
  assert.equal(first.args.p_event_type,'email.received');
  assert.equal(g.sent[0].headers.Authorization,`Bearer ${token}`);
  const payload=await decryptPayload(env,{event:{externalId:first.args.p_external_id,deviceId:first.args.p_device_id},keyId:first.args.p_key_id,nonce:first.args.p_nonce,ciphertext:first.args.p_ciphertext,payloadHash:first.args.p_payload_hash}) as JsonObject;
  assert.equal(payload.from,'"ACB" <mailalert@acb.com.vn>');assert.match(String(payload.body),/Ghi có \+1,000,000 VND/);
  assert.deepEqual(heartbeat.args.p_heartbeat,{channel:'gmail',appVersion:'gmail-script-1',schedule:'day-1m',usedSecondsToday:0,receivedAt:new Date(now).toISOString()});
  // Lần quét sau không gửi lại thư đã nhận, không báo sống lại trong 10 phút.
  g.clock.now=now+60_000;g.api.quetGmail();assert.equal(g.sent.length,3);
  g.mails.push(mail('m-3',now+90_000));g.clock.now=now+120_000;g.api.quetGmail();
  assert.equal(g.sent.length,4);assert.equal((await deliver(g.sent[3])).status,201);
});

Deno.test('night window runs every 10 minutes with an exact 06:30 return; heavy days fall back to 5 minutes',async()=>{
  const g=google({now:vn('2026-10-09T23:59:00')});g.api.caiDat();
  assert.deepEqual(g.triggers,[{handler:'quetGmail',minutes:1}]);
  g.clock.now=vn('2026-10-10T00:30:00');g.api.quetGmail();
  assert.deepEqual(g.triggers,[{handler:'quetGmail',minutes:10},{handler:'quetGmail',at:vn('2026-10-10T06:30:00')}]);
  g.clock.now=vn('2026-10-10T06:30:00');g.api.quetGmail();
  assert.deepEqual(g.triggers,[{handler:'quetGmail',minutes:1}]);
  const heavy=google({now:vn('2026-10-09T15:00:00'),elapsed:0});heavy.api.caiDat();
  heavy.properties.thoiGian=JSON.stringify({ngay:'2026-10-09',giay:3600});
  heavy.api.quetGmail();assert.deepEqual(heavy.triggers,[{handler:'quetGmail',minutes:5}]);
  const beat=heavy.sent.at(-1)!;const delivered=await deliver(beat);
  assert.equal(delivered.status,200);assert.equal((delivered.args.p_heartbeat as JsonObject).schedule,'saver-5m');
  heavy.clock.now=vn('2026-10-10T08:00:00');heavy.api.quetGmail();assert.deepEqual(heavy.triggers,[{handler:'quetGmail',minutes:1}]);
  heavy.api.goCaiDat();assert.deepEqual(heavy.triggers,[]);assert.deepEqual(heavy.properties,{});
});

Deno.test('temporary CRM failures keep the cursor and retry; revoked keys stop loudly without losing state',async()=>{
  const now=vn('2026-10-09T10:00:00');
  const g=google({now,mails:[mail('m-1',now-60_000),mail('m-2',now-30_000)],status:[201,503]});
  g.api.caiDat();
  assert.equal(g.sent.length,3);// m-1 nhận, m-2 lỗi tạm thời, rồi báo sống
  const cursor=g.properties.conTro;
  g.clock.now=now+60_000;g.api.quetGmail();
  assert.equal(g.sent.length,4);assert.equal(JSON.parse(new TextDecoder().decode(g.sent[3].body)).id,JSON.parse(new TextDecoder().decode(g.sent[1].body)).id);
  assert.notEqual(g.properties.conTro,cursor);
  g.mails.push(mail('m-3',now+90_000));g.status.push(401);g.clock.now=now+120_000;
  assert.throws(()=>g.api.quetGmail(),/CRM từ chối khóa kết nối/);
  assert.ok(g.properties.daGui.includes('m-2'));assert.equal(g.properties.daGui.includes('m-3'),false);
});

Deno.test('long or malformed email text is cut to the accepted UTF-8 size and stays well formed',async()=>{
  const now=vn('2026-10-09T10:00:00');
  const g=google({now,mails:[mail('m-big',now-60_000,'Ghi có +5,000 VND\n'+'Nội dung dài 😊 '.repeat(2000)+'\ud800')]});
  g.api.caiDat();
  const body=JSON.parse(new TextDecoder().decode(g.sent[0].body)).body as string;
  assert.ok(new TextEncoder().encode(body).length<=8192);assert.ok(body.isWellFormed());
  assert.equal((await deliver(g.sent[0])).status,201);
});

Deno.test('search query requires a source of mail and rejects unsafe labels',()=>{
  assert.equal(gmailSearchQuery({label:'',includeBanks:false}),null);
  assert.equal(gmailSearchQuery({label:'crm" OR in:anywhere',includeBanks:true}),null);
  assert.equal(gmailSearchQuery({label:'Ngân hàng/ACB',includeBanks:false}),'label:ngân-hàng-acb');
  assert.throws(()=>buildGmailScript({ingestUrl:'http://insecure.test',token,label:'',includeBanks:true}),/HTTPS/);
});
