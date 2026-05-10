import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import type {
  Contract,
  ContractWithRelations,
  PaymentCycle,
} from "@/types/contract";

// =============================================
// Payload types
// =============================================

export interface CreateContractPayload {
  contract: {
    room_id: string;
    bed_id?: string;
    signed_date: string;
    start_date: string;
    end_date: string;
    rent_price: number;
    total_deposit: number;
    deposit_paid?: number;
    payment_cycle: PaymentCycle;
    start_billing_date?: string;
    contract_template_id?: string;
    invoice_template_id?: string;
    notes?: string;
    discounts?: { months: number; amount_per_month: number };
  };
  customers: { customer_id: string; is_representative: boolean }[];
  services: { service_id: string; unit_price: number; initial_reading?: number }[];
}

export interface UpdateContractPayload {
  room_id?: string;
  bed_id?: string | null;
  signed_date?: string;
  start_date?: string;
  end_date?: string;
  rent_price?: number;
  total_deposit?: number;
  deposit_paid?: number;
  payment_cycle?: PaymentCycle;
  start_billing_date?: string | null;
  contract_template_id?: string | null;
  invoice_template_id?: string | null;
  notes?: string | null;
  discounts?: { months: number; amount_per_month: number } | null;
  expected_move_out_date?: string | null;
  status?: string;
}

// Re-export types for backward compatibility
export type { ContractWithRelations } from "@/types/contract";

// =============================================
// Supabase select string for contracts with full relations
// =============================================

const CONTRACT_SELECT = `
  *,
  room:rooms!contracts_room_id_fkey (
    id, name, building_id,
    building:buildings!rooms_building_id_fkey (
      id, name, type, area_id
    )
  ),
  bed:beds!contracts_bed_id_fkey (
    id, name
  ),
  contract_customers!contract_customers_contract_id_fkey (
    id, contract_id, customer_id, is_representative, notes, created_at, updated_at,
    customer:customers!contract_customers_customer_id_fkey (
      id, full_name, phone, email, id_number
    )
  ),
  contract_services (
    id, contract_id, service_id, unit_price, initial_reading, created_at, updated_at,
    service:services (
      id, name, unit, type, pricing_type
    )
  )
`;

// =============================================
// useContracts — Query all contracts with relations
// Requirements: 2.11, 2.13, 3.1
// =============================================

export const useContracts = () => {
  return useQuery({
    queryKey: ["contracts"],
    queryFn: async (): Promise<ContractWithRelations[]> => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      const { data, error } = await (supabase as any)
        .from("contracts")
        .select(CONTRACT_SELECT)
        .is("deleted_at", null)
        .order("created_at", { ascending: false });

      if (error) {
        console.error("useContracts error:", error);
        throw error;
      }

      return (data || []) as ContractWithRelations[];
    },
  });
};

// =============================================
// useContract — Query single contract with full relations
// Requirements: 3.1, 3.2
// =============================================

export const useContract = (id?: string) => {
  return useQuery({
    queryKey: ["contracts", id],
    queryFn: async (): Promise<ContractWithRelations | null> => {
      if (!id) return null;

      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      const { data, error } = await (supabase as any)
        .from("contracts")
        .select(CONTRACT_SELECT)
        .eq("id", id)
        .single();

      if (error) {
        console.error("useContract error:", error);
        throw error;
      }

      return data as ContractWithRelations;
    },
    enabled: !!id,
  });
};

// =============================================
// useCreateContract — Create contract + customers + services + update room
// Requirements: 2.11, 2.13, 3.3
// =============================================

