function feedbackRecordName(value:unknown,fallback?:string):string {
 const row=value&&typeof value==='object'?value as {name?:unknown;id?:unknown}:null;
 return typeof row?.name==='string'&&row.name.trim()?row.name: fallback?.trim()||(typeof row?.id==='string'?row.id:'bản ghi');
}
import {rememberTemplateDefaultIntent,matchesTemplateDefaultIntent} from '@/lib/templateDefaultIntent';
import { persistentFinancialWorkflow } from '@/lib/persistentFinancialWorkflow';
import { FinancialWorkflowError } from '@/lib/financialWorkflow';
import { confirmedRecordId, confirmedRecordBatch, recordWriteMessage } from '@/lib/recordWriteOutcome';
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getSessionUser } from "@/lib/authSession";
import { toast } from "sonner";
import { friendlyError } from "@/lib/friendlyError";

export class TemplateDefaultPartialError extends Error {
  constructor(public readonly templateId: string, public readonly previousDefaultIds: readonly string[], public readonly cause: unknown) {
    super(`Các mẫu mặc định trước đã được bỏ chọn, nhưng chưa xác nhận được mẫu ${templateId} làm mặc định. Tải lại danh sách mẫu để đối chiếu trước khi chọn tiếp.`);
    this.name = "TemplateDefaultPartialError";
  }
}

// --- Types ---

export interface IncomeExpenseTemplate {
  id: string;
  user_id: string;
  code: string;
  name: string;
  description: string | null;
  template_file_url: string | null;
  is_default: boolean;
  is_income_template: boolean;
  field_mappings: Record<string, string> | null;
  created_at: string;
  updated_at: string;
}

// --- Query Hooks ---

export const useIncomeExpenseTemplates = (filterIsIncome?: boolean) => {
  return useQuery({
    queryKey: ["income-expense-templates", filterIsIncome],
    queryFn: async (): Promise<IncomeExpenseTemplate[]> => {
      let query = supabase
        .from("income_expense_templates")
        .select("*")
        .is("deleted_at", null)
        .order("name", { ascending: true });

      if (filterIsIncome !== undefined) {
        query = query.eq("is_income_template", filterIsIncome);
      }

      const { data, error } = await query;

      if (error) {
        console.error("useIncomeExpenseTemplates error:", error);
        throw error;
      }

      if (!Array.isArray(data)) throw new Error('Chưa xác nhận được danh sách mẫu in thu chi. Tải lại trước khi chọn.');
      return data as unknown as IncomeExpenseTemplate[];
    },
  });
};

// --- Mutation Hooks ---

export const useCreateIncomeExpenseTemplate = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: {
      name: string;
      description?: string | null;
      template_file_url?: string | null;
      is_default?: boolean;
      is_income_template?: boolean;
      field_mappings?: Record<string, string> | null;
    }) => {
      const user = await getSessionUser();

      if (!user) throw new Error("User not authenticated");

      return persistentFinancialWorkflow('income-expense-template-create').run('create', 'tạo mẫu in thu chi', async () => {
      const { data, error } = await supabase
        .from("income_expense_templates")
        .insert({
          user_id: user.id,
          name: input.name,
          description: input.description ?? null,
          template_file_url: input.template_file_url ?? null,
          is_default: input.is_default ?? false,
          is_income_template: input.is_income_template ?? false,
          field_mappings: input.field_mappings ?? null,
        })
        .select()
        .single();

      if (error) {
        throw error;
      }

      confirmedRecordId(data, 'tạo mẫu in thu chi');
      return data;
      });
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["income-expense-templates"] });
      toast.success(`Đã tạo mẫu in thu chi ${feedbackRecordName(data)}`);
    },
    onError: (error) => {
      queryClient.invalidateQueries({queryKey:['income-expense-templates']});
      if(error instanceof FinancialWorkflowError) {toast.error('Chưa tạo mẫu in thu chi',{description:recordWriteMessage(error,'tạo mẫu in thu chi')});return;}
      const feedback = friendlyError(error, "Chưa tạo được mẫu in thu chi", { operation: "tạo mẫu in thu chi" });
      toast.error(feedback.title, { description: feedback.description });
      console.error("Error creating income expense template:", error);
    },
  });
};

