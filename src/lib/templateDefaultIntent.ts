import {FinancialWorkflowError} from './financialWorkflow';
const key=(requestKey:string)=>`ihome:template-default-intent:v1:${requestKey}`;
export interface TemplateDefaultIntent {id:string;is_default:boolean;is_income_template:boolean}
export function rememberTemplateDefaultIntent(requestKey:string,intent:TemplateDefaultIntent){
 try{localStorage.setItem(key(requestKey),JSON.stringify(intent));}
 catch{throw new FinancialWorkflowError('Chưa lưu được dấu vết chọn mẫu mặc định trong trình duyệt. Kiểm tra quyền lưu dữ liệu trước khi tiếp tục.','failure',[]);}
}
export function matchesTemplateDefaultIntent(requestKey:string|undefined,intent:TemplateDefaultIntent):boolean{
 if(!requestKey)return false;
 try{const saved=JSON.parse(localStorage.getItem(key(requestKey)) ?? 'null') as TemplateDefaultIntent|null;return !!saved && saved.id===intent.id && saved.is_default===intent.is_default && saved.is_income_template===intent.is_income_template;}
 catch{return false;}
}