export const useCreateContract = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (payload: CreateContractPayload) => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      const { contract: contractData, customers, services } = payload;

      // Guard: contract requires at least one customer (representative).
      // Without this, the DB throws "null value in column tenant_id" which is
      // confusing for the user.
      const tenantId =
        customers.find((c) => c.is_representative)?.customer_id ||
        customers[0]?.customer_id;
      if (!tenantId) {
        throw new Error(
          "Vui lòng chọn ít nhất một khách hàng cho hợp đồng (người đại diện)."
        );
      }

      // 1. Insert contract.
      // NOTE: contracts.tenant_id is the legacy column that used to FK to
      // `tenants`. The authoritative customer link is in contract_customers
      // (see Bundle 2). After Bundle 3 the FK is dropped and the column is
      // nullable; we leave it NULL on new rows to avoid confusion. tenantId
      // is still used for the empty-customer guard above.
      void tenantId;
      const insertData: any = {
        ...contractData,
        user_id: user.id,
        tenant_id: null,
        status: "ACTIVE",
      };

      const { data: contract, error: contractError } = await supabase
        .from("contracts")
        .insert(insertData)
        .select()
        .single();

      if (contractError) throw contractError;

      // 2. Batch insert contract_customers
      if (customers.length > 0) {
        const contractCustomers = customers.map((c) => ({
          contract_id: contract.id,
          customer_id: c.customer_id,
          is_representative: c.is_representative,
          notes: c.notes ?? null,
        }));

        const { error: customersError } = await (supabase as any)
          .from("contract_customers")
          .insert(contractCustomers);

        if (customersError) {
          console.error("Error inserting contract_customers:", customersError);
          throw customersError;
        }
      }

      // 3. Batch insert contract_services
      if (services.length > 0) {
        const contractServices = services.map((s) => ({
          contract_id: contract.id,
          service_id: s.service_id,
          unit_price: s.unit_price,
          initial_reading: s.initial_reading ?? null,
        }));

        const { error: servicesError } = await supabase
          .from("contract_services")
          .insert(contractServices);

        if (servicesError) {
          console.error("Error inserting contract_services:", servicesError);
          throw servicesError;
        }
      }

      // 4. Update room status to OCCUPIED
      if (contractData.room_id) {
        const { error: roomError } = await supabase
          .from("rooms")
          .update({ status: "OCCUPIED" } as any)
          .eq("id", contractData.room_id);

        if (roomError) {
          console.error("Error updating room status:", roomError);
        }
      }

      return contract as unknown as Contract;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["contracts"] });
      queryClient.invalidateQueries({ queryKey: ["rooms"] });
      toast.success("Dữ liệu đã được TẠO thành công");
    },
    onError: (error: any) => {
      console.error("Error creating contract:", error);
      if (error?.code === "23503") {
        toast.error("Dữ liệu liên kết không tồn tại");
      } else if (error?.code === "23505") {
        toast.error("Khách hàng này đã được thêm vào hợp đồng");
      } else {
        toast.error(error?.message || "Có lỗi xảy ra. Vui lòng thử lại.");
      }
    },
  });
};

// =============================================
// useUpdateContract — Update contract fields
// Requirements: 3.2, 3.3
// =============================================

export const useUpdateContract = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      id,
      updates,
    }: {
      id: string;
      updates: UpdateContractPayload;
    }) => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      const { data, error } = await supabase
        .from("contracts")
        .update(updates as any)
        .eq("id", id)
        .select()
        .single();

      if (error) throw error;
      return data as unknown as Contract;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["contracts"] });
      if (data?.id) {
        queryClient.invalidateQueries({ queryKey: ["contracts", data.id] });
      }
      toast.success("Dữ liệu đã được CẬP NHẬT thành công");
    },
    onError: (error: any) => {
      console.error("Error updating contract:", error);
      if (error?.code === "23503") {
        toast.error("Dữ liệu liên kết không tồn tại");
      } else {
        toast.error(error?.message || "Có lỗi xảy ra. Vui lòng thử lại.");
      }
    },
  });
};

// =============================================
// useSyncContractCustomers — replace contract_customers for a contract.
// Dùng cho luồng Cập nhật hợp đồng: xoá hết các bản ghi cũ rồi insert lại
// theo danh sách trong form (đại diện, ghi chú, …).
// =============================================

