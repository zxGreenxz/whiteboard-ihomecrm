const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const repo = path.resolve(__dirname, '../../..');
const read = p => JSON.parse(fs.readFileSync(path.resolve(__dirname, p), 'utf8'));
const git = args => execFileSync('git', args, {cwd: repo, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024}).trim();
const hash = p => crypto.createHash('sha256').update(fs.readFileSync(path.resolve(repo, p))).digest('hex');
const old = read('../2026-09-26-plan-cam-ket-goi-audit/do-nen-26-09.json');
const one = read('do-nen-ket-qua.json');
const two = read('do-nen2-ket-qua.json');
const md5 = read('../2026-09-26-plan-cam-ket-goi-audit/md5-ham-26-09.json').ham;
const compare = [];
for (const [round, baseline, measured] of [['vong_1', old.vong_1, one.ket_qua], ['vong_2', old.vong_2, two.ket_qua]]) {
  for (const [name, value] of Object.entries(baseline)) {
    compare.push({round, name, equal: JSON.stringify(value) === JSON.stringify(measured[name]), baseline: value, measured: measured[name]});
  }
}
const fnCompare = md5.map(b => ({...b, measured: one.ket_qua['md5-ham-plan-nhac'].find(x => x.fn === b.fn),
  equal: JSON.stringify(b) === JSON.stringify(one.ket_qua['md5-ham-plan-nhac'].find(x => x.fn === b.fn))}));
const files = ['docs/plans/PLAN-CO-MAY-CHI-THEO-CAM-KET-2026-09-26.md', 'docs/plans/PLAN-MOT-LUONG-THU-CHI-2026-09-23.md',
  ...['DOC-TRUOC.md','do-nen.cjs','do-nen2.cjs','do-nen-26-09.json','md5-ham-26-09.json'].map(x => 'docs/audits/2026-09-26-plan-cam-ket-goi-audit/' + x)];
const diff = git(['diff','c22adb2c..origin/main','--','supabase/migrations']);
const out = {checked_at: new Date().toISOString(), code_ref: git(['rev-parse','origin/main']), head: git(['rev-parse','HEAD']), production_ref: git(['rev-parse','origin/production']),
  baseline_time_vn: old.do_luc_vn, run_1: one.do_luc, run_2: two.do_luc,
  input_hashes: files.map(file => ({file,sha256:hash(file)})),
  comparisons: compare, function_comparisons: fnCompare,
  A9: {range: 'c22adb2c..origin/main', search_scope:'git diff -- supabase/migrations', matching_diff_lines: diff.split('\n').filter(x => /^[+-]/.test(x) && /pay_period_fee|pay_utility_bill|update_cashbook_metadata_v1/.test(x))}
};
fs.writeFileSync(path.join(__dirname,'doi-chieu-nen.json'),JSON.stringify(out,null,2)+'\n');
console.log(JSON.stringify({code_ref:out.code_ref, run_1:out.run_1,run_2:out.run_2,metrics_changed:compare.filter(x=>!x.equal),md5_changed:fnCompare.filter(x=>!x.equal),A9:out.A9},null,2));

const expected = {
  'PLAN-CO-MAY-CHI-THEO-CAM-KET-2026-09-26.md':'72ae574acc5ac99a8e1d907df171a4bb3c6e6b976f5e3cd15d4f297771c53252',
  'PLAN-MOT-LUONG-THU-CHI-2026-09-23.md':'592da4f5abf5c7375a748a20bf671f6e9ea393d886327aa3e9af23b062d27f11',
  'do-nen.cjs':'d9738ea15bc48505c0eeb073d2f6cdd29d971b7436a15c598af1ee972eb6db2a',
  'do-nen2.cjs':'dd6f9f1cf6caf6c3788ed1a9adf53a84fcc08ff86d3ca397701ebb42050e9a00',
  'do-nen-26-09.json':'ed6f06011f1af4013a9ad8c7c890eb0f0fed67a4e5ad3692e61f2879b74a58c2',
  'md5-ham-26-09.json':'48e2ecce4f4d882fdcee583e79de6d0adee2c8a930258ab40b04fe61983172dd',
};
const mismatched = out.input_hashes.filter(x=>expected[path.basename(x.file)] && expected[path.basename(x.file)]!==x.sha256);
if(mismatched.length) throw new Error('Input hash changed: '+mismatched.map(x=>x.file).join(', '));
const vaultText = fs.readFileSync(path.join(repo,'CLAUDE.local.md'),'utf8');
const secret = vaultText.match(/Persistent database password[^`]*`([^`]+)`/)?.[1];
if(!secret) throw new Error('Cannot verify credential exclusion');
const inventory=[];
let jsonCount=0;
for(const name of fs.readdirSync(__dirname).sort()) {
  if(name==='FILES-SHA256.json') continue;
  const file=path.join(__dirname,name);
  if(!fs.statSync(file).isFile()) throw new Error('Unexpected subdirectory: '+name);
  const bytes=fs.readFileSync(file);
  const text=bytes.toString('utf8');
  if(text.includes(secret)) throw new Error('Credential found in artifact: '+name);
  if(name.endsWith('.json')) {JSON.parse(text);jsonCount++;}
  if(name.endsWith('.zip')) throw new Error('Unexpected zip artifact');
  inventory.push({file:name,bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')});
}
for(const name of ['catalog-song.json','doi-chieu-song.json','xac-nhan-song.json']) {
  const data=read(name);
  if(data.session?.[0]?.read_only!=='on') throw new Error('Missing read-only session evidence: '+name);
  if(Object.values(data.results).some(x=>x.error)) throw new Error('Unresolved query error: '+name);
}
fs.writeFileSync(path.join(__dirname,'FILES-SHA256.json'),JSON.stringify({verified_at:new Date().toISOString(),input_hashes_unchanged:true,json_files_valid:jsonCount,credential_excluded:true,supplemental_read_only_sessions:3,files:inventory},null,2)+'\n');
console.log(JSON.stringify({input_hashes_unchanged:true,json_files_valid:jsonCount,credential_excluded:true,supplemental_read_only_sessions:3,artifact_files:inventory.length}));
