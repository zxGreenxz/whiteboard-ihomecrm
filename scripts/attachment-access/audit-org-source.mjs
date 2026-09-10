// Static inventory only. A missing inline organization argument is NOT an auth bug:
// parent-bound RPCs, wrappers, spreads, triggers and server checks need human review.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, relative, join } from 'node:path';
import ts from 'typescript';

const root=resolve(process.argv[2]??'.');
const output=process.argv[3];
if(!output) throw new Error('Usage: node audit-org-source.mjs repo-root output.json');
const files=[];
async function walk(dir){
  for(const e of await readdir(dir,{withFileTypes:true})){
    if(['node_modules','dist','__tests__','__mocks__'].includes(e.name)) continue;
    const p=join(dir,e.name);
    if(e.isDirectory()) await walk(p);
    else if(/\.[cm]?[jt]sx?$/.test(e.name)&&!/(\.test\.|\.spec\.|\.d\.ts$)/.test(e.name)
      &&!p.endsWith(join('supabase','types.ts'))) files.push(p);
  }
}
for(const dir of ['src','api','supabase/functions']) {
  try{await walk(join(root,dir));}catch(e){if(e.code!=='ENOENT')throw e;}
}
const rows=[];
const text=n=>n?.getText()??'';
const literal=n=>n&&ts.isStringLiteralLike(n)?n.text:null;
function chainTarget(node){
  if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)){
    if(node.expression.name.text==='from')return literal(node.arguments[0]);
    return chainTarget(node.expression.expression);
  }
  if(ts.isPropertyAccessExpression(node))return chainTarget(node.expression);
  return null;
}
for(const path of files){
  const content=await readFile(path,'utf8');
  const source=ts.createSourceFile(path,content,ts.ScriptTarget.Latest,true);
  const usesSelection=/\buseOrganization\s*\(/.test(content);
  function visit(node){
    if(ts.isCallExpression(node)){
      const name=ts.isPropertyAccessExpression(node.expression)?node.expression.name.text:text(node.expression);
      const rpc=/^(rpc|callRpc|compatRpc|rpcNullable)$/.test(name)&&literal(node.arguments[0]);
      const target=['insert','update','upsert','delete'].includes(name)?chainTarget(node.expression):null;
      const upload=['upload','uploadFile'].includes(name);
      if(rpc||target||upload){
        const args=node.arguments.map(text).join(', ');
        rows.push({file:relative(root,path).replaceAll('\\','/'),line:source.getLineAndCharacterOfPosition(node.getStart()).line+1,
          kind:rpc?'rpc':target?name:'upload',target:rpc||target||chainTarget(node.expression)||'dynamic',
          inlineOrganizationArgument:/\b(?:p_organization_id|organization_id|organizationId)\s*:/.test(args),
          fileUsesOrganizationSelection:usesSelection,
          review:'UNREVIEWED: inspect parent entity, server implementation and actual role permissions'});
      }
    }
    ts.forEachChild(node,visit);
  }
  visit(source);
}
rows.sort((a,b)=>a.file.localeCompare(b.file)||a.line-b.line);
const counts=Object.fromEntries([...new Set(rows.map(x=>x.kind))].map(k=>[k,rows.filter(x=>x.kind===k).length]));
const result={capturedAt:new Date().toISOString(),method:'TypeScript AST inventory of literal RPCs, chained table writes and named uploads',
  limitations:'Not a security pass. Dynamic calls, wrappers and separate query variables can be missed. Frontend absence does not imply missing server validation. Runtime coverage is separate.',
  filesScanned:files.length,counts,rows};
await writeFile(resolve(output),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({filesScanned:files.length,counts,total:rows.length}));
