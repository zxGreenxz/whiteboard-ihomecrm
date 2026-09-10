// Preserve the deployed permission rule while binding its membership witness
// to exactly one company. The original global helper remains untouched.
import {createHash} from 'node:crypto';
export function scopedMemberPermissionHelper(catalog){
 const source=catalog.functions.filter(f=>f.schema==='app_private'&&f.name==='has_any_scope_v3'&&f.arguments==='p_permission_key text');
 if(source.length!==1)throw new Error('Expected one live permission helper');
 const original=source[0];
 if(createHash('md5').update(original.definition).digest('hex')!==original.digest)throw new Error('Permission source digest mismatch');
 let sql=original.definition.replace(/\r\n/g,'\n');
 const header='app_private.has_any_scope_v3(p_permission_key text)';
 if(sql.split(header).length!==2)throw new Error('Unexpected permission helper signature');
 sql=sql.replace(header,'app_private.has_any_scope_for_org_v1(p_permission_key text, p_org uuid)');
 const witness='on m.user_id = (select auth.uid())';
 if(sql.split(witness).length!==2)throw new Error('Unexpected membership witness');
 sql=sql.replace(witness,witness+'\n       and m.organization_id = p_org');
 const signature='app_private.has_any_scope_for_org_v1(text,uuid)';
 return {signature,body:sql.slice(sql.indexOf('AS $function$')+'AS $function$'.length,sql.lastIndexOf('$function$')),
  sql:sql.trim().replace(/;$/,'')+';\nREVOKE ALL ON FUNCTION '+signature+' FROM PUBLIC,anon,authenticated,service_role;',
  dependency:{signature:'app_private.has_any_scope_v3(text)',digest:original.digest}};
}
