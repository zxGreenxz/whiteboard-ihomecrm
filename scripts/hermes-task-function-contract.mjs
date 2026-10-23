import {createHash} from 'node:crypto';
import {extractFunctionDefinitions,splitSqlStatements,normalizeSqlSource} from './network-center-function-bodies.mjs';
import {TASK_FUNCTIONS,CUSTOMER_FUNCTIONS} from './hermes-task-function-specs.mjs';
import {HERMES_READ_STANDARD_FUNCTIONS} from './hermes-read-function-specs.mjs';
export {TASK_FUNCTIONS,CUSTOMER_FUNCTIONS};
const hash=value=>createHash('sha256').update(value).digest('hex');
const requireValue=(value,code)=>{if(!value)throw Object.assign(new Error(code),{code});};
const standard=new Map([...TASK_FUNCTIONS,...CUSTOMER_FUNCTIONS].filter(item=>item.standard).map(item=>[item.name,item]));
// SQL-standard functions outside the task catalog still have to be joined and
// accounted for when a candidate migration is parsed.  Keep this allowlist
// explicit and byte-bound so adding a new BEGIN ATOMIC body cannot silently
// weaken task source verification.
// One name may carry several reviewed (file, bytes) pairs: a forward migration
// that CREATE OR REPLACEs a reader leaves the applied file immutable, so both
// the historical and the live statement stay path- and byte-bound.
const externalStandard=new Map();
const addExternal=spec=>externalStandard.set(spec.name,[...(externalStandard.get(spec.name)??[]),spec]);
for(const spec of [
 ...HERMES_READ_STANDARD_FUNCTIONS,
 {
  name:'public.hermes_customer_create_action_v1',
  sourcePath:'supabase/migrations/20261014104442_hermes_customer_lead_create_action_v1.sql',
  statementSha256:'a65c0caaa8e6fbaf04c73d0af4eb9bc6d3d6cad2871b6271fa1fdace9660b451',
 },
 // Gói D: invoker binds private helper OIDs at definition time (no app_private USAGE).
 {
  name:'public.hermes_task_follow_action_v1',
  sourcePath:'supabase/migrations/20261015110000_hermes_task_follow_v1.sql',
  statementSha256:'d9a1a93cbcc59910e6c1f2f39a9d2be90c4a70fb080da760c952eec93b1387ee',
 },
 // Đợt 2 Gói 0: lối vào báo cáo INVOKER gắn OID bước kiểm quyền / hàm gói / bước kết thúc lúc tạo.
 {
  name:'public.hermes_w2_read_v1',
  sourcePath:'supabase/migrations/20261018000600_hermes_w2_invoker_gate_v1.sql',
  statementSha256:'eb3603767a8a0c47bbae0c367b3f6714c6a2fc585f64d568f9ab7f85817c5ba5',
 },
 // Nền chung thao tác ghi (M1): vỏ INVOKER gắn OID guard / giải tên / bước ghi DEFINER lúc tạo.
 {
  name:'public.hermes_action_probe_v1',
  sourcePath:'supabase/migrations/20261021133823_hermes_action_foundation_v1.sql',
  statementSha256:'25af9c8232daf39cd325b4b8ab08c17cfdc534d502abf1aaa6d1145eb301dfca',
 },
 // Trang Hợp đồng (Đợt 2): vỏ INVOKER gắn OID guard / giải tên / tra cứu / bước ghi DEFINER lúc tạo.
 {
  name:'public.hermes_contract_action_v1',
  sourcePath:'supabase/migrations/20261022022951_hermes_contract_action_v1.sql',
  statementSha256:'cb4774dc01070a244241028a4c3977c33222da25f654b817a0a9b860f800ff0b',
 },
 // Đợt 2 Thu chi (Mốc 2): RPC trang expense.* — cùng khuôn vỏ INVOKER gắn OID guard / lõi giải tên / bước ghi DEFINER.
 {
  name:'public.hermes_expense_write_v1',
  sourcePath:'supabase/migrations/20261022024834_hermes_expense_write_v1.sql',
  statementSha256:'5960c256f08748aab117c62bb218324e4dedea62e9b1a57d3f7411fd0ab57d59',
 },
 // Đợt 2 Thu chi (Mốc 3): vỏ expense.* gắn OID phạm vi (guard ∩ hàm kiểm quyền của hàm ghi web); giải tên _v2 ghim ở
 // hermes-read-function-specs (cùng chỗ với _v1).
 {
  name:'public.hermes_expense_write_v1',
  sourcePath:'supabase/migrations/20261022044123_hermes_expense_scope_v1.sql',
  statementSha256:'321484f76fedd6f3d96f094ce5f4bf1201e336bc9b50263b2b9ef60faaa0d774',
 },
 // Đợt 2b Công việc (CV-M1): vỏ INVOKER gắn OID guard / lõi giải tên / người quản lý toà / ba tầng chuẩn bị-ghi-chốt lúc tạo.
 {
  name:'public.hermes_task_action_v1',
  sourcePath:'supabase/migrations/20261022031548_hermes_task_action_create_v1.sql',
  statementSha256:'2948cefb90348c6445074b162ec4bbd7906d802965c8a86a4dc7a63208bee61d',
 },
 // Đợt 3 Hoá đơn (Mốc 3/3b): RPC trang invoice.* — vỏ INVOKER gắn OID guard / tra cứu INVOKER / bước ghi DEFINER (quyền thu của v5).
 {
  name:'public.hermes_invoice_action_v1',
  sourcePath:'supabase/migrations/20261022075230_hermes_invoice_action_v1.sql',
  statementSha256:'388d177cd7ec770dd0e3bae00a936304753a43db310c2a2064e8d4735c559097',
 },
 // Mốc 5 dựng lại vỏ trang (thêm tra khách INVOKER cho người ở + nháp; lượt 2 tra lại theo customerId).
 {
  name:'public.hermes_contract_action_v1',
  sourcePath:'supabase/migrations/20261022074815_hermes_contract_party_draft_v1.sql',
  statementSha256:'4f6e55f7823b2cfa3458b37866c323e478b1d60b5ac6493e9f55140adf1b20b9',
 },
 // Đợt 3 Hoá đơn (Mốc 4): vỏ invoice.* chuyển theo thao tác — invoice.meter_record tới tra cứu/bước ghi chỉ số, còn lại như Mốc 3.
 {
  name:'public.hermes_invoice_action_v1',
  sourcePath:'supabase/migrations/20261022183445_hermes_invoice_meter_v1.sql',
  statementSha256:'44cca4c35b0025fd1366965519246ed58976cee683d7416f9adee2728765280e',
 },
])addExternal(spec);
const sqlStandard=new Map([...standard,...externalStandard]);
function withoutLeadingComments(text){
 let next=text.trimStart();
 while(next.startsWith('--')||next.startsWith('/*')){
  if(next.startsWith('--')&&!next.includes('\n'))return '';
  const end=next.startsWith('--')?next.indexOf('\n')+1:next.indexOf('*/');
  requireValue(end>=0,'task_function_source_unreadable');next=next.slice(next.startsWith('--')?end:end+2).trimStart();
 }
 return next;
}