export const useSyncContractCustomers = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      contractId,
      customers,
    }: {
      contractId: string;
      customers: Array<{
        customer_id: string;
        is_representative: boolean;
        notes?: string | null;
      }>;
    }) => {
      const { error: delErr } = await (supabase as any)
        .from("contract_customers")
        .delete()
        .eq("contract_id", contractId);
      if (delErr) throw delErr;

      if (customers.length === 0) return;

      const rows = customers.map((c) => ({
        contract_id: contractId,
        customer_id: c.customer_id,
        is_representative: c.is_representative,
        notes: c.notes ?? null,
      }));

      const { error: insErr } = await (supabase as any)
        .from("contract_customers")
        .insert(rows);
      if (insErr) throw insErr;
    },
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ["contracts"] });
      queryClient.invalidateQueries({ queryKey: ["contracts", vars.contractId] });
    },
  });
};

// =============================================
// useDeleteContract — Delete contract (check financial records first)
// Requirements: 10.1, 10.2, 10.3
// =============================================

export const useDeleteContract = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (contractId: string) => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      // Check for associated invoices
      const { data: invoices, error: invoicesError } = await supabase
        .from("invoices")
        .select("id")
        .eq("contract_id", contractId)
        .limit(1);

      if (invoicesError) throw invoicesError;
      if (invoices && invoices.length > 0) {
        throw new Error(
          "Không thể xóa hợp đồng đã có hoá đơn hoặc bản ghi thanh lý"
        );
      }

      // Check for associated termination records
      const { data: terminations, error: terminationsError } = await supabase
        .from("contract_terminations")
        .select("id")
        .eq("contract_id", contractId)
        .limit(1);

      if (terminationsError) throw terminationsError;
      if (terminations && terminations.length > 0) {
        throw new Error(
          "Không thể xóa hợp đồng đã có hoá đơn hoặc bản ghi thanh lý"
        );
      }

      // Soft-delete the contract
      const { error } = await supabase
        .from("contracts")
        .update({ deleted_at: new Date().toISOString() } as any)
        .eq("id", contractId)
        ;

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["contracts"] });
      toast.success("Hợp đồng đã được xóa thành công");
    },
    onError: (error: any) => {
      console.error("Error deleting contract:", error);
      toast.error(error?.message || "Có lỗi xảy ra. Vui lòng thử lại.");
    },
  });
};

// =============================================
// Legacy exports — backward compatibility for existing consumers
// These will be removed once all consumers are migrated
// =============================================

import type { Database } from "@/integrations/supabase/types";
import { useToast } from "@/hooks/use-toast";
import type { PaginatedData } from "@/hooks/usePagination";

type ContractRow = Database["public"]["Tables"]["contracts"]["Row"];
type ContractUpdate = Database["public"]["Tables"]["contracts"]["Update"];

/** @deprecated Use the new useContracts() instead */
export interface ContractFilters {
  status?: string;
  tenant_id?: string;
  room_id?: string;
  bed_id?: string;
  search?: string;
}

/** @deprecated */
export interface ContractPaginationParams {
  page?: number;
  pageSize?: number;
}

/** @deprecated */
export interface ContractTenantWithRelations {
  id: string;
  tenant_id: string;
  is_representative: boolean;
  move_in_date: string | null;
  tenant: {
    id: string;
    full_name: string;
    phone: string;
    email: string | null;
  };
}

/** @deprecated */
export interface LegacyContractWithRelations extends ContractRow {
  tenant?: {
    id: string;
    full_name: string;
    phone: string;
    email: string | null;
  };
  room?: {
    id: string;
    name: string;
    code: string | null;
    building: {
      id: string;
      name: string;
      code: string | null;
    };
  };
  bed?: {
    id: string;
    name: string;
    code: string | null;
    room: {
      id: string;
      name: string;
      building: {
        id: string;
        name: string;
      };
    };
  };
  contract_services?: Array<{
    id: string;
    service_id: string;
    unit_price: number;
    initial_reading: number | null;
    service: {
      id: string;
      name: string;
      type: string;
      unit: string;
    };
  }>;
  contract_tenants?: ContractTenantWithRelations[];
}

/** @deprecated */
export interface ContractTenantData {
  tenant_id: string;
  is_representative: boolean;
  move_in_date?: string;
}

