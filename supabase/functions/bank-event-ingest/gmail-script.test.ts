// Chạy đúng script Apps Script CRM sinh ra trên Google giả lập (Gmail phân trang mới-nhất-trước, ô nhớ 9 KB ghi gộp,
// trigger, đồng hồ), rồi đưa mọi tin nó gửi qua handler ingest thật: script và máy chủ không lệch hợp đồng mà test vẫn xanh.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createHandler} from './index.ts';
import {decryptPayload,JsonObject} from '../_shared/bank-events.ts';
import {buildGmailScript,gmailSearchQuery} from '../../../src/lib/bank-events/gmailScript.ts';

const token='f'.repeat(64),url='https://example.test/functions/v1/bank-event-ingest';
const env=(name:string)=>({BANK_EVENT_KEY_ID:'v1',BANK_EVENT_ENCRYPTION_KEYS:JSON.stringify({v1:btoa('x'.repeat(32))})})[name];
const vn=(text:string)=>Date.parse(`${text}+07:00`);
interface Sent {url:string;headers:Record<string,string>;contentType:string;body:Uint8Array<ArrayBuffer>;json:JsonObject}
/** date: giờ ghi trên thư (getDate); arrival: giờ Gmail nhận (after: lọc theo giờ này); thread: gom nhiều thư một luồng. */
interface Mail {id:string;date:number;arrival?:number;thread?:string;from:string;subject:string;body:string}
interface Trigger {id:number;handler:string;minutes?:number;at?:number;getHandlerFunction:()=>string}
const MAX_PROPERTY_BYTES=9*1024;

function google(options:{now:number;mails?:Mail[];elapsed?:number;respond?:(json:JsonObject)=>number}) {
  const clock={now:options.now},mails=options.mails??[],sent:Sent[]=[],queries:string[]=[];
  const properties:Record<string,string>={};let triggers:Trigger[]=[],nextTrigger=1;
  const control={failCreate:false,respond:options.respond??(()=>201)};
  class FakeDate extends Date {
    constructor(...args:unknown[]) { if(args.length)super(args[0] as number);else super(clock.now); }
    static override now() { const value=clock.now;clock.now+=options.elapsed??0;return value; }
  }
  const arrival=(mail:Mail)=>mail.arrival??mail.date;
  const message=(mail:Mail)=>({getId:()=>mail.id,getDate:()=>new Date(mail.date),getFrom:()=>mail.from,getSubject:()=>mail.subject,getPlainBody:()=>mail.body});
  const put=(key:string,value:string)=>{
    if(new TextEncoder().encode(value).length>MAX_PROPERTY_BYTES)throw new Error(`Argument too large: ${key}`);
    properties[key]=value;
  };
  const createTrigger=(trigger:{handler:string;minutes?:number;at?:number})=>({create:()=>{
    if(control.failCreate)throw new Error('Service invoked too many times');
    triggers.push({...trigger,id:nextTrigger++,getHandlerFunction:()=>trigger.handler});
  }});
  const services={
    Date:FakeDate,console:{warn(){}},
    GmailApp:{
      search(query:string,start:number,max:number){
        queries.push(query);const after=Number(/after:(\d+)$/.exec(query)?.[1])*1000;
        const threads=new Map<string,Mail[]>();
        for(const item of mails)threads.set(item.thread??item.id,[...(threads.get(item.thread??item.id)??[]),item]);
        const latest=(thread:Mail[])=>Math.max(...thread.map(arrival));
        return [...threads.values()].filter(thread=>thread.some(item=>arrival(item)>=after))
          .sort((a,b)=>latest(b)-latest(a)).slice(start,start+max).map(thread=>thread.map(message));
      },
      getMessagesForThreads:(threads:unknown[])=>threads,
    },
    UrlFetchApp:{fetch(target:string,init:{headers:Record<string,string>;contentType:string;payload:Uint8Array<ArrayBuffer>;muteHttpExceptions:boolean;followRedirects:boolean}){
      assert.equal(init.muteHttpExceptions,true);assert.equal(init.followRedirects,false);
      const json=JSON.parse(new TextDecoder().decode(init.payload)) as JsonObject;
      sent.push({url:target,headers:init.headers,contentType:init.contentType,body:init.payload,json});
      const code=control.respond(json);return {getResponseCode:()=>code};
    }},
    PropertiesService:{getScriptProperties:()=>({
      getProperty:(key:string)=>properties[key]??null,setProperty:put,
      deleteProperty:(key:string)=>{delete properties[key];},getProperties:()=>({...properties}),
      setProperties:(values:Record<string,string>)=>{for(const [key,value] of Object.entries(values))put(key,String(value));},
      deleteAllProperties:()=>{for(const key of Object.keys(properties))delete properties[key];},
    })},
    ScriptApp:{
      getProjectTriggers:()=>[...triggers],
      deleteTrigger:(trigger:Trigger)=>{triggers=triggers.filter(item=>item.id!==trigger.id);},
      newTrigger:(handler:string)=>({timeBased:()=>({
        everyMinutes:(minutes:number)=>{assert.ok([1,5,10,15,30].includes(minutes));return createTrigger({handler,minutes});},
        at:(date:Date)=>createTrigger({handler,at:date.getTime()}),
      })}),
    },
    LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock(){}})},
    Utilities:{
      getUuid:()=>'30000000-0000-4000-8000-000000000001',DigestAlgorithm:{SHA_256:'sha256'},Charset:{UTF_8:'utf8'},
      computeDigest:(_algorithm:string,value:string)=>Array.from(createHash('sha256').update(value,'utf8').digest(),byte=>byte>127?byte-256:byte),
      newBlob:()=>({setDataFromString:(value:string,charset:string)=>{assert.equal(charset,'UTF-8');return {getBytes:()=>new TextEncoder().encode(value)};}}),
    },
  };
  const script=buildGmailScript({ingestUrl:url,token,label:'CRM Ngân hàng',includeBanks:true});
  const api=new Function(...Object.keys(services),`${script}\nreturn {caiDat:caiDat,quetGmail:quetGmail,goCaiDat:goCaiDat};`)(...Object.values(services)) as Record<'caiDat'|'quetGmail'|'goCaiDat',()=>void>;
  const emails=()=>sent.filter(item=>item.json.event==='email.received');
  const beats=()=>sent.filter(item=>item.json.event==='gateway.heartbeat');
  const shape=()=>triggers.map(({handler,minutes,at})=>at===undefined?{handler,minutes}:{handler,at});
  return {api,clock,sent,emails,beats,queries,properties,mails,control,shape};
}
const mail=(id:string,date:number,extra:Partial<Mail>={}):Mail=>({id,date,from:'"ACB" <mailalert@acb.com.vn>',subject:'Thông báo biến động số dư',body:'Tài khoản: xxxx5847\nGhi có +1,000,000 VND\nNGUYEN VAN A CHUYEN TIEN',...extra});
const emailId=(item:Sent)=>String(item.json.id);
const idOf=(mailId:string)=>createHash('sha256').update(`gmail:${mailId}`).digest('hex');

