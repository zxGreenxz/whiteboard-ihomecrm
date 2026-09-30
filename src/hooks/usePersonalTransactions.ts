import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getSessionUser } from "@/lib/authSession";
import { toast } from "sonner";
import { FinancialWorkflowGuard, FinancialWorkflowError } from '@/lib/financialWorkflow';
import { confirmedRecordId, recordWriteMessage } from '@/lib/recordWriteOutcome';
// Personal wallet belongs to the actor across organizations (RLS own-only).
const personalGuard=(namespace:string)=>new FinancialWorkflowGuard({scope:async businessKey=>{const user=await getSessionUser();if(!user)throw {code:'PGRST301'};return {namespace,userId:user.id,organizationId:'personal',businessKey};}});
function validatePersonalValues(values:PersonalTransactionFormValues){
  const date=new Date(`${values.txn_date}T00:00:00Z`);
  if(!Number.isFinite(values.amount)||values.amount<=0)throw new FinancialWorkflowError('Số tiền phải lớn hơn 0.','failure',[]);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(values.txn_date)||Number.isNaN(date.getTime())||date.toISOString().slice(0,10)!==values.txn_date)throw new FinancialWorkflowError('Chọn ngày giao dịch hợp lệ.','failure',[]);
}

export interface PersonalTransaction {
  id: string;
  user_id: string;
  type: "INCOME" | "EXPENSE";
  amount: number;
  description: string | null;
  txn_date: string; // YYYY-MM-DD
  category: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface PersonalTransactionFormValues {
  type: "INCOME" | "EXPENSE";
  amount: number;
  txn_date: string;
  category?: string | null;
  description?: string | null;
}

// Danh sách giao dịch ví cá nhân của chính user (RLS own-only).
export const usePersonalTransactions = () => {
  return useQuery({
    queryKey: ["personal-transactions"],
    queryFn: async () => {
      const { data, error } = await (supabase
        .from("personal_transactions" as any)
        .select("*") as any)
        .is("deleted_at", null)
        .order("txn_date", { ascending: false })
        .order("created_at", { ascending: false });
      if (error) {
        throw error;
      }
      if (!Array.isArray(data)) throw new Error('Chưa xác nhận được danh sách ví cá nhân. Tải lại ví trước khi đối chiếu số dư.');
      return (data as any[]).map((r) => {
        const amount = Number(r.amount);
        if ((typeof r.amount!=='number' && (typeof r.amount!=='string' || !r.amount.trim())) || !Number.isFinite(amount)) throw new Error('Số tiền giao dịch không hợp lệ; cần tải lại ví để đối chiếu.');
        return { ...r, amount };
      }) as PersonalTransaction[];
    },
  });
};

export const useCreatePersonalTransaction = () => {
  const qc = useQueryClient();
  const guard=personalGuard('personal-transaction-create');
  return useMutation({
    meta:{handlesFeedback:true},
    mutationFn: async (values: PersonalTransactionFormValues) => {
      validatePersonalValues(values);
      const auth = { user: await getSessionUser() };
      if (!auth.user) throw new Error("User not authenticated");
      const user = auth.user;
      return guard.run('create','thêm khoản vào ví cá nhân',async()=>{
      const { data, error } = await supabase
        .from("personal_transactions" as any)
        .insert({
          user_id: user.id,
          type: values.type,
          amount: values.amount,
          txn_date: values.txn_date,
          category: values.category ?? null,
          description: values.description ?? null,
        })
        .select()
        .single();
      if (error) throw error;
      confirmedRecordId(data,'thêm khoản vào ví cá nhân');
      if((data as unknown as {user_id?:string}).user_id!==user.id)throw new FinancialWorkflowError('Chưa xác nhận khoản này thuộc ví của bạn. Đối chiếu trước khi tạo tiếp.','unknown',[]);
      return data;
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["personal-transactions"] });
      toast.success("Đã thêm khoản");
    },
    onError: error => { qc.invalidateQueries({ queryKey: ['personal-transactions'] }); toast.error('Chưa thêm được khoản vào ví cá nhân', {description:recordWriteMessage(error,'thêm khoản vào ví cá nhân')}); },
  });
};

export const useUpdatePersonalTransaction = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; values: PersonalTransactionFormValues }) => {
      validatePersonalValues(input.values);
      const { data, error } = await supabase
        .from("personal_transactions" as any)
        .update({
          type: input.values.type,
          amount: input.values.amount,
          txn_date: input.values.txn_date,
          category: input.values.category ?? null,
          description: input.values.description ?? null,
        })
        .eq("id", input.id)
        .select('id')
        .single();
      if (error) throw error;
      confirmedRecordId(data,'cập nhật khoản ví cá nhân',input.id);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["personal-transactions"] });
      toast.success("Đã cập nhật khoản");
    },
    onError: error => { qc.invalidateQueries({ queryKey: ['personal-transactions'] }); toast.error('Chưa cập nhật được khoản trong ví cá nhân', {description:recordWriteMessage(error,'cập nhật khoản trong ví cá nhân')}); },
  });
};

export const useDeletePersonalTransaction = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await supabase
        .from("personal_transactions" as any)
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", id)
        .select('id')
        .single();
      if (error) throw error;
      confirmedRecordId(data,'xóa khoản ví cá nhân',id);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["personal-transactions"] });
      toast.success("Đã xoá khoản");
    },
    onError: error => { qc.invalidateQueries({ queryKey: ['personal-transactions'] }); toast.error('Chưa xóa được khoản trong ví cá nhân', {description:recordWriteMessage(error,'xóa khoản trong ví cá nhân')}); },
  });
};