/** @deprecated */
export interface CreateContractData {
  tenant_id: string;
  room_id?: string;
  bed_id?: string;
  signed_date: string;
  start_date: string;
  start_billing_date?: string;
  end_date: string;
  rent_price: number;
  payment_cycle: string;
  total_deposit: number;
  deposit_paid?: number;
  initial_electricity_reading?: number;
  initial_water_reading?: number;
  notes?: string;
  services?: Array<{
    service_id: string;
    unit_price: number;
    initial_reading?: number;
  }>;
  contract_template_id?: string;
  invoice_template_id?: string;
  discounts?: Array<{
    month: number;
    amount: number;
    reason?: string;
  }>;
  contract_file_url?: string;
  tenants?: ContractTenantData[];
}

/** @deprecated */
export interface ExtendContractData {
  contract_id: string;
  extension_months: number;
  new_rent_price?: number;
  notes?: string;
}

/** @deprecated */
export interface TransferContractData {
  contract_id: string;
  transfer_type: "TENANT_CHANGE" | "ROOM_CHANGE" | "BOTH_CHANGE";
  new_tenant_id?: string;
  new_room_id?: string;
  new_bed_id?: string;
  new_rent_price?: number;
  transfer_fee?: number;
  reason?: string;
}

/** @deprecated */
export interface TerminateContractData {
  contract_id: string;
  termination_type:
    | "NORMAL"
    | "EARLY_TENANT"
    | "EARLY_OWNER"
    | "BREACH"
    | "FORFEIT";
  actual_move_out_date: string;
  early_termination_fee?: number;
  damage_fee?: number;
  damage_description?: string;
  cleaning_fee?: number;
  notes?: string;
}

const LEGACY_CONTRACT_SELECT = `
  *,
  tenant:tenants!contracts_tenant_id_fkey (
    id, full_name, phone, email
  ),
  room:rooms!contracts_room_id_fkey (
    id, name, code,
    building:buildings!rooms_building_id_fkey (
      id, name, code
    )
  ),
  bed:beds!contracts_bed_id_fkey (
    id, name, code,
    room:rooms!beds_room_id_fkey (
      id, name,
      building:buildings!rooms_building_id_fkey (
        id, name
      )
    )
  ),
  contract_tenants (
    id, tenant_id, is_representative, move_in_date,
    tenant:tenants!left (
      id, full_name, phone, email
    )
  )
`;

/** @deprecated Use useContracts() instead */
export const useContractsLegacy = (filters?: {
  status?: string;
  tenant_id?: string;
  room_id?: string;
  bed_id?: string;
}) => {
  return useQuery({
    queryKey: ["contracts-legacy", filters],
    queryFn: async (): Promise<LegacyContractWithRelations[]> => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      let query = supabase
        .from("contracts")
        .select(LEGACY_CONTRACT_SELECT, { count: "exact" })
        .order("created_at", { ascending: false });

      if (filters?.status) query = query.eq("status", filters.status as any);
      if (filters?.tenant_id) query = query.eq("tenant_id", filters.tenant_id);
      if (filters?.room_id) query = query.eq("room_id", filters.room_id);
      if (filters?.bed_id) query = query.eq("bed_id", filters.bed_id);

      const { data, error } = await query;
      if (error) {
        console.error("useContractsLegacy error:", error);
        return [];
      }
      return (data || []) as unknown as LegacyContractWithRelations[];
    },
  });
};

/** @deprecated */
export const useExtendContract = () => {
  const queryClient = useQueryClient();
  const { toast: legacyToast } = useToast();

  return useMutation({
    mutationFn: async (data: ExtendContractData) => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      const { data: extension, error } = await supabase
        .from("contract_extensions")
        .insert([
          {
            user_id: user.id,
            contract_id: data.contract_id,
            extension_months: data.extension_months,
            extension_type: "SIMPLE",
            old_end_date: new Date().toISOString(),
            new_end_date: new Date().toISOString(),
            new_rent_price: data.new_rent_price,
            notes: data.notes,
            status: "DRAFT",
          },
        ])
        .select()
        .single();

      if (error) throw error;
      return extension;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["contracts"] });
      legacyToast({
        title: "Yêu cầu gia hạn đã được tạo thành công",
      });
    },
    onError: (error: Error) => {
      legacyToast({
        variant: "destructive",
        title: "Có lỗi xảy ra khi gia hạn hợp đồng",
        description: error.message,
      });
    },
  });
};

