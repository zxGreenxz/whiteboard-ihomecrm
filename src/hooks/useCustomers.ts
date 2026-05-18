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

// Resolve building/room/bed filter → customer IDs.
// contracts has no customer_id (link is via contract_customers) and no
// building_id (building is reached via rooms.building_id). Returns [] when
// nothing matches so callers can short-circuit.
async function resolveCustomerIdsByLocation(filters: {
  building_id?: string;
  room_id?: string;
  bed_id?: string;
}): Promise<string[]> {
  let contractIds: string[] = [];

  const sb = supabase as any;

  if (filters.bed_id) {
    const { data } = await sb
      .from("contracts")
      .select("id")
      .eq("bed_id", filters.bed_id)
      .is("deleted_at", null);
    contractIds = ((data || []) as any[]).map((c) => c.id);
  } else if (filters.room_id) {
    const { data: beds } = await sb
      .from("beds")
      .select("id")
      .eq("room_id", filters.room_id);
    const bedIds = ((beds || []) as any[]).map((b) => b.id);
    let q = sb.from("contracts").select("id").is("deleted_at", null);
    q = bedIds.length > 0
      ? q.or(`room_id.eq.${filters.room_id},bed_id.in.(${bedIds.join(",")})`)
      : q.eq("room_id", filters.room_id);
    const { data } = await q;
    contractIds = ((data || []) as any[]).map((c) => c.id);
  } else if (filters.building_id) {
    const { data: rooms } = await sb
      .from("rooms")
      .select("id")
      .eq("building_id", filters.building_id);
    const roomIds = ((rooms || []) as any[]).map((r) => r.id);
    if (roomIds.length === 0) return [];
    const { data: beds } = await sb
      .from("beds")
      .select("id")
      .in("room_id", roomIds);
    const bedIds = ((beds || []) as any[]).map((b) => b.id);
    let q = sb.from("contracts").select("id").is("deleted_at", null);
    q = bedIds.length > 0
      ? q.or(`room_id.in.(${roomIds.join(",")}),bed_id.in.(${bedIds.join(",")})`)
      : q.in("room_id", roomIds);
    const { data } = await q;
    contractIds = ((data || []) as any[]).map((c) => c.id);
  }

  if (contractIds.length === 0) return [];

  const { data: links } = await sb
    .from("contract_customers")
    .select("customer_id")
    .in("contract_id", contractIds);
  return [
    ...new Set(
      ((links || []) as any[]).map((l) => l.customer_id).filter(Boolean) as string[]
    ),
  ];
}

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

      // Filter by building/room/bed via contract_customers junction table
      if (filters?.building_id || filters?.room_id || filters?.bed_id) {
        const customerIds = await resolveCustomerIdsByLocation({
          building_id: filters.building_id,
          room_id: filters.room_id,
          bed_id: filters.bed_id,
        });
        if (customerIds.length === 0) return { data: [], count: 0 };
        query = query.in("id", customerIds);
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

      const customers = (data || []) as Customer[];

      // Enrich with current room/building from latest ACTIVE contract.
      // Done as a follow-up query because PostgREST embed paths get
      // unwieldy through contract_customers. Cũng kèm building.id để FE
      // dùng check building scope (ẩn nút Sửa/Xoá khi không quản lý tòa).
      if (customers.length > 0) {
        const ids = customers.map((c) => c.id);
        const CHUNK = 80;
        const map = new Map<
          string,
          { building_id: string | null; building_name: string; room_name: string }
        >();
        for (let i = 0; i < ids.length; i += CHUNK) {
          const slice = ids.slice(i, i + CHUNK).join(',');
          const { data: links } = await (supabase
            .from("contract_customers")
            .select(
              `customer_id,
               contract:contracts!contract_customers_contract_id_fkey (
                 status, end_date,
                 room:rooms!contracts_room_id_fkey (
                   name,
                   building:buildings!rooms_building_id_fkey ( id, name )
                 )
               )`
            ) as any)
            .in('customer_id', slice.split(','));
          for (const l of (links || []) as any[]) {
            if (!l.contract || l.contract.status !== 'ACTIVE') continue;
            const bid = l.contract.room?.building?.id || null;
            const bn = l.contract.room?.building?.name || '';
            const rn = l.contract.room?.name || '';
            if (!bid && !bn && !rn) continue;
            // Prefer the most recent contract if multiple
            const prev = map.get(l.customer_id);
            if (!prev) map.set(l.customer_id, { building_id: bid, building_name: bn, room_name: rn });
          }
        }
        for (const c of customers) {
          const cur = map.get(c.id);
          (c as any).current_building_id = cur?.building_id || null;
          (c as any).current_building_name = cur?.building_name || null;
          (c as any).current_room_name = cur?.room_name || null;
        }
      }

      return {
        data: customers,
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
        .is("deleted_at", null);

      // Apply status filter
      if (filters?.status) {
        baseQuery = baseQuery.eq("status_v2", filters.status) as any;
      }

      // Apply location filters via contract_customers junction table
      if (filters?.building_id || filters?.room_id || filters?.bed_id) {
        const customerIds = await resolveCustomerIdsByLocation({
          building_id: filters.building_id,
          room_id: filters.room_id,
          bed_id: filters.bed_id,
        });
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
      const { error } = await supabase.rpc('soft_delete_customer' as any, {
        p_customer_id: id,
      });

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
