import type { Database } from '@/integrations/supabase/types';
import type { JobWithRelations } from '@/types/jobs';
import { requireReadRow, requireReadRows, readRecord, readString, readNullableString, readDate, readNumber } from './accountProfitReadModels';

const nullableNumber = (value:unknown) => value === null || readNumber(value);
const nullableBoolean = (value:unknown) => value === null || typeof value === 'boolean';
const dates = (row:Record<string,unknown>) => readDate(row.created_at) && readDate(row.updated_at);
const ref = (value:unknown) => value === null || readRecord(value) && readString(value.id) && readString(value.name);
type Plan = Database['public']['Tables']['subscription_plans']['Row'];
type Subscription = Database['public']['Tables']['user_subscriptions']['Row'] & {plan:Plan};
type JobType = Database['public']['Tables']['job_types']['Row'] & {job_groups:{id:string;name:string}|null;departments:{id:string;name:string}|null};
type JobGroup = Database['public']['Tables']['job_groups']['Row'];
const planRow = (row:Record<string,unknown>) => ['id','name'].every(key=>readString(row[key])) && dates(row) && ['description','organization_id'].every(key=>readNullableString(row[key])) && readNumber(row.price) && row.price >= 0 && readNumber(row.duration_months) && Number.isInteger(row.duration_months) && row.duration_months > 0 && ['max_rooms','max_buildings'].every(key=>nullableNumber(row[key])) && nullableBoolean(row.is_active) && (row.features === null || Array.isArray(row.features) && row.features.every(value=>typeof value === 'string'));
export const readSubscriptionPlans = (data:unknown) => requireReadRows<Plan>(data,planRow);
export function readUserSubscription(data:unknown,actorId:string):Subscription|null {
 if(data===null) return null;
 return requireReadRow<Subscription>(data,row=>['id','plan_id'].every(key=>readString(row[key])) && row.user_id===actorId && row.status==='active' && dates(row) && readDate(row.start_date) && readDate(row.end_date) && readNullableString(row.organization_id) && readRecord(row.plan) && planRow(row.plan) && row.plan.id === row.plan_id);
}
export const readJobTypes = (data:unknown) => requireReadRows<JobType>(data,row=>['id','user_id','name'].every(key=>readString(row[key])) && dates(row) && ['description','organization_id','default_department_id','job_group_id'].every(key=>readNullableString(row[key])) && readNumber(row.bonus_amount) && ['counts_for_salary','is_contract','is_repair'].every(key=>typeof row[key]==='boolean') && ['is_active','auto_assign','business_hours_only'].every(key=>nullableBoolean(row[key])) && ['acceptance_deadline','completion_deadline','customer_contact_deadline'].every(key=>nullableNumber(row[key])) && (row.default_priority===null || ['LOW','MEDIUM','HIGH','URGENT'].includes(row.default_priority as string)) && ref(row.job_groups) && ref(row.departments));
export const readDepartments = (data:unknown) => requireReadRows<{id:string;name:string;code:string}>(data,row=>['id','name','code'].every(key=>readString(row[key])));
export const readJobGroups = (data:unknown) => requireReadRows<JobGroup>(data,row=>['id','user_id','name'].every(key=>readString(row[key])) && dates(row) && ['color','description','icon','organization_id'].every(key=>readNullableString(row[key])));
export const readJobs = (data:unknown) => requireReadRows<JobWithRelations>(data,row=>['id','code','title'].every(key=>readString(row[key])) && ['description','building_id','room_id','job_type_id','assignee_id','assignee_name','completion_description'].every(key=>readNullableString(row[key])) && readDate(row.created_at) && [row.deadline,row.completion_time].every(value=>value===null || readDate(value)) && ['NORMAL','LOW','URGENT'].includes(row.priority as string) && ['IN_PROGRESS','COMPLETED'].includes(row.status as string) && (row.attachments === null || Array.isArray(row.attachments) && row.attachments.every(readString)) && ref(row.rooms) && ref(row.job_types) && (row.buildings === null || readRecord(row.buildings) && ref(row.buildings) && nullableNumber(row.buildings.latitude) && nullableNumber(row.buildings.longitude)) && (row.profiles === null || readRecord(row.profiles) && readString(row.profiles.id) && readNullableString(row.profiles.full_name)));

function sameShape(value:unknown,defaults:unknown):boolean {
 if(Array.isArray(defaults)) return Array.isArray(value) && value.every(item=>defaults.length===0 || sameShape(item,defaults[0]));
 if(readRecord(defaults)) return readRecord(value) && Object.entries(defaults).every(([key,item])=>sameShape(value[key],item));
 return typeof value === typeof defaults && (typeof value !== 'number' || Number.isFinite(value));
}
const settingEnums:Record<string,Record<string,readonly string[]>>={contract_config:{payment_cycle_default:['MONTHLY','QUARTERLY','YEARLY']},invoice_config:{late_payment_fee_type:['PERCENTAGE','FIXED','NONE']},payment_config:{default_payment_method:['TM','TK','TT'],allowed_payment_methods:['TM','TK','TT']},notification_config:{enabled_channels:['IN_APP','EMAIL','SMS','ZALO','PUSH'],overdue_reminder_frequency:['DAILY','WEEKLY','NONE']},code_generation_config:{reset_sequence_period:['NEVER','YEARLY','MONTHLY']}};
export function readSetting<T>(data:unknown,key:string,actorId:string,defaults:T):T {
 if(data===null) return defaults;
 const row = requireReadRow<Record<string,unknown>>(data,row=>readString(row.id) && row.key===key && row.user_id===actorId && sameShape(row.value,defaults));
 const value = row.value;
 if(!readRecord(value)) throw new TypeError('Malformed setting value');
 const optional = key==='company_info'?['company_logo_url','bank_name','bank_account_number','bank_account_name']:['contract_template_id','invoice_template_id','receipt_template_id'];
 if(optional.some(field=>value[field] !== undefined && typeof value[field] !== 'string')) throw new TypeError('Malformed setting field');
 for(const [field,allowed] of Object.entries(settingEnums[key]??{})) {
  const actual = value[field];
  if(Array.isArray(actual) ? actual.some(item=>typeof item!=='string'||!allowed.includes(item)) : typeof actual!=='string'||!allowed.includes(actual)) throw new TypeError('Malformed setting choice');
 }
 return value as T;
}
export function readIndividualSetting<T extends boolean|string|number>(data:unknown,defaults:T):T {
 if(data===null) return defaults;
 const row = requireReadRow<Record<string,unknown>>(data,row=>sameShape(row.value,defaults));
 return row.value as T;
}
export function readGeneralSettings<T extends Record<string,boolean|string|number>>(data:unknown,defaults:T):T {
 const rows = requireReadRows<{key:string;value:boolean|string|number}>(data,row=>typeof row.key==='string' && Object.prototype.hasOwnProperty.call(defaults,row.key) && sameShape(row.value,defaults[row.key]));
 if(new Set(rows.map(row=>row.key)).size!==rows.length) throw new TypeError('Duplicate setting rows');
 return Object.assign({},defaults,...rows.map(row=>({[row.key]:row.value})));
}
