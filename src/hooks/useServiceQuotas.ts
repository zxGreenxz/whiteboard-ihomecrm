// Re-export service quota hooks from useServices for backward compatibility
export {
  useServiceQuotas,
  useCreateServiceQuota,
  useUpdateServiceQuota,
  useDeleteServiceQuota,
  type ServiceQuotaWithTiers,
} from "./useServices";
