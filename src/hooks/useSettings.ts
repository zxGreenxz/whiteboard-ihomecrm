import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from './useAuth';
import { toast } from 'sonner';

// Setting Keys
export type SettingKey =
  | 'company_info'
  | 'contract_config'
  | 'invoice_config'
  | 'payment_config'
  | 'notification_config'
  | 'code_generation_config';

// Types for different settings
export interface CompanyInfo {
  company_name: string;
  company_address: string;
  company_phone: string;
  company_email: string;
  company_tax_code?: string;
  company_logo_url?: string;
  bank_name?: string;
  bank_account_number?: string;
  bank_account_name?: string;
}

export interface ContractConfig {
  // Cấu hình hợp đồng (11 options)
  require_deposit: boolean; // Bắt buộc đặt cọc
  deposit_percentage: number; // % tiền cọc (default: 100%)
  allow_partial_deposit: boolean; // Cho phép đặt cọc một phần
  contract_template_id?: string; // Template mặc định
  auto_generate_contract_number: boolean; // Tự động tạo mã HĐ
  contract_number_prefix: string; // Tiền tố mã HĐ (e.g., "HD")
  contract_number_format: string; // Format: {prefix}{year}{month}{seq}
  payment_cycle_default: 'MONTHLY' | 'QUARTERLY' | 'YEARLY'; // Kỳ thanh toán mặc định
  auto_create_invoice: boolean; // Tự động tạo hóa đơn sau khi ký HĐ
  allow_contract_transfer: boolean; // Cho phép nhượng HĐ
  require_approval_for_termination: boolean; // Yêu cầu duyệt khi thanh lý
}

export interface InvoiceConfig {
  // Cấu hình hóa đơn (9 options)
  auto_generate_invoice_number: boolean;
  invoice_number_prefix: string; // e.g., "INV"
  invoice_number_format: string; // {prefix}{year}{month}{seq}
  payment_due_days: number; // Số ngày đến hạn thanh toán (default: 7)
  include_previous_debt: boolean; // Gộp nợ cũ vào hóa đơn mới
  late_payment_fee_type: 'PERCENTAGE' | 'FIXED' | 'NONE';
  late_payment_fee_value: number; // % hoặc số tiền cố định
  allow_partial_payment: boolean; // Cho phép thanh toán một phần
  invoice_template_id?: string; // Template mặc định
}

export interface PaymentConfig {
  // Cấu hình thanh toán
  allowed_payment_methods: ('TM' | 'TK' | 'TT')[];
  default_payment_method: 'TM' | 'TK' | 'TT';
  auto_send_receipt: boolean; // Tự động gửi biên lai
  receipt_template_id?: string;
}

export interface NotificationConfig {
  // Cấu hình thông báo
  enabled_channels: ('IN_APP' | 'EMAIL' | 'SMS' | 'ZALO' | 'PUSH')[];
  invoice_reminder_days: number[]; // Nhắc trước X ngày (e.g., [7, 3, 1])
  contract_expiry_reminder_days: number[]; // Nhắc HĐ hết hạn (e.g., [30, 15, 7])
  overdue_reminder_frequency: 'DAILY' | 'WEEKLY' | 'NONE'; // Tần suất nhắc quá hạn
  send_payment_confirmation: boolean; // Gửi xác nhận khi thanh toán
  send_issue_updates: boolean; // Gửi cập nhật công việc
}

export interface CodeGenerationConfig {
  // Cấu hình tự động tạo mã
  building_code_format: string; // e.g., "B{seq:3}"
  room_code_format: string; // e.g., "{building}{floor}{seq:2}"
  contract_code_format: string; // e.g., "HD{year}{month}{seq:4}"
  invoice_code_format: string; // e.g., "INV{year}{month}{seq:4}"
  reset_sequence_period: 'NEVER' | 'YEARLY' | 'MONTHLY';
}

// Default values
const DEFAULT_COMPANY_INFO: CompanyInfo = {
  company_name: 'iHomeCRM',
  company_address: '',
  company_phone: '',
  company_email: '',
};

const DEFAULT_CONTRACT_CONFIG: ContractConfig = {
  require_deposit: true,
  deposit_percentage: 100,
  allow_partial_deposit: true,
  auto_generate_contract_number: true,
  contract_number_prefix: 'HD',
  contract_number_format: '{prefix}{year}{month}{seq:4}',
  payment_cycle_default: 'MONTHLY',
  auto_create_invoice: true,
  allow_contract_transfer: true,
  require_approval_for_termination: false,
};

const DEFAULT_INVOICE_CONFIG: InvoiceConfig = {
  auto_generate_invoice_number: true,
  invoice_number_prefix: 'INV',
  invoice_number_format: '{prefix}{year}{month}{seq:4}',
  payment_due_days: 7,
  include_previous_debt: true,
  late_payment_fee_type: 'NONE',
  late_payment_fee_value: 0,
  allow_partial_payment: true,
};