/** @deprecated */
export const useTransferContract = () => {
  const queryClient = useQueryClient();
  const { toast: legacyToast } = useToast();

  return useMutation({
    mutationFn: async (data: TransferContractData) => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      const { data: transfer, error } = await supabase
        .from("contract_transfers")
        .insert([
          {
            user_id: user.id,
            contract_id: data.contract_id,
            transfer_type: data.transfer_type,
            transfer_date: new Date().toISOString(),
            new_tenant_id: data.new_tenant_id,
            new_room_id: data.new_room_id,
            new_bed_id: data.new_bed_id,
            new_rent_price: data.new_rent_price,
            transfer_fee: data.transfer_fee || 0,
            reason: data.reason,
            status: "DRAFT",
          },
        ])
        .select()
        .single();

      if (error) throw error;
      return transfer;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["contracts"] });
      legacyToast({
        title: "Yêu cầu chuyển đổi đã được tạo thành công",
      });
    },
    onError: (error: Error) => {
      legacyToast({
        variant: "destructive",
        title: "Có lỗi xảy ra khi tạo yêu cầu chuyển đổi",
        description: error.message,
      });
    },
  });
};

/** @deprecated */
export const useTerminateContract = () => {
  const queryClient = useQueryClient();
  const { toast: legacyToast } = useToast();

  return useMutation({
    mutationFn: async (data: TerminateContractData) => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      const { data: termination, error } = await supabase
        .from("contract_terminations")
        .insert([
          {
            user_id: user.id,
            contract_id: data.contract_id,
            termination_type: data.termination_type,
            termination_date: new Date().toISOString(),
            total_deposit: 0,
            actual_move_out_date: data.actual_move_out_date,
            early_termination_fee: data.early_termination_fee || 0,
            damage_fee: data.damage_fee || 0,
            damage_description: data.damage_description,
            cleaning_fee: data.cleaning_fee || 0,
            notes: data.notes,
            status: "PENDING_APPROVAL",
          },
        ])
        .select()
        .single();

      if (error) throw error;
      return termination;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["contracts"] });
      queryClient.invalidateQueries({ queryKey: ["pending-terminations"] });
      legacyToast({
        title: "Yêu cầu thanh lý đã được tạo thành công",
      });
    },
    onError: (error: Error) => {
      legacyToast({
        variant: "destructive",
        title: "Có lỗi xảy ra khi tạo yêu cầu thanh lý",
        description: error.message,
      });
    },
  });
};

/** @deprecated */
export const useUnpaidInvoices = (contractId?: string) => {
  return useQuery({
    queryKey: ["unpaid-invoices", contractId],
    queryFn: async () => {
      if (!contractId) return [];
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      const { data, error } = await supabase
        .from("invoices")
        .select("*")
        .eq("contract_id", contractId)
        .in("status", ["APPROVED", "OVERDUE", "PARTIAL_PAID"] as any);

      if (error) throw error;
      return data || [];
    },
    enabled: !!contractId,
  });
};

/** @deprecated */
export const useUploadContractFile = () => {
  return useMutation({
    mutationFn: async ({
      file,
      contractId,
    }: {
      file: File;
      contractId?: string;
    }) => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      const timestamp = Date.now();
      const fileName = `${contractId || timestamp}_${file.name}`;
      const filePath = `${user.id}/${fileName}`;

      const { data, error } = await supabase.storage
        .from("contract-files")
        .upload(filePath, file, { cacheControl: "3600", upsert: false });

      if (error) throw error;

      const {
        data: { publicUrl },
      } = supabase.storage.from("contract-files").getPublicUrl(data.path);

      return {
        path: data.path,
        url: publicUrl,
        fileName: file.name,
        fileSize: file.size,
        fileType: file.name.split(".").pop(),
      };
    },
    onError: (error: any) => {
      toast.error(error?.message || "Có lỗi xảy ra khi tải file lên");
    },
  });
};

