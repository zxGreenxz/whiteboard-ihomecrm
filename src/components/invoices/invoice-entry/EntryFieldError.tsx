import type {InvoiceEntryController} from './useInvoiceEntry';
export function EntryFieldError({ctl,name}:{ctl:InvoiceEntryController;name:string}) {
 const error=name.split('.').reduce<unknown>((value,key)=>value && typeof value==='object'?(value as Record<string,unknown>)[key]:undefined,ctl.errors);
 const message=error && typeof error==='object'?(error as {message?:unknown}).message:undefined;
 return typeof message==='string'?<p id={`invoice-entry-error-${name}`} role="alert" className="mt-1 text-xs text-destructive">{message}</p>:null;
}
