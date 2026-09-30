import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getSessionUser } from "@/lib/authSession";
import { toast } from "sonner";
import type { CT01Declaration, CT01FormData } from "@/types/customer";
import { persistentFinancialWorkflow } from "@/lib/persistentFinancialWorkflow";
import { confirmedRecordId, recordWriteMessage } from "@/lib/recordWriteOutcome";

// =============================================
// useCT01Declarations - Query declarations for a customer
// Requirements: 6.5
// =============================================

export const useCT01Declarations = (customerId: string) => {
  return useQuery({
    queryKey: ["ct01-declarations", customerId],
    queryFn: async (): Promise<CT01Declaration[]> => {
      const user = await getSessionUser();
      if (!user) throw new Error("Not authenticated");

      const { data, error } = await (supabase
        .from("ct01_declarations") as any)
        .select("*")
        .eq("customer_id", customerId)
        .order("created_at", { ascending: false });

      if (error) {
        console.error("useCT01Declarations error:", error);
        throw error;
      }

      if (!Array.isArray(data)) throw new Error("Chưa tải được tờ khai CT01.");
      return data as CT01Declaration[];
    },
    enabled: !!customerId,
  });
};

// =============================================
// useCreateCT01Declaration - Insert mutation
// Requirements: 6.5
// =============================================

export const useCreateCT01Declaration = () => {
  const queryClient = useQueryClient();
  const guard = persistentFinancialWorkflow("ct01-declaration-create", { scope: "actor" });

  return useMutation({
    mutationFn: async ({
      customerId,
      data: formData,
    }: {
      customerId: string;
      data: CT01FormData;
    }) => {
      const user = await getSessionUser();
      if (!user) throw new Error("Not authenticated");

      return guard.run(customerId, "lưu tờ khai CT01", async (progress) => {
      const { data, error } = await (supabase
        .from("ct01_declarations") as any)
        .insert({
          ...formData,
          user_id: user.id,
          customer_id: customerId,
        })
        .select()
        .single();

      if (error) throw error;
      const id = confirmedRecordId(data, "lưu tờ khai CT01");
      progress.completed.push({ id, label: "Tờ khai CT01 đã nhận mã" });
      return data as CT01Declaration;
      });
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: ["ct01-declarations", variables.customerId],
      });
      toast.success("Đã lưu tờ khai CT01");
    },
    onError: (error: unknown) => {
      toast.error(recordWriteMessage(error, "lưu tờ khai CT01"));
      console.error("Error creating CT01 declaration:", error);
    },
  });
};
