import {useEffect,type RefObject} from 'react';
import {useFormContext} from 'react-hook-form';
import {focusFirstError} from './formErrors';

const invalidSelector='[data-input-error="true"]:not(:disabled)';
/** Also called by manual dialog actions that do not submit a native form. */
export function validateInputDrafts(root:ParentNode|null|undefined):boolean{
 const invalid=root?.querySelector<HTMLInputElement>(invalidSelector);
 if(!invalid)return true;
 invalid.scrollIntoView?.({block:'center',behavior:'auto'});invalid.focus({preventScroll:true});
 const name=invalid.name||invalid.dataset.fieldName;
 if(name)void focusFirstError({[name]:invalid.validationMessage},{root:root instanceof HTMLElement?root:undefined});
 return false;
}
/** Reject malformed drafts without skipping the other RHF field validations. */
export function useInputDraftGuard(ref:RefObject<HTMLInputElement|null>,error:string|undefined):void{
 const context=useFormContext();
 useEffect(()=>{
  const input=ref.current;input?.setCustomValidity(error??'');
  if(!error&&input?.name&&context?.getFieldState(input.name).error?.type==='input-draft')context.clearErrors(input.name);
  const form=input?.form;if(!form)return;
  const validate=(event:Event)=>{
   if(!form.querySelector(invalidSelector))return;
   event.preventDefault();event.stopImmediatePropagation();
   if(!context){validateInputDrafts(form);return;}
   void context.trigger().then(()=>{
    const errors:Record<string,string>={};
    // Get current field state after the resolver, instead of an earlier render snapshot.
    for(const node of form.querySelectorAll<HTMLElement>('[name],[data-field-name]')){
     const name=node.getAttribute('name')||node.dataset.fieldName;if(!name)continue;
     const fieldError=context.getFieldState(name).error;if(fieldError?.message)errors[name]=String(fieldError.message);
    }
    for(const invalid of form.querySelectorAll<HTMLInputElement>(invalidSelector)){
     const name=invalid.name||invalid.dataset.fieldName;if(!name)continue;
     const message=invalid.validationMessage||'Kiểm tra nội dung đã nhập.';
     context.setError(name,{type:'input-draft',message});errors[name]=message;
    }
    return focusFirstError(errors,{root:form});
   }).catch(()=>{validateInputDrafts(form);});
  };
  form.addEventListener('submit',validate,true);
  return()=>{form.removeEventListener('submit',validate,true);input?.setCustomValidity('');};
 },[ref,error,context?.trigger,context?.setError,context?.getFieldState,context?.clearErrors]);
}
