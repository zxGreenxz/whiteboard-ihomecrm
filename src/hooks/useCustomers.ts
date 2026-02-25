import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import type {
  Customer,
  CustomerFilters,
  CustomerStats,
  CustomerFormData,
} from "@/types/customer";
import type { PaginatedData, PaginationParams } from "@/hooks/usePagination";

// =============================================
// useCustomers - Query customers with filters and pagination
// Requirements: 1.1, 1.5, 1.6, 1.9
// =============================================

export const useCustomers = (
  filters?: CustomerFilters,
  pagination?: { page: number; pageSize: number }
) => {
  return useQuery({
    queryKey: ["customers", filters, pagination],
    queryFn: async (): Promise<PaginatedData<Customer>> => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      let query = (supabase
        .from("customers")
        .select("*", { count: "exact" }) as any)
        .eq("user_id", user.id)
        .is("deleted_at", null)
        .order("created_at", { ascending: false });

      // Filter by status_v2
      if (filters?.status) {
        query = query.eq("status_v2", filters.status);
      }

      // Filter by stat type
      if (filters?.statFilter && filters.statFilter !== "ALL") {
        if (filters.statFilter === "INDIVIDUAL") {
          query = query.eq("customer_type", "INDIVIDUAL");
        } else if (filters.statFilter === "ORGANIZATION") {
          query = query.eq("customer_type", "ORGANIZATION");
        } else if (filters.statFilter === "FOREIGN") {
          query = query.eq("is_foreign", true);
        }
      }

      // Search by name, phone, email, id_number
      if (filters?.search) {
        const search = filters.search.trim();
        if (search) {
          query = query.or(
            `full_name.ilike.%${search}%,phone.ilike.%${search}%,email.ilike.%${search}%,id_number.ilike.%${search}%`
          );
        }
      }

      // Filter by building/room/bed via contracts table
      // Customers with active contracts in those locations
      if (filters?.building_id || filters?.room_id || filters?.bed_id) {
        // We need to find customer IDs that have contracts in the specified location
        let contractQuery = supabase
          .from("contracts")
          .select("customer_id")
          .is("deleted_at", null);

        if (filters.building_id) {
          contractQuery = contractQuery.eq("building_id", filters.building_id);
        }
        if (filters.room_id) {
          contractQuery = contractQuery.eq("room_id", filters.room_id);
        }
        if (filters.bed_id) {
          contractQuery = contractQuery.eq("bed_id", filters.bed_id);
        }

        const { data: contractData } = await contractQuery;
        const customerIds = [
          ...new Set(
            (contractData || [])
              .map((c: any) => c.customer_id)
              .filter(Boolean)
          ),
        ];

        if (customerIds.length > 0) {
          query = query.in("id", customerIds);
        } else {
          // No customers match the location filter
          return { data: [], count: 0 };
        }
      }

      // Apply pagination
      if (pagination?.page && pagination?.pageSize) {
        const offset = (pagination.page - 1) * pagination.pageSize;
        query = query.range(offset, offset + pagination.pageSize - 1);
      }

      const { data, error, count } = await query;
      if (error) {
        console.error("useCustomers error:", error);
        return { data: [], count: 0 };
      }

      return {
        data: (data || []) as Customer[],
        count: count || 0,
      };
    },
  });
};

// =============================================
// useCustomer - Single customer query
// =============================================

export const useCustomer = (id: string) => {
  return useQuery({
    queryKey: ["customers", id],
    queryFn: async (): Promise<Customer | null> => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      const { data, error } = await supabase
        .from("customers")
        .select("*")
        .eq("id", id)
        .eq("user_id", user.id)
        .is("deleted_at", null)
        .single();

      if (error) {
        console.error("useCustomer error:", error);
        throw error;
      }

      return data as Customer;
    },
    enabled: !!id,
  });
};

// =============================================
// useCustomerStats - Count total, individual, organization, foreign
// Requirements: 1.2, 1.3
// =============================================