async function deliver(sent:Sent):Promise<{status:number;args:JsonObject}> {
  let args:JsonObject={};
  const handler=createHandler({env,rpc:async(_name,input)=>{args=input;const heartbeat=input.p_event_type==='gateway.heartbeat';
    return {data:{status:heartbeat?'heartbeat':'accepted',sourceId:'10000000-0000-4000-8000-000000000001',eventId:heartbeat?null:'20000000-0000-4000-8000-000000000001',externalId:input.p_external_id,acceptedAt:'2026-10-09T03:00:00Z'},error:null};}});
  const response=await handler(new Request(sent.url,{method:'POST',headers:{...sent.headers,'content-type':sent.contentType},body:sent.body}));
  return {status:response.status,args};
}

Deno.test('installed script sends bank emails (threads, late arrivals) and a heartbeat the real ingest accepts',async()=>{
  const now=vn('2026-10-09T10:00:00');
  const g=google({now,mails:[
    mail('m-1',now-3600_000),mail('m-2',now-60_000),mail('m-old',now-3*86400_000),
    mail('t-old',now-3*86400_000,{thread:'t'}),mail('t-new',now-120_000,{thread:'t'}),
    mail('m-late',now-2*3600_000,{arrival:now-30_000}),
  ]});
  g.api.caiDat();
  assert.match(g.queries[0],/^\(from:\(acb\.com\.vn OR .*\) OR label:crm-ngân-hàng\) after:\d+$/);
  assert.deepEqual(g.shape(),[{handler:'quetGmail',minutes:1}]);
  assert.deepEqual(g.emails().map(emailId),['m-late','m-1','t-new','m-2'].map(idOf));
  for(const item of g.sent)assert.equal((await deliver(item)).status,item.json.event==='email.received'?201:200);
  const first=await deliver(g.emails()[1]);
  const payload=await decryptPayload(env,{event:{externalId:first.args.p_external_id,deviceId:first.args.p_device_id},keyId:first.args.p_key_id,nonce:first.args.p_nonce,ciphertext:first.args.p_ciphertext,payloadHash:first.args.p_payload_hash}) as JsonObject;
  assert.equal(payload.from,'"ACB" <mailalert@acb.com.vn>');assert.match(String(payload.body),/Ghi có \+1,000,000 VND/);
  assert.equal(g.sent[0].headers.Authorization,`Bearer ${token}`);
  assert.deepEqual((await deliver(g.beats()[0])).args.p_heartbeat,{channel:'gmail',appVersion:'gmail-script-1',schedule:'day-1m',usedSecondsToday:0,receivedAt:new Date(now).toISOString()});
  // Lần quét sau không gửi lại thư đã nhận, không báo sống lại trong 10 phút; thư mới thì gửi đúng một lần.
  g.clock.now=now+60_000;g.api.quetGmail();assert.equal(g.sent.length,5);
  g.mails.push(mail('m-3',now+90_000));g.clock.now=now+120_000;g.api.quetGmail();
  assert.deepEqual(g.emails().map(emailId).slice(4),[idOf('m-3')]);
});