/** @deprecated */
export interface TerminationWithRelations {
  id: string;
  user_id: string;
  contract_id: string;
  termination_type: string;
  termination_date: string;
  actual_move_out_date: string;
  status: string;
  outstanding_debt: number;
  prorated_rent: number;
  prorated_services: number;
  early_termination_fee: number;
  damage_fee: number;
  damage_description: string | null;
  cleaning_fee: number;
  other_fees: number;
  other_fees_description: string | null;
  total_deductions: number;
  refund_amount: number;
  total_deposit: number;
  notes: string | null;
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
  contract?: LegacyContractWithRelations;
}

/** @deprecated */
export const usePendingTerminations = () => {
  return useQuery({
    queryKey: ["pending-terminations"],
    queryFn: async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      const { data, error } = await supabase
        .from("contract_terminations")
        .select(
          `
          *,
          contract:contracts(
            *,
            tenant:tenants(id, full_name, phone, email),
            room:rooms(id, name, code, building:buildings(id, name, code)),
            bed:beds(id, name, code, room:rooms(id, name, building:buildings(id, name)))
          )
        `
        )
        .in("status", ["DRAFT", "PENDING_APPROVAL"])
        .order("created_at", { ascending: false });

      if (error) throw error;
      return (data || []) as TerminationWithRelations[];
    },
  });
};

/** @deprecated */
export const useApproveTermination = () => {
  const queryClient = useQueryClient();
  const { toast: legacyToast } = useToast();

  return useMutation({
    mutationFn: async (data: {
      termination_id: string;
      contract_id: string;
      refund_amount: number;
      payment_method?: string;
      notes?: string;
    }) => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      const { error: termError } = await supabase
        .from("contract_terminations")
        .update({
          status: "APPROVED",
          approved_by: user.id,
          approved_at: new Date().toISOString(),
        })
        .eq("id", data.termination_id)
        ;
      if (termError) throw termError;

      const { error: contractError } = await supabase
        .from("contracts")
        .update({
          status: "TERMINATED",
          updated_at: new Date().toISOString(),
        } as any)
        .eq("id", data.contract_id)
        ;
      if (contractError) throw contractError;

      const { error: completeError } = await supabase
        .from("contract_terminations")
        .update({
          status: "COMPLETED",
          refund_date: new Date().toISOString(),
        } as any)
        .eq("id", data.termination_id)
        ;
      if (completeError) throw completeError;

      if (data.refund_amount !== 0) {
        const isRefund = data.refund_amount > 0;
        const { error: cashError } = await (supabase as any)
          .from("cash_book")
          .insert([
            {
              user_id: user.id,
              transaction_date: new Date().toISOString(),
              transaction_type: isRefund ? "EXPENSE" : "INCOME",
              category: isRefund ? "DEPOSIT_REFUND" : "DEPOSIT_FORFEIT",
              amount: Math.abs(data.refund_amount),
              description: isRefund
                ? "Hoàn cọc thanh lý hợp đồng"
                : "Thu thêm từ thanh lý hợp đồng",
              reference_type: "CONTRACT_TERMINATION",
              reference_id: data.termination_id,
              payment_method: data.payment_method || "TM",
              notes: data.notes,
            },
          ]);
        if (cashError) throw cashError;
      }

      const { data: contract } = await supabase
        .from("contracts")
        .select("room_id, bed_id")
        .eq("id", data.contract_id)
        .single();

      if (contract?.room_id) {
        await supabase
          .from("rooms")
          .update({ status: "AVAILABLE" } as any)
          .eq("id", contract.room_id);
      }
      if (contract?.bed_id) {
        await supabase
          .from("beds")
          .update({ status: "AVAILABLE" } as any)
          .eq("id", contract.bed_id);
      }

      return { success: true };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["contracts"] });
      queryClient.invalidateQueries({ queryKey: ["pending-terminations"] });
      queryClient.invalidateQueries({ queryKey: ["rooms"] });
      queryClient.invalidateQueries({ queryKey: ["beds"] });
      legacyToast({
        title: "Hợp đồng đã được thanh lý thành công",
      });
    },
    onError: (error: Error) => {
      legacyToast({
        variant: "destructive",
        title: "Có lỗi xảy ra khi duyệt thanh lý",
        description: error.message,
      });
    },
  });
};