const DEFAULT_PAYMENT_CONFIG: PaymentConfig = {
  allowed_payment_methods: ['TM', 'TK', 'TT'],
  default_payment_method: 'TM',
  auto_send_receipt: false,
};

const DEFAULT_NOTIFICATION_CONFIG: NotificationConfig = {
  enabled_channels: ['IN_APP', 'EMAIL'],
  invoice_reminder_days: [7, 3, 1],
  contract_expiry_reminder_days: [30, 15, 7],
  overdue_reminder_frequency: 'WEEKLY',
  send_payment_confirmation: true,
  send_issue_updates: true,
};

const DEFAULT_CODE_GENERATION_CONFIG: CodeGenerationConfig = {
  building_code_format: 'B{seq:3}',
  room_code_format: '{building}{floor}{seq:2}',
  contract_code_format: 'HD{year}{month}{seq:4}',
  invoice_code_format: 'INV{year}{month}{seq:4}',
  reset_sequence_period: 'YEARLY',
};

/**
 * Generic hook to fetch a setting by key
 */
function useSetting<T>(key: SettingKey, defaultValue: T) {
  const { data: user } = useAuth();

  return useQuery({
    queryKey: ['settings', key, user?.id],
    queryFn: async () => {
      if (!user?.id) throw new Error('User not authenticated');

      const { data, error } = await supabase
        .from('settings')
        .select('*')
        .eq('key', key)
        .maybeSingle();

      if (error) throw error;

      if (!data) {
        return defaultValue;
      }

      return data.value as T;
    },
    enabled: !!user?.id,
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

/**
 * Generic hook to update a setting
 */
function useUpdateSetting<T>(key: SettingKey) {
  const queryClient = useQueryClient();
  const { data: user } = useAuth();

  return useMutation({
    mutationFn: async (value: T) => {
      if (!user?.id) throw new Error('User not authenticated');

      const { data, error } = await supabase
        .from('settings')
        .upsert(
          {
            user_id: user.id,
            key,
            value: value as any,
          },
          {
            onConflict: 'user_id,key',
          }
        )
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings', key] });
      toast.success('Cài đặt đã được lưu thành công');
    },
    onError: (error) => {
      toast.error('Có lỗi xảy ra khi lưu cài đặt: ' + error.message);
    },
  });
}

// Specific hooks for each setting type
export function useCompanyInfo() {
  return useSetting<CompanyInfo>('company_info', DEFAULT_COMPANY_INFO);
}

export function useUpdateCompanyInfo() {
  return useUpdateSetting<CompanyInfo>('company_info');
}

export function useContractConfig() {
  return useSetting<ContractConfig>('contract_config', DEFAULT_CONTRACT_CONFIG);
}

export function useUpdateContractConfig() {
  return useUpdateSetting<ContractConfig>('contract_config');
}

export function useInvoiceConfig() {
  return useSetting<InvoiceConfig>('invoice_config', DEFAULT_INVOICE_CONFIG);
}

export function useUpdateInvoiceConfig() {
  return useUpdateSetting<InvoiceConfig>('invoice_config');
}

export function usePaymentConfig() {
  return useSetting<PaymentConfig>('payment_config', DEFAULT_PAYMENT_CONFIG);
}

export function useUpdatePaymentConfig() {
  return useUpdateSetting<PaymentConfig>('payment_config');
}

export function useNotificationConfig() {
  return useSetting<NotificationConfig>(
    'notification_config',
    DEFAULT_NOTIFICATION_CONFIG
  );
}

export function useUpdateNotificationConfig() {
  return useUpdateSetting<NotificationConfig>('notification_config');
}

export function useCodeGenerationConfig() {
  return useSetting<CodeGenerationConfig>(
    'code_generation_config',
    DEFAULT_CODE_GENERATION_CONFIG
  );
}

export function useUpdateCodeGenerationConfig() {
  return useUpdateSetting<CodeGenerationConfig>('code_generation_config');
}

/**
 * Hook to get all settings at once
 */
export function useAllSettings() {
  const companyInfo = useCompanyInfo();
  const contractConfig = useContractConfig();
  const invoiceConfig = useInvoiceConfig();
  const paymentConfig = usePaymentConfig();
  const notificationConfig = useNotificationConfig();
  const codeGenerationConfig = useCodeGenerationConfig();

  return {
    companyInfo: companyInfo.data,
    contractConfig: contractConfig.data,
    invoiceConfig: invoiceConfig.data,
    paymentConfig: paymentConfig.data,
    notificationConfig: notificationConfig.data,
    codeGenerationConfig: codeGenerationConfig.data,
    isLoading:
      companyInfo.isLoading ||
      contractConfig.isLoading ||
      invoiceConfig.isLoading ||
      paymentConfig.isLoading ||
      notificationConfig.isLoading ||
      codeGenerationConfig.isLoading,
  };
}

// =============================================
// Individual Setting Key Hooks
// For settings stored as individual keys (from migration 20250101000012)
// =============================================

type IndividualSettingValue = boolean | string | number;

/**
 * Hook to fetch a single setting by its individual key
 */
export function useIndividualSetting(key: string, defaultValue: IndividualSettingValue) {
  const { data: user } = useAuth();

  return useQuery({
    queryKey: ['settings', 'individual', key, user?.id],
    queryFn: async () => {
      if (!user?.id) throw new Error('User not authenticated');

      const { data, error } = await supabase
        .from('settings')
        .select('value')
        .eq('key', key)
        .maybeSingle();

      if (error) throw error;
      if (!data) return defaultValue;

      // Parse the JSONB value
      const val = data.value;
      if (typeof val === 'boolean' || typeof val === 'number' || typeof val === 'string') {
        return val as IndividualSettingValue;
      }
      return defaultValue;
    },
    enabled: !!user?.id,
    staleTime: 1000 * 60 * 5,
  });
}

/**
 * Hook to update a single setting by its individual key
 */
export function useUpdateIndividualSetting(key: string) {
  const queryClient = useQueryClient();
  const { data: user } = useAuth();

  return useMutation({
    mutationFn: async (value: IndividualSettingValue) => {
      if (!user?.id) throw new Error('User not authenticated');

      const { data, error } = await supabase
        .from('settings')
        .upsert(
          { user_id: user.id, key, value: value as any },
          { onConflict: 'user_id,key' }
        )
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings', 'individual', key] });
      toast.success('Dữ liệu đã được CẬP NHẬT thành công');
    },
    onError: (error) => {
      toast.error('Có lỗi xảy ra: ' + error.message);
    },
  });
}

// =============================================
// Bulk settings hook for the General Settings page
// Fetches all individual setting keys at once
// =============================================

export interface GeneralSettingsMap {
  [key: string]: IndividualSettingValue;
}

const GENERAL_SETTINGS_DEFAULTS: GeneralSettingsMap = {
  // Contract tab
  contract_auto_set_service_users: false,
  contract_asset_inspection: false,
  contract_auto_create_on_renewal: false,
  contract_e_signing_enabled: false,
  contract_payment_date_setting: '1',
  contract_show_expiring_status: true,
  contract_overdue_notification: false,
  // Invoice tab
  invoice_auto_approve_meter: false,
  invoice_auto_approve: false,
  invoice_use_coefficient: false,
  invoice_auto_calc_coefficient: false,
  invoice_service_cycle_type: 'monthly',
  invoice_prorate_method: 'actual_days',
  invoice_payment_deadline_days: 5,
  invoice_auto_create_deposit: false,
  invoice_auto_generate_next: false,
  invoice_allow_tenant_meter: false,
  // Payment tab
  payment_auto_approve: false,
  // Notification tab
  notification_invoice_reminder: false,
  notification_payment_reminder: false,
};

/**
 * Hook to fetch all general settings (individual keys) at once
 */
export function useGeneralSettings() {
  const { data: user } = useAuth();
  const keys = Object.keys(GENERAL_SETTINGS_DEFAULTS);

  return useQuery({
    queryKey: ['settings', 'general-all', user?.id],
    queryFn: async () => {
      if (!user?.id) throw new Error('User not authenticated');

      const { data, error } = await supabase
        .from('settings')
        .select('key, value')
        .in('key', keys);

      if (error) throw error;

      const result: GeneralSettingsMap = { ...GENERAL_SETTINGS_DEFAULTS };
      if (data) {
        for (const row of data) {
          if (row.key in result) {
            result[row.key] = row.value as IndividualSettingValue;
          }
        }
      }
      return result;
    },
    enabled: !!user?.id,
    staleTime: 1000 * 60 * 5,
  });
}

/**
 * Hook to update a single general setting key and refresh the bulk query
 */
export function useUpdateGeneralSetting() {
  const queryClient = useQueryClient();
  const { data: user } = useAuth();

  return useMutation({
    mutationFn: async ({ key, value }: { key: string; value: IndividualSettingValue }) => {
      if (!user?.id) throw new Error('User not authenticated');

      const { data, error } = await supabase
        .from('settings')
        .upsert(
          { user_id: user.id, key, value: value as any },
          { onConflict: 'user_id,key' }
        )
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings', 'general-all'] });
      toast.success('Dữ liệu đã được CẬP NHẬT thành công');
    },
    onError: (error) => {
      toast.error('Có lỗi xảy ra: ' + error.message);
    },
  });
}