Deno.test('a 24-hour backlog of 320 emails is paged, sent exactly once within the 4-minute budget and the 9 KB property limit',()=>{
  const now=vn('2026-10-09T10:00:00');
  const mails=Array.from({length:320},(_,i)=>mail(`b-${String(i).padStart(3,'0')}`,now-23*3600_000+i*250_000));
  const g=google({now,mails,elapsed:1500});
  g.api.caiDat();
  const firstRun=g.emails().length;assert.ok(firstRun>0&&firstRun<320,`lượt đầu phải dừng vì ngân sách thời gian, gửi ${firstRun}`);
  for(let run=0;run<30&&g.emails().length<320;run++){g.clock.now+=60_000;g.api.quetGmail();}
  const ids=g.emails().map(emailId);
  assert.equal(ids.length,320);assert.equal(new Set(ids).size,320);
  assert.deepEqual([...ids].sort(),mails.map(item=>idOf(item.id)).sort());
  assert.ok(Number(g.properties.conTro)>=now,'con trỏ phải tiến tới hiện tại khi đã gửi hết');
  for(const value of Object.values(g.properties))assert.ok(new TextEncoder().encode(value).length<=MAX_PROPERTY_BYTES);
});

Deno.test('a dense burst (600 emails in 2 hours, real-length Gmail ids) still fits the per-property limit',()=>{
  const now=vn('2026-10-09T10:00:00');
  const mails=Array.from({length:600},(_,i)=>mail((0x18b2f3c4d5e60000n+BigInt(i*7919)).toString(16),now-2*3600_000+i*12_000));
  const g=google({now,mails});
  g.api.caiDat();
  assert.equal(new Set(g.emails().map(emailId)).size,600);assert.equal(g.emails().length,600);
  for(const value of Object.values(g.properties))assert.ok(new TextEncoder().encode(value).length<=MAX_PROPERTY_BYTES);
  g.clock.now=now+60_000;g.api.quetGmail();assert.equal(g.emails().length,600);
});

Deno.test('night window runs every 10 minutes with an exact 06:30 return; heavy days fall back to 5 minutes',async()=>{
  const g=google({now:vn('2026-10-09T23:59:00')});g.api.caiDat();
  assert.deepEqual(g.shape(),[{handler:'quetGmail',minutes:1}]);
  g.clock.now=vn('2026-10-10T00:30:00');g.api.quetGmail();
  assert.deepEqual(g.shape(),[{handler:'quetGmail',minutes:10},{handler:'quetGmail',at:vn('2026-10-10T06:30:00')}]);
  g.clock.now=vn('2026-10-10T06:30:00');g.api.quetGmail();
  assert.deepEqual(g.shape(),[{handler:'quetGmail',minutes:1}]);
  const heavy=google({now:vn('2026-10-09T15:00:00')});heavy.api.caiDat();
  heavy.properties.thoiGian=JSON.stringify({ngay:'2026-10-09',giay:3600});
  heavy.api.quetGmail();assert.deepEqual(heavy.shape(),[{handler:'quetGmail',minutes:5}]);
  const delivered=await deliver(heavy.beats().at(-1)!);
  assert.equal(delivered.status,200);assert.equal((delivered.args.p_heartbeat as JsonObject).schedule,'saver-5m');
  heavy.clock.now=vn('2026-10-10T08:00:00');heavy.api.quetGmail();assert.deepEqual(heavy.shape(),[{handler:'quetGmail',minutes:1}]);
  // Gỡ cài đặt giữ mã thiết bị: cài lại trong cùng dự án vẫn là cùng một bản script với CRM.
  const device=heavy.properties.maThietBi;
  heavy.api.goCaiDat();assert.deepEqual(heavy.shape(),[]);assert.deepEqual(heavy.properties,{maThietBi:device});
});

Deno.test('a failed trigger create keeps the old schedule and retries on the next run',()=>{
  const g=google({now:vn('2026-10-09T23:59:00')});g.api.caiDat();
  g.control.failCreate=true;g.clock.now=vn('2026-10-10T00:31:00');
  assert.throws(()=>g.api.quetGmail(),/too many times/);
  assert.deepEqual(g.shape(),[{handler:'quetGmail',minutes:1}]);assert.equal(g.properties.nhip,'day-1m');
  g.control.failCreate=false;g.clock.now=vn('2026-10-10T00:32:00');g.api.quetGmail();
  assert.equal(g.properties.nhip,'night-10m');assert.equal(g.shape()[0].minutes,10);
});

