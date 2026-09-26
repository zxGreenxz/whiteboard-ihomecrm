import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

export const FIELDS = ['title','building','room','jobType','assignee','deadline','priority'];
const DRAFT_KEYS = ['title','description','building','room','jobType','assignee','deadline','priority'];
const VERDICTS = ['correct','incorrect','not_applicable','unreviewed'];
const MAX_RECORDS = 500;

export class LabError extends Error {
  constructor(code, message, status = 400) { super(message); this.name = 'LabError'; this.code = code; this.status = status; }
}
const invalid = () => { throw new LabError('VALIDATION','Dữ liệu không hợp lệ hoặc vượt giới hạn.'); };
export function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value,key))) invalid();
}
export function textField(value, max, required = false) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim()) || value.includes('\u0000')) invalid();
  return value;
}
export function validateDraft(value, required = true) {
  exactKeys(value,DRAFT_KEYS);
  for (const key of DRAFT_KEYS) textField(value[key],key === 'description' ? 12000 : key === 'title' ? 500 : 500,required && ['title','description'].includes(key));
  if (!['NORMAL','LOW','URGENT'].includes(value.priority)) invalid();
  if (value.deadline) {
    if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?\+07:00$/.test(value.deadline)||!Number.isFinite(Date.parse(value.deadline)))invalid();
    const normalized=new Date(Date.parse(value.deadline)+7*60*60*1000).toISOString().slice(0,19);
    if(normalized!==value.deadline.slice(0,19))invalid();
  }
  return structuredClone(value);
}
export function validateEvaluation(value) {
  exactKeys(value,['id','transcript','transcriptSource','sttModel','chatModel','predicted','expected','verdicts','usefulness','notes','latencyMs']);
  if (typeof value.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(value.id)) invalid();
  textField(value.transcript,12000,true); textField(value.chatModel,256,true); textField(value.notes,4000);
  if (!['9router','browser','manual'].includes(value.transcriptSource)) invalid();
  if (value.transcriptSource === '9router') textField(value.sttModel,256,true);
  else if (value.sttModel !== null) invalid();
  validateDraft(value.predicted); validateDraft(value.expected,false); exactKeys(value.verdicts,FIELDS);
  for (const field of FIELDS) if (!VERDICTS.includes(value.verdicts[field])) invalid();
  if (!Number.isInteger(value.usefulness) || value.usefulness < 1 || value.usefulness > 5) invalid();
  exactKeys(value.latencyMs,['transcription','extraction']);
  for (const latency of Object.values(value.latencyMs)) if (latency !== null && (typeof latency !== 'number' || !Number.isFinite(latency) || latency < 0 || latency > 3600000)) invalid();
  return structuredClone(value);
}
function metrics(records) {
  let reviewedFields=0,correctFields=0,ratedRecords=0,usefulRecords=0,fullyReviewedRecords=0,fullyCorrectRecords=0;
  for (const record of records) {
    const verdicts=FIELDS.map(field=>record.verdicts[field]);
    const applicable=verdicts.filter(value=>value==='correct'||value==='incorrect');
    reviewedFields+=applicable.length; correctFields+=applicable.filter(value=>value==='correct').length;
    if (Number.isInteger(record.usefulness) && record.usefulness>=1 && record.usefulness<=5) { ratedRecords++; if (record.usefulness>=4) usefulRecords++; }
    if (!verdicts.includes('unreviewed') && applicable.length) { fullyReviewedRecords++; if (applicable.every(value=>value==='correct')) fullyCorrectRecords++; }
  }
  return {totalRecords:records.length,reviewedFields,correctFields,fieldAccuracy:reviewedFields?100*correctFields/reviewedFields:null,ratedRecords,usefulRecords,usefulnessRate:ratedRecords?100*usefulRecords/ratedRecords:null,fullyReviewedRecords,fullyCorrectRecords,fullCorrectRate:fullyReviewedRecords?100*fullyCorrectRecords/fullyReviewedRecords:null};
}
export function summarize(records) {
  const grouped=new Map();
  for(const record of records){const key=JSON.stringify([record.transcriptSource,record.sttModel,record.chatModel]);if(!grouped.has(key))grouped.set(key,[]);grouped.get(key).push(record);}
  const groups=[...grouped.values()].map(group=>({transcriptSource:group[0].transcriptSource,sttModel:group[0].sttModel,chatModel:group[0].chatModel,...metrics(group)}));
  return {...metrics(records),groups};
}
export async function createEvaluationStore(directory) {
  if (!isAbsolute(directory)) throw new LabError('CONFIG','Thư mục đánh giá phải là đường dẫn tuyệt đối.',500);
  await mkdir(directory,{recursive:true,mode:0o700});
  const file=join(directory,'evaluations.json');
  let records=[];
  try {
    if ((await stat(file)).size>50*1024*1024) throw Error('size');
    records=JSON.parse(await readFile(file,'utf8'));
    if (!Array.isArray(records)||records.length>MAX_RECORDS) throw Error('shape');
    records.forEach(validateEvaluation);
    if (new Set(records.map(record=>record.id)).size!==records.length) throw Error('duplicate');
  } catch(error) { if (error.code!=='ENOENT') throw new LabError('STORAGE','Không đọc được tệp đánh giá. Tệp được giữ nguyên để kiểm tra.',500); }
  let queue=Promise.resolve();
  return {
    list: async()=>{await queue;return structuredClone(records);},
    upsert(value) {
      const record=validateEvaluation(value);
      const operation=queue.then(async()=>{
        const next=records.slice(); const index=next.findIndex(item=>item.id===record.id);
        if(index<0) {if(next.length>=MAX_RECORDS) throw new LabError('RECORD_LIMIT','Đã đủ 500 lượt thử. Hãy xuất dữ liệu trước khi bắt đầu đợt mới.',409);next.push(record);}
        else {
          for(const key of ['transcript','transcriptSource','sttModel','chatModel','predicted','latencyMs'])if(!isDeepStrictEqual(next[index][key],record[key]))throw new LabError('ORIGINAL_CHANGED','Bản gốc của lượt thử đã được lưu. Hãy tạo lượt thử mới để thay đổi nội dung hoặc model.',409);
          next[index]=record;
        }
        const temporary=join(directory,`evaluations.${randomUUID()}.tmp`);
        try {
          const handle=await open(temporary,'wx',0o600);
          try {await handle.writeFile(JSON.stringify(next,null,2),'utf8');await handle.sync();} finally {await handle.close();}
          await rename(temporary,file);records=next;
        } catch {await unlink(temporary).catch(()=>{});throw new LabError('STORAGE','Chưa lưu được đánh giá. Vui lòng thử lại.',500);}
        return structuredClone(record);
      });
      queue=operation.then(()=>{},()=>{});
      return operation;
    },
  };
}