export const useUpdateIncomeExpenseTemplate = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      id,
      updates,
    }: {
      id: string;
      updates: {
        name?: string;
        description?: string | null;
        template_file_url?: string | null;
        is_default?: boolean;
        is_income_template?: boolean;
        field_mappings?: Record<string, string> | null;
      };
    }) => {
      return persistentFinancialWorkflow('income-expense-template-update').run(id, 'cập nhật mẫu in thu chi', async () => {
      const { data, error } = await supabase
        .from("income_expense_templates")
        .update(updates)
        .eq("id", id)
        .select()
        .single();

      if (error) {
        throw error;
      }

      confirmedRecordId(data, 'cập nhật mẫu in thu chi', id);
      return data;
      });
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["income-expense-templates"] });
      toast.success(`Đã cập nhật mẫu in thu chi ${feedbackRecordName(data)}`);
    },
    onError: (error) => {
      queryClient.invalidateQueries({queryKey:['income-expense-templates']});
      if(error instanceof FinancialWorkflowError) {toast.error('Chưa cập nhật mẫu in thu chi',{description:recordWriteMessage(error,'cập nhật mẫu in thu chi')});return;}
      const feedback = friendlyError(error, "Chưa cập nhật được mẫu in thu chi", { operation: "cập nhật mẫu in thu chi" });
      toast.error(feedback.title, { description: feedback.description });
      console.error("Error updating income expense template:", error);
    },
  });
};

export const useDeleteIncomeExpenseTemplate = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      return persistentFinancialWorkflow('income-expense-template-delete').run(id, 'xoá mẫu in thu chi', async () => {
      const { data, error } = await supabase
        .from("income_expense_templates")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", id).select('id,name').single();

      if (error) throw error;
      confirmedRecordId(data, 'xoá mẫu in thu chi', id);
      return data;
      });
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["income-expense-templates"] });
      toast.success(`Đã xóa mẫu in thu chi ${feedbackRecordName(data)}`);
    },
    onError: (error) => {
      queryClient.invalidateQueries({queryKey:['income-expense-templates']});
      if(error instanceof FinancialWorkflowError) {toast.error('Chưa xoá mẫu in thu chi',{description:recordWriteMessage(error,'xoá mẫu in thu chi')});return;}
      const feedback = friendlyError(error, "Chưa xóa được mẫu in thu chi", { operation: "xóa mẫu in thu chi" });
      toast.error(feedback.title, { description: feedback.description });
      console.error("Error deleting income expense template:", error);
    },
  });
};