// The existing splitter/extractor remains unchanged. Exactly these three
// single-statement SQL-standard bodies may join their trailing END token; any
// additional statement or unknown BEGIN ATOMIC function fails. Extraction below
// additionally checks the exact raw source; static replay checks the fixed body.
export function splitHermesFunctionStatements(sql){
 const statements=splitSqlStatements(sql),result=[];
 for(let index=0;index<statements.length;index++){
  const raw=statements[index],statement=withoutLeadingComments(raw);
  const head=/^CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+((?:public|app_private)\.\w+)\(/i.exec(statement);
  if(head&&/\bBEGIN\s+ATOMIC\b/i.test(statement.split(/\bAS\s+\$/i)[0])){
   const spec=sqlStandard.get(head[1]);
   requireValue(spec&&statements[index+1]?.trim()==='END','task_sql_standard_source_mismatch');
   const complete=statement+';\nEND';
   result.push(complete);index++;
  }else result.push(raw);
 }
 return result;
}

export function extractHermesFunctionDefinitions(sql,path='migration.sql'){
 return splitHermesFunctionStatements(sql).flatMap(raw=>{
  const statement=withoutLeadingComments(raw),head=/^CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+((?:public|app_private)\.\w+)\(/i.exec(statement);
  const spec=head&&standard.get(head[1]);
  const external=head&&externalStandard.get(head[1]);
  if(external){
   requireValue(external.some(spec=>path===spec.sourcePath&&hash(statement)===spec.statementSha256),'task_sql_standard_source_mismatch');
   return [{qualifiedName:head[1],bodyKind:'sql-standard',bodyDigest:null,external:true}];
  }
  if(spec){
   // A reviewed forward migration that CREATE OR REPLACEs a SQL-standard task body is path- and byte-bound
   // through spec.successors[path] (22/10: hermes_task_input_rows_v1); every other path keeps the base bytes.
   requireValue(hash(statement)===(spec.successors?.[path]?.statementSha256??spec.statementSha256),'task_sql_standard_source_mismatch');
   return [{qualifiedName:spec.name,bodyKind:'sql-standard',bodyDigest:null}];
  }
  return extractFunctionDefinitions(raw,path);
 });
}

// Run on one owned connection so the deparser's search_path is deterministic.
// READ ONLY + ROLLBACK: no schema/function/session state survives this check.
export async function verifyFunctionCatalog(pool,sources,{functions,errorPrefix,receiptTable}){
 const expected=new Map(sources.flatMap(source=>extractHermesFunctionDefinitions(source.bytes.toString('utf8'),source.path)
  .map(item=>({...item,sourcePath:source.path})))
  .map(item=>[item.qualifiedName,item]));
 const prefix=errorPrefix;
 requireValue(functions.every(spec=>expected.has(spec.name)), 'live_'+prefix+'_source_incomplete');
 const client=await pool.connect();
 try{
  await client.query('BEGIN READ ONLY');
  await client.query('SET LOCAL search_path=pg_catalog');
  const rows=(await client.query('SELECT n.nspname||\'.\'||p.proname name,p.oid::regprocedure::text signature,'+
   'p.prosrc,p.prosqlbody IS NOT NULL parsed_body,pg_get_functiondef(p.oid) definition,p.prosecdef,'+
   'pg_get_userbyid(p.proowner) owner,p.proconfig,l.lanname language,p.provolatile,p.proparallel,p.proleakproof,p.proisstrict,'+
   'pg_get_function_identity_arguments(p.oid) arguments,pg_get_function_result(p.oid) result,'+
   '(SELECT jsonb_agg(jsonb_build_object(\'type\',a.type,\'identity\',a.identity,\'deptype\',d.deptype,'+
   '\'bound_oid\',d.refobjid::bigint,\'resolved_oid\',(CASE WHEN a.type=\'function\' THEN to_regprocedure(a.identity)::oid '+
   'WHEN a.type=\'schema\' THEN to_regnamespace(a.identity)::oid WHEN a.type=\'table column\' THEN to_regclass(format(\'%I.%I\',a.schema,a.name))::oid ELSE NULL END)::bigint) '+
   'ORDER BY a.type,a.identity,d.deptype) FROM pg_depend d CROSS JOIN LATERAL pg_identify_object(d.refclassid,d.refobjid,d.refobjsubid) a '+
   'WHERE d.classid=\'pg_proc\'::regclass AND d.objid=p.oid) dependencies,'+
   '(SELECT jsonb_agg(jsonb_build_object(\'grantee\',CASE WHEN x.grantee=0 THEN \'PUBLIC\' ELSE pg_get_userbyid(x.grantee) END,'+
   '\'privilege\',x.privilege_type,\'grantable\',x.is_grantable) ORDER BY x.grantee) FROM aclexplode(COALESCE(p.proacl,acldefault(\'f\',p.proowner))) x) acl '+
   'FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang '+
   'WHERE n.nspname||\'.\'||p.proname=ANY($1::text[])',[functions.map(item=>item.name)])).rows;
  requireValue(rows.length===functions.length,'live_'+prefix+'_signature_mismatch');
  for(const spec of functions){
   const row=rows.find(item=>item.name===spec.name);
   const source=expected.get(spec.name),successor=spec.successors?.[source.sourcePath];
   requireValue(row?.signature===spec.signature&&row.owner==='postgres'&&row.language===spec.language&&row.prosecdef===spec.definer
    &&row.provolatile===(successor?.volatility??'v')&&row.proparallel==='u'&&row.proleakproof===false&&row.proisstrict===false
    &&JSON.stringify(row.proconfig)===JSON.stringify(['search_path='+spec.searchPath.replaceAll(',',', ')])
    &&row.arguments===spec.header.match(/\(([^)]*)\)/)[1].split(',').map(item=>item.trim()).join(', ')
    &&row.result===(spec.name==='app_private.hermes_task_assignee_member_v1'?'boolean':'jsonb'),'live_'+prefix+'_definition_mismatch');
   if(spec.standard){
    // The latest source decides which reviewed deparse is live: a successor's, else the base.
    requireValue(row.parsed_body===true&&row.prosrc===''&&hash(normalizeSqlSource(row.definition))===(successor?.deparsedSha256??spec.deparsedSha256),'live_'+prefix+'_sql_standard_body_mismatch');
    requireValue(Array.isArray(row.dependencies)&&row.dependencies.every(item=>Number.isInteger(item.bound_oid)&&item.bound_oid>0&&item.bound_oid===item.resolved_oid)
     &&JSON.stringify(row.dependencies.map(({type,identity,deptype})=>({type,identity,deptype})))===JSON.stringify(successor?.dependencies??spec.dependencies),'live_'+prefix+'_dependency_mismatch');
   }else {
    const digest=successor?.bodyDigest??spec.bodyDigest??source.bodyDigest;
    requireValue(source.bodyDigest===digest&&row.parsed_body===false&&typeof row.prosrc==='string'
     &&hash(normalizeSqlSource(row.prosrc))===digest,'live_'+prefix+'_body_mismatch');
   }
   const grantees=spec.authenticated?['authenticated','postgres']:['postgres'];
   requireValue(Array.isArray(row.acl)&&row.acl.length===grantees.length&&row.acl.every(item=>grantees.includes(item.grantee)&&item.privilege==='EXECUTE'&&item.grantable===false)
    &&new Set(row.acl.map(item=>item.grantee)).size===grantees.length,'live_'+prefix+'_acl_mismatch');
   const acl=(await client.query('SELECT role,has_function_privilege(role,$1,\'EXECUTE\') allowed FROM unnest($2::text[]) role',
    [spec.signature,['anon','authenticated','service_role','hermes_store_executor']])).rows;
   requireValue(acl.length===4&&acl.every(item=>item.allowed===(spec.authenticated&&item.role==='authenticated')),'live_'+prefix+'_acl_mismatch');
  }
  const receipt=(await client.query('SELECT c.relrowsecurity,pg_get_userbyid(c.relowner) owner,'+
    'has_schema_privilege(\'authenticated\',\'app_private\',\'USAGE\') private_usage,'+
    'COALESCE(c.relacl,acldefault(\'r\',c.relowner))=acldefault(\'r\',c.relowner) owner_only_acl,'+
    'EXISTS(SELECT 1 FROM unnest(ARRAY[\'anon\',\'authenticated\',\'service_role\',\'hermes_store_executor\']) r(role) '+
    'CROSS JOIN LATERAL aclexplode(acldefault(\'r\',c.relowner)) p WHERE has_table_privilege(r.role,c.oid,p.privilege_type)) table_access '+
    'FROM pg_class c WHERE c.oid=to_regclass($1)',['app_private.'+receiptTable])).rows;
  requireValue(receipt.length===1&&receipt[0].relrowsecurity&&receipt[0].owner==='postgres'&&!receipt[0].private_usage
   &&receipt[0].owner_only_acl===true&&!receipt[0].table_access,'live_'+prefix+'_private_boundary_mismatch');
 }finally{
  try{await client.query('ROLLBACK');}finally{client.release();}
 }
}
export const verifyTaskFunctionCatalog=(pool,sources)=>verifyFunctionCatalog(pool,sources,{
 functions:TASK_FUNCTIONS,errorPrefix:'task',receiptTable:'hermes_task_create_receipts',
});
export const verifyCustomerFunctionCatalog=(pool,sources)=>verifyFunctionCatalog(pool,sources,{
 functions:CUSTOMER_FUNCTIONS,errorPrefix:'customer',receiptTable:'hermes_customer_create_receipts',
});