Deno.test('temporary CRM failures keep progress and retry without duplicates',()=>{
  const now=vn('2026-10-09T10:00:00');let failing=true;
  const g=google({now,mails:[mail('m-1',now-120_000),mail('m-2',now-60_000)],respond:json=>json.id===idOf('m-2')&&failing?503:201});
  g.api.caiDat();
  assert.deepEqual(g.emails().map(emailId),[idOf('m-1'),idOf('m-2')]);
  assert.equal(Number(g.properties.conTro),now-120_000,'con trỏ dừng ở thư cuối đã gửi xong');
  failing=false;g.clock.now=now+60_000;g.api.quetGmail();
  assert.deepEqual(g.emails().map(emailId),[idOf('m-1'),idOf('m-2'),idOf('m-2')]);
  g.clock.now=now+120_000;g.api.quetGmail();assert.equal(g.emails().length,3);
  assert.ok(Number(g.properties.conTro)>=now+60_000);
});

Deno.test('revoked or paused keys slow down to 30 minutes, alert loudly and recover by themselves',()=>{
  const now=vn('2026-10-09T10:00:00');let revoked=false;
  const g=google({now,mails:[mail('m-1',now-60_000)],respond:()=>revoked?401:201});
  g.api.caiDat();assert.deepEqual(g.shape(),[{handler:'quetGmail',minutes:1}]);
  revoked=true;g.mails.push(mail('m-2',now+30_000));g.clock.now=now+60_000;
  assert.throws(()=>g.api.quetGmail(),/CRM từ chối khóa kết nối/);
  assert.deepEqual(g.shape(),[{handler:'quetGmail',minutes:30}]);assert.ok(g.properties.khoaLoi);
  assert.equal(g.properties.daGui0.includes('m-2'),false);
  revoked=false;g.clock.now=now+30*60_000;g.api.quetGmail();
  assert.deepEqual(g.shape(),[{handler:'quetGmail',minutes:1}]);assert.equal(g.properties.khoaLoi,'');
  assert.equal(g.emails().map(emailId).filter(id=>id===idOf('m-2')).length,2);
});

Deno.test('409 is told apart: a stored duplicate is skipped, a script bound elsewhere stops with instructions',()=>{
  const now=vn('2026-10-09T10:00:00');
  const g=google({now,mails:[mail('m-1',now-120_000),mail('m-2',now-60_000)],respond:json=>json.id===idOf('m-1')?409:201});
  g.api.caiDat();
  assert.deepEqual(g.emails().map(emailId),[idOf('m-1'),idOf('m-2')]);
  assert.ok(g.properties.daGui0.includes('m-1'));
  const bound=google({now,mails:[mail('m-1',now-60_000)],respond:()=>409});
  assert.throws(()=>bound.api.caiDat(),/đang gắn với một bản script khác/);
  assert.equal(String(bound.properties.daGui0??'').includes('m-1'),false);
});

Deno.test('a contract mismatch (400) stops without marking or skipping the email',()=>{
  const now=vn('2026-10-09T10:00:00');
  const g=google({now,mails:[mail('m-1',now-60_000)],respond:json=>json.event==='email.received'?400:201});
  assert.throws(()=>g.api.caiDat(),/không nhận định dạng thư/);
  assert.equal(String(g.properties.daGui0??''),'');assert.ok(Number(g.properties.conTro)<now-3600_000);
});

Deno.test('long or malformed email text is cut to the accepted UTF-8 size and stays well formed',async()=>{
  const now=vn('2026-10-09T10:00:00');
  const g=google({now,mails:[mail('m-big',now-60_000,{body:'Ghi có +5,000 VND\n'+'Nội dung dài 😊 '.repeat(2000)+'\ud800'})]});
  g.api.caiDat();
  const body=String(g.emails()[0].json.body);
  assert.ok(new TextEncoder().encode(body).length<=8192);assert.ok(body.isWellFormed());
  assert.equal((await deliver(g.emails()[0])).status,201);
});

Deno.test('search query requires a source of mail and rejects unsafe labels',()=>{
  assert.equal(gmailSearchQuery({label:'',includeBanks:false}),null);
  assert.equal(gmailSearchQuery({label:'crm" OR in:anywhere',includeBanks:true}),null);
  assert.equal(gmailSearchQuery({label:'Ngân hàng/ACB',includeBanks:false}),'label:ngân-hàng-acb');
  assert.throws(()=>buildGmailScript({ingestUrl:'http://insecure.test',token,label:'',includeBanks:true}),/HTTPS/);
});