export const useCustomerStats = (filters?: CustomerFilters) => {
  return useQuery({
    queryKey: ["customer-stats", filters],
    queryFn: async (): Promise<CustomerStats> => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      let baseQuery = supabase
        .from("customers")
        .select("id, customer_type, is_foreign", { count: "exact" })
        .eq("user_id", user.id)
        .is("deleted_at", null);

      // Apply status filter
      if (filters?.status) {
        baseQuery = baseQuery.eq("status_v2", filters.status) as any;
      }

      // Apply location filters via contracts
      let customerIds: string[] | null = null;
      if (filters?.building_id || filters?.room_id || filters?.bed_id) {
        let contractQuery = supabase
          .from("contracts")
          .select("customer_id")
          .is("deleted_at", null);

        if (filters.building_id) {
          contractQuery = contractQuery.eq("building_id", filters.building_id);
        }
        if (filters.room_id) {
          contractQuery = contractQuery.eq("room_id", filters.room_id);
        }
        if (filters.bed_id) {
          contractQuery = contractQuery.eq("bed_id", filters.bed_id);
        }

        const { data: contractData } = await contractQuery;
        customerIds = [
          ...new Set(
            (contractData || [])
              .map((c: any) => c.customer_id)
              .filter(Boolean)
          ),
        ];

        if (customerIds.length === 0) {
          return { total: 0, individual: 0, organization: 0, foreign: 0 };
        }
        baseQuery = baseQuery.in("id", customerIds) as any;
      }

      // Apply search filter
      if (filters?.search) {
        const search = filters.search.trim();
        if (search) {
          baseQuery = baseQuery.or(
            `full_name.ilike.%${search}%,phone.ilike.%${search}%,email.ilike.%${search}%,id_number.ilike.%${search}%`
          ) as any;
        }
      }

      const { data, error } = await baseQuery;
      if (error) {
        console.error("useCustomerStats error:", error);
        return { total: 0, individual: 0, organization: 0, foreign: 0 };
      }

      const customers = data || [];
      return {
        total: customers.length,
        individual: customers.filter(
          (c: any) => c.customer_type === "INDIVIDUAL"
        ).length,
        organization: customers.filter(
          (c: any) => c.customer_type === "ORGANIZATION"
        ).length,
        foreign: customers.filter((c: any) => c.is_foreign === true).length,
      };
    },
  });
};

// =============================================
// useCreateCustomer - Insert mutation
// Requirements: 2.10, 2.12
// =============================================

export const useCreateCustomer = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (formData: CustomerFormData) => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      // Separate inline vehicles from customer data
      const { vehicles, ...customerData } = formData;

      const { data, error } = await supabase
        .from("customers")
        .insert({
          ...customerData,
          user_id: user.id,
          status_v2: "RENTING",
        } as any)
        .select()
        .single();

      if (error) throw error;

      // Create inline vehicles if any
      if (vehicles && vehicles.length > 0 && data) {
        const vehicleInserts = vehicles.map((v) => ({
          user_id: user.id,
          customer_id: (data as any).id,
          vehicle_type: v.vehicle_type,
          vehicle_name: v.vehicle_name,
          license_plate: v.license_plate,
        }));

        await supabase.from("vehicles").insert(vehicleInserts as any);
      }

      return data as unknown as Customer;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["customers"] });
      queryClient.invalidateQueries({ queryKey: ["customer-stats"] });
      toast.success("Dữ liệu đã được TẠO thành công");
    },
    onError: (error: any) => {
      if (error?.code === "23505") {
        toast.error("Số điện thoại hoặc CCCD đã tồn tại");
      } else if (error?.code === "23503") {
        toast.error("Dữ liệu liên quan không tồn tại");
      } else {
        toast.error("Có lỗi xảy ra. Vui lòng thử lại.");
      }
      console.error("Error creating customer:", error);
    },
  });
};

// =============================================
// useUpdateCustomer - Update mutation
// Requirements: 5.2
// =============================================

export const useUpdateCustomer = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      id,
      data: formData,
    }: {
      id: string;
      data: Partial<CustomerFormData>;
    }) => {
      // Remove vehicles from update payload (handled separately)
      const { vehicles, ...customerData } = formData;

      const { data, error } = await supabase
        .from("customers")
        .update(customerData as any)
        .eq("id", id)
        .select()
        .single();

      if (error) throw error;
      return data as unknown as Customer;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["customers"] });
      queryClient.invalidateQueries({ queryKey: ["customer-stats"] });
      if (data?.id) {
        queryClient.invalidateQueries({ queryKey: ["customers", data.id] });
      }
      toast.success("Dữ liệu đã được CẬP NHẬT thành công");
    },
    onError: (error: any) => {
      if (error?.code === "23505") {
        toast.error("Số điện thoại hoặc CCCD đã tồn tại");
      } else if (error?.code === "23503") {
        toast.error("Dữ liệu liên quan không tồn tại");
      } else {
        toast.error("Có lỗi xảy ra. Vui lòng thử lại.");
      }
      console.error("Error updating customer:", error);
    },
  });
};

// =============================================
// useDeleteCustomer - Soft-delete mutation
// Requirements: 5.4
// =============================================

export const useDeleteCustomer = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      const { error } = await supabase
        .from("customers")
        .update({ deleted_at: new Date().toISOString() } as any)
        .eq("id", id)
        .eq("user_id", user.id);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["customers"] });
      queryClient.invalidateQueries({ queryKey: ["customer-stats"] });
      toast.success("Dữ liệu đã được XOÁ thành công");
    },
    onError: (error: any) => {
      if (error?.code === "23503") {
        toast.error("Dữ liệu liên quan không tồn tại");
      } else {
        toast.error("Có lỗi xảy ra. Vui lòng thử lại.");
      }
      console.error("Error deleting customer:", error);
    },
  });
};
