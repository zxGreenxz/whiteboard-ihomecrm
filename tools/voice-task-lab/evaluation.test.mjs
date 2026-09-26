import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEvaluationStore, summarize, validateEvaluation } from './evaluation.mjs';

const draft = { title:'Sửa vòi',description:'Vòi rò',building:'A',room:'101',jobType:'',assignee:'',deadline:'',priority:'NORMAL' };
const verdicts = {title:'correct',building:'correct',room:'incorrect',jobType:'not_applicable',assignee:'unreviewed',deadline:'not_applicable',priority:'correct'};
function record(id='case-1') { return {id,transcript:'Sửa vòi phòng 101',transcriptSource:'manual',sttModel:null,chatModel:'chat-a',predicted:{...draft},expected:{...draft},verdicts:{...verdicts},usefulness:4,notes:'',latencyMs:{transcription:null,extraction:120}}; }

test('metrics use reviewed human verdicts and refuse a partial case as fully reviewed', () => {
  const summary=summarize([record()]);
  assert.equal(summary.fieldAccuracy,75);assert.equal(summary.usefulnessRate,100);assert.equal(summary.reviewedFields,4);assert.equal(summary.correctFields,3);assert.equal(summary.fullyReviewedRecords,0);assert.equal(summary.fullCorrectRate,null);
  assert.equal(summarize([]).fieldAccuracy,null);
  assert.equal(summarize([]).usefulnessRate,null);
});
test('full correctness excludes all not-applicable and counts only completed cases', () => {
  const complete=record('complete'); complete.verdicts={title:'correct',building:'correct',room:'correct',jobType:'not_applicable',assignee:'not_applicable',deadline:'not_applicable',priority:'correct'};
  const wrong=record('wrong'); wrong.verdicts.assignee='incorrect';
  const none=record('none'); for(const key of Object.keys(none.verdicts)) none.verdicts[key]='not_applicable';
  const summary=summarize([complete,wrong,none]);
  assert.equal(summary.fullyReviewedRecords,2); assert.equal(summary.fullyCorrectRecords,1); assert.equal(summary.fullCorrectRate,50);
});
test('evaluation upsert survives reopen and never inflates duplicate trial counts', async () => {
  const directory=await mkdtemp(join(tmpdir(),'voice-eval-'));
  try {
    const store=await createEvaluationStore(directory);
    await Promise.all([store.upsert(record()),store.upsert({...record(),usefulness:2})]);
    const reopened=await createEvaluationStore(directory);
    const records=await reopened.list();
    assert.equal(records.length,1); assert.equal(records[0].usefulness,2);
    assert.equal(summarize(records).ratedRecords,1);
  } finally { await rm(directory,{recursive:true,force:true}); }
});
test('evaluation rejects missing verdicts, invented sources, oversized input and extra properties', () => {
  for(const patch of [{transcriptSource:'ai'},{notes:'x'.repeat(4001)},{audio:'secret'},{latencyMs:{transcription:-1,extraction:10}},{verdicts:{title:'correct'}},{usefulness:0}]) assert.throws(()=>validateEvaluation({...record(),...patch}));
  for(const source of ['manual','browser','9router']) assert.equal(validateEvaluation({...record(),transcriptSource:source,sttModel:source==='9router'?'stt-a':null}).transcriptSource,source);
  assert.throws(()=>validateEvaluation({...record(),transcriptSource:'manual',sttModel:'stt-a'}));
});
test('resaving cannot rewrite the original model output or source provenance',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'voice-immutable-'));
  try{const store=await createEvaluationStore(directory);await store.upsert(record());
    for(const patch of [{transcript:'Changed'},{chatModel:'other'},{predicted:{...draft,title:'Changed'}},{latencyMs:{transcription:null,extraction:1}}]) await assert.rejects(store.upsert({...record(),...patch}),{code:'ORIGINAL_CHANGED'});
    assert.equal((await store.list())[0].predicted.title,'Sửa vòi');
  }finally{await rm(directory,{recursive:true,force:true});}
});
test('summary groups isolate browser and 9router trials even when chat model matches',()=>{
  const browser={...record('browser'),transcriptSource:'browser'};
  const router={...record('router'),transcriptSource:'9router',sttModel:'stt-a',usefulness:2};
  const summary=summarize([browser,router]);assert.equal(summary.groups.length,2);
  assert.equal(summary.groups.find(group=>group.transcriptSource==='browser').usefulnessRate,100);
  assert.equal(summary.groups.find(group=>group.transcriptSource==='9router').usefulnessRate,0);
});
