import type {ErrorFocusOptions} from './formErrors';
import {reportBoundaryError} from '@/components/errors/boundaryReporter';

function fieldNames(errors:unknown,prefix=''):string[]{
 if(prefix==='root'||prefix.startsWith('root.'))return [];
 if(typeof errors==='string')return prefix?[prefix]:[];
 if(!errors||typeof errors!=='object')return [];
 if('message' in errors&&typeof errors.message==='string')return prefix?[prefix]:[];
 const entries:[string,unknown][]=Object.entries(errors);
 return entries.flatMap(([key,value])=>['ref','type','types'].includes(key)?[]:fieldNames(value,prefix?`${prefix}.${key}`:key));
}
function reportFocusFailure(cause:unknown):void{
 try{reportBoundaryError(Object.assign(new Error('Form error focus helper unavailable'),{cause}));}catch{/* Diagnostics must not reject a detached focus task. */}
}

/** Auth forms keep their inline errors usable even if the optional focus chunk cannot load. */
export async function focusFirstError(errors:unknown,options:ErrorFocusOptions={}):Promise<boolean>{
 if(typeof document==='undefined')return false;
 const names=fieldNames(errors);if(!names.length)return false;
 try{const helper=await import('./formErrors');return await helper.focusFirstError(errors,options);}catch(cause){reportFocusFailure(cause);}
 // Auth errors and controls must commit before the lightweight fallback checks the DOM.
 await new Promise<void>(resolve=>setTimeout(resolve,0));
 try{
  const root=options.root??document;
  const nodes=Array.from(root.querySelectorAll<HTMLElement>('[name]')).filter(node=>names.includes(node.getAttribute('name')??''));
  const order=options.order;
  if(order){const rank=(node:HTMLElement)=>{const name=node.getAttribute('name')??'';const index=order.findIndex(field=>name===field||name.startsWith(`${field}.`));return index>=0?index:order.length+names.indexOf(name);};nodes.sort((a,b)=>rank(a)-rank(b));}
  for(const node of nodes){
   if(!node.matches('input:not([type="hidden"]),select,textarea,button,[tabindex]')||node.matches(':disabled,[aria-disabled="true"]')||node.closest('[hidden],[aria-hidden="true"],[inert]'))continue;
   let visible=true;for(let ancestor:HTMLElement|null=node;ancestor;ancestor=ancestor.parentElement){const style=getComputedStyle(ancestor);if(style.display==='none'||style.visibility==='hidden'){visible=false;break;}}
   if(!visible)continue;
   node.scrollIntoView?.({block:'center',behavior:'auto'});node.focus({preventScroll:true});if(document.activeElement===node)return true;
  }
 }catch(cause){reportFocusFailure(cause);}
 return false;
}