/** @deprecated */
export const useRejectTermination = () => {
  const queryClient = useQueryClient();
  const { toast: legacyToast } = useToast();

  return useMutation({
    mutationFn: async (data: {
      termination_id: string;
      rejection_reason?: string;
    }) => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      const { error } = await supabase
        .from("contract_terminations")
        .update({
          status: "DRAFT",
          notes: data.rejection_reason
            ? `[Từ chối] ${data.rejection_reason}`
            : undefined,
        })
        .eq("id", data.termination_id)
        ;

      if (error) throw error;
      return { success: true };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["contracts"] });
      queryClient.invalidateQueries({ queryKey: ["pending-terminations"] });
      legacyToast({
        title: "Yêu cầu thanh lý đã bị từ chối",
      });
    },
    onError: (error: Error) => {
      legacyToast({
        variant: "destructive",
        title: "Có lỗi xảy ra. Vui lòng thử lại",
        description: error.message,
      });
    },
  });
};

/** @deprecated */
export interface BulkContractImportRow {
  room_name: string;
  bed_name?: string;
  tenant_name: string;
  tenant_phone: string;
  signed_date: string;
  start_date: string;
  end_date: string;
  rent_price: number;
  payment_cycle?: string;
  start_billing_date?: string;
  total_deposit?: number;
  deposit_paid?: number;
  notes?: string;
}

/** @deprecated */
export const useBulkCreateContracts = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      building_id,
      contracts: rows,
    }: {
      building_id: string;
      contracts: BulkContractImportRow[];
    }) => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      const { data: rooms } = await (supabase as any)
        .from("rooms")
        .select("id, name, code")
        .eq("building_id", building_id)
        .is("deleted_at", null);

      if (!rooms) throw new Error("Không thể tải danh sách căn hộ");

      const { data: existingTenants } = await (supabase as any)
        .from("tenants")
        .select("id, full_name, phone")
        .is("deleted_at", null);

      const results = {
        success: 0,
        failed: 0,
        errors: [] as Array<{ row: number; message: string }>,
      };

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const rowNum = i + 2;

        try {
          const room = rooms.find(
            (r) =>
              r.name?.toLowerCase() === row.room_name.toLowerCase() ||
              r.code?.toLowerCase() === row.room_name.toLowerCase()
          );
          if (!room) {
            results.errors.push({
              row: rowNum,
              message: `Không tìm thấy căn hộ "${row.room_name}"`,
            });
            results.failed++;
            continue;
          }

          let tenantId: string;
          const existingTenant = existingTenants?.find(
            (t) => t.phone === row.tenant_phone
          );

          if (existingTenant) {
            tenantId = existingTenant.id;
          } else {
            const { data: newTenant, error: tenantError } = await supabase
              .from("tenants")
              .insert([
                {
                  user_id: user.id,
                  full_name: row.tenant_name,
                  phone: row.tenant_phone,
                },
              ])
              .select()
              .single();

            if (tenantError || !newTenant) {
              results.errors.push({
                row: rowNum,
                message: `Không thể tạo khách hàng: ${tenantError?.message || "Unknown"}`,
              });
              results.failed++;
              continue;
            }
            tenantId = newTenant.id;
            existingTenants?.push({
              id: newTenant.id,
              full_name: row.tenant_name,
              phone: row.tenant_phone,
            });
          }

          const contractInsert: any = {
            user_id: user.id,
            tenant_id: tenantId,
            room_id: room.id,
            signed_date: row.signed_date,
            start_date: row.start_date,
            end_date: row.end_date,
            rent_price: row.rent_price,
            payment_cycle: row.payment_cycle || "MONTHLY",
            total_deposit: row.total_deposit || 0,
            deposit_paid: row.deposit_paid || 0,
            notes: row.notes,
            status: "ACTIVE",
          };

          const { data: contract, error: contractError } = await supabase
            .from("contracts")
            .insert([contractInsert])
            .select()
            .single();

          if (contractError || !contract) {
            results.errors.push({
              row: rowNum,
              message: `Lỗi tạo hợp đồng: ${contractError?.message || "Unknown"}`,
            });
            results.failed++;
            continue;
          }

          await (supabase as any).from("contract_tenants").insert([
            {
              contract_id: contract.id,
              tenant_id: tenantId,
              is_representative: true,
              move_in_date: row.start_date,
            },
          ]);

          results.success++;
        } catch (e: any) {
          results.errors.push({
            row: rowNum,
            message: e.message || "Lỗi không xác định",
          });
          results.failed++;
        }
      }

      return results;
    },
    onSuccess: (results) => {
      queryClient.invalidateQueries({ queryKey: ["contracts"] });
      queryClient.invalidateQueries({ queryKey: ["rooms"] });
      if (results.success > 0) {
        toast.success(
          `Đã tạo ${results.success} hợp đồng.${results.failed > 0 ? ` ${results.failed} thất bại.` : ""}`
        );
      }
      if (results.success === 0 && results.failed > 0) {
        toast.error(`Tất cả ${results.failed} hợp đồng đều gặp lỗi.`);
      }
    },
    onError: (error: any) => {
      toast.error(error?.message || "Có lỗi xảy ra khi nhập dữ liệu");
    },
  });
};