export const useToggleDefaultTemplate = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      id,
      is_default,
      is_income_template,
    }: {
      id: string;
      is_default: boolean;
      is_income_template: boolean;
    }) => {
      const user = await getSessionUser();

      if (!user) throw new Error("User not authenticated");

      const guard = persistentFinancialWorkflow('income-expense-template-default',{scope:'actor'});
      const readGroup = async () => {
        const {data, error} = await supabase.from('income_expense_templates').select('*')
          .eq('user_id', user.id).eq('is_income_template', is_income_template).is('deleted_at', null);
        if(error) throw error;
        if(!Array.isArray(data) || data.some(row => !row || typeof row.id !== 'string' || !row.id || typeof row.is_default !== 'boolean' || row.user_id !== user.id || row.is_income_template !== is_income_template) || new Set(data.map(row=>row.id)).size !== data.length) throw new Error('Chưa xác nhận đủ mẫu in cùng loại. Tải lại trước khi chọn mặc định.');
        return data as unknown as IncomeExpenseTemplate[];
      };
      return guard.run(`default:${is_income_template}`, 'đổi mẫu in mặc định', async progress => {
        rememberTemplateDefaultIntent(progress.requestKey,{id,is_default,is_income_template});
        const { data: currentDefaults, error: readError } = await supabase.from('income_expense_templates')
          .select('id').eq('user_id', user.id).eq('is_income_template', is_income_template).eq('is_default', true).is('deleted_at', null);
        if(readError) throw readError;
        if(!Array.isArray(currentDefaults) || currentDefaults.some(row=>!row || typeof row.id !== 'string' || !row.id) || new Set(currentDefaults.map(row=>row.id)).size !== currentDefaults.length) throw new FinancialWorkflowError('Chưa tải đủ mẫu mặc định hiện tại. Tải lại trước khi chọn.', 'failure', []);
        const previousDefaultIds = currentDefaults.map(row=>row.id as string);
        if(is_default && previousDefaultIds.length===1 && previousDefaultIds[0]===id) return {id,is_default:true,unchanged:true};
        if(is_default && previousDefaultIds.length) {
          progress.stage='bỏ mẫu mặc định trước';
          const {data:unset,error:unsetError}=await supabase.from('income_expense_templates').update({is_default:false})
            .eq('user_id',user.id).eq('is_income_template',is_income_template).in('id',previousDefaultIds).is('deleted_at',null).select('id, is_default');
          if(unsetError) throw unsetError;
          const ids=confirmedRecordBatch(unset,previousDefaultIds.length,'bỏ mẫu mặc định trước');
          progress.completed.push(...ids.map(savedId=>({id:savedId,label:'Mẫu đã bỏ mặc định'})));
          if(ids.some(savedId=>!previousDefaultIds.includes(savedId)) || (unset as Array<{is_default:unknown}>).some(row=>row.is_default!==false)) throw new FinancialWorkflowError('Chưa xác nhận đủ các mẫu đã bỏ mặc định. Đối chiếu danh sách trước khi chọn tiếp.','partial',progress.completed);
        }
        progress.stage='chọn mẫu mặc định';
        const {data,error}=await supabase.from('income_expense_templates').update({is_default})
          .eq('id',id).eq('user_id',user.id).eq('is_income_template',is_income_template).is('deleted_at',null).select().single();
        if (!error || progress.completed.length) progress.completed.push({id,label:`Mẫu yêu cầu mặc định:${is_default}`});
        if(error) throw error;
        confirmedRecordId(data,'đổi mẫu mặc định',id);
        const saved=data as unknown as IncomeExpenseTemplate;
        if(saved.is_default!==is_default || saved.is_income_template!==is_income_template || saved.user_id!==user.id) throw new FinancialWorkflowError('Chưa xác nhận mẫu có đúng trạng thái mặc định đã chọn. Đối chiếu danh sách trước khi chọn tiếp.','unknown',[{id,label:'Mẫu cần đối chiếu'}]);
        return {...saved,unchanged:false};
      }, async pending => {
        if(!matchesTemplateDefaultIntent(pending.requestKey,{id,is_default,is_income_template})) return null;
        const rows=await readGroup();const target=rows.find(row=>row.id===id);
        if(!target || target.is_default!==is_default || (is_default && rows.some(row=>row.id!==id && row.is_default))) return null;
        return {result:{...target,unchanged:false}};
      });
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["income-expense-templates"] });
      if (result.unchanged) toast.info(`Mẫu ${feedbackRecordName(result)} đã có trạng thái mặc định được chọn`);
      else toast.success(`${result.is_default ? "Đã chọn mẫu in mặc định" : "Đã bỏ chọn mẫu in mặc định"} ${feedbackRecordName(result)}`);
    },
    onError: (error) => {
      if (error instanceof FinancialWorkflowError) {
        queryClient.invalidateQueries({queryKey:['income-expense-templates']});
        toast.error('Chưa hoàn tất đổi mẫu mặc định', {description:recordWriteMessage(error,'đổi mẫu mặc định')});
      } else if (error instanceof TemplateDefaultPartialError) {
        queryClient.invalidateQueries({ queryKey: ["income-expense-templates"] });
        toast.error("Mẫu mặc định mới cập nhật một phần", { description: error.message });
      } else {
        const feedback = friendlyError(error, "Chưa đổi được mẫu in mặc định", { operation: "đổi mẫu in mặc định" });
        toast.error(feedback.title, { description: feedback.description });
      }
      console.error("Error toggling default template:", error);
    },
  });
};