/** @deprecated */
export const useEstimateTerminationCosts = () => {
  return useMutation({
    mutationFn: async (data: {
      contract_id: string;
      move_out_date: string;
      damage_fee?: number;
      cleaning_fee?: number;
      early_termination_fee?: number;
      other_fees?: number;
    }) => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      const { data: contract, error: contractError } = await supabase
        .from("contracts")
        .select(
          `*, contract_services(*, service:services(*))`
        )
        .eq("id", data.contract_id)
        .single();

      if (contractError || !contract) throw new Error("Contract not found");

      const { data: unpaidInvoices } = await supabase
        .from("invoices")
        .select("*")
        .eq("contract_id", data.contract_id)
        .in("status", ["APPROVED", "OVERDUE", "PARTIAL_PAID"] as any);

      const moveOutDate = new Date(data.move_out_date);
      const contractEndDate = new Date(contract.end_date);
      const isEarlyTermination = moveOutDate < contractEndDate;
      const daysEarly = isEarlyTermination
        ? Math.ceil(
            (contractEndDate.getTime() - moveOutDate.getTime()) /
              (1000 * 60 * 60 * 24)
          )
        : 0;

      const monthlyRent = contract.rent_price || 0;
      const daysInMonth = new Date(
        moveOutDate.getFullYear(),
        moveOutDate.getMonth() + 1,
        0
      ).getDate();
      const dailyRentRate = monthlyRent / daysInMonth;
      const dayOfMonth = moveOutDate.getDate();
      const proratedRent = Math.round(dailyRentRate * dayOfMonth);

      let outstandingDebt = 0;
      if (unpaidInvoices) {
        for (const inv of unpaidInvoices) {
          const remaining = inv.total_amount - (inv.paid_amount || 0);
          if (remaining > 0) outstandingDebt += remaining;
        }
      }

      const totalFees =
        (data.early_termination_fee || 0) +
        (data.damage_fee || 0) +
        (data.cleaning_fee || 0) +
        (data.other_fees || 0);

      const totalDeductions = outstandingDebt + proratedRent + totalFees;
      const totalDeposit = contract.total_deposit || 0;
      const refundAmount = totalDeposit - totalDeductions;

      return [
        {
          contract_id: contract.id,
          contract_number: contract.contract_number || "",
          total_deposit: totalDeposit,
          outstanding_debt: outstandingDebt,
          prorated_rent: proratedRent,
          prorated_days: dayOfMonth,
          daily_rent_rate: Math.round(dailyRentRate),
          prorated_services: 0,
          total_fees: totalFees,
          total_deductions: totalDeductions,
          refund_amount: refundAmount,
          is_early_termination: isEarlyTermination,
          days_early: daysEarly,
        },
      ];
    },
    onError: (error: any) => {
      toast.error(error?.message || "Có lỗi xảy ra khi tính toán");
    },
  });
};
