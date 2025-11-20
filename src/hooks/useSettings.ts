import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { useAuth } from './useAuth';
import { toast } from 'sonner';

// =============================================
// TYPES
// =============================================

export interface Setting {
  id: string;
  user_id: string;
  key: string;
  value: any; // JSONB can be any type
  created_at: string;
  updated_at: string;
}

// Company Settings
export interface CompanySettings {
  company_name: string;
  company_address: string;
  company_phone: string;
  company_email: string;
  company_tax_code: string;
  company_logo_url: string;
}

// Contract Configuration Settings
export interface ContractSettings {
  // Contract generation
  auto_generate_contract_number: boolean;
  contract_number_format: string; // e.g., "HD-{YYYY}-{####}"
  contract_number_prefix: string;

  // Contract rules
  require_deposit_before_contract: boolean;
  min_deposit_percentage: number; // 0-100
  allow_partial_deposit: boolean;

  // Contract terms
  default_payment_cycle: 'MONTHLY' | 'QUARTERLY' | 'SEMI_ANNUAL' | 'ANNUAL';
  default_contract_duration_months: number;
  allow_early_termination: boolean;
  early_termination_penalty_percentage: number;

  // Extensions & transfers
  allow_contract_extension: boolean;
  allow_room_transfer: boolean;
  allow_contract_transfer: boolean;
}

// Invoice Configuration Settings
export interface InvoiceSettings {
  // Invoice generation
  auto_generate_invoice_number: boolean;
  invoice_number_format: string; // e.g., "INV-{YYYY}{MM}-{####}"
  invoice_number_prefix: string;

  // Invoice rules
  auto_generate_monthly_invoices: boolean;
  invoice_generation_day: number; // 1-28
  invoice_due_days: number; // Days after invoice date

  // Payment rules
  allow_partial_payment: boolean;
  late_payment_penalty_percentage: number;
  late_payment_penalty_days: number; // Grace period before penalty

  // Invoice display
  show_previous_debt_on_invoice: boolean;
  show_payment_qr_code: boolean;
}

// Payment Settings
export interface PaymentSettings {
  default_payment_method: 'CASH' | 'BANK_TRANSFER' | 'MOMO' | 'VNPAY' | 'ZALO_PAY';
  require_payment_receipt: boolean;
  auto_send_payment_receipt: boolean;

  // Bank transfer info
  bank_name: string;
  bank_account_number: string;
  bank_account_name: string;

  // Digital payment
  momo_phone: string;
  vnpay_merchant_id: string;
  zalopay_app_id: string;
}

// Notification Settings
export interface NotificationSettings {
  // Enabled channels
  enable_in_app_notifications: boolean;
  enable_email_notifications: boolean;
  enable_sms_notifications: boolean;
  enable_zalo_notifications: boolean;

  // Notification triggers
  notify_on_new_invoice: boolean;
  notify_on_payment_received: boolean;
  notify_on_contract_expiring: boolean;
  notify_on_issue_created: boolean;
  notify_on_issue_resolved: boolean;

  // Timing
  contract_expiring_notice_days: number[]; // e.g., [30, 15, 7]
  payment_reminder_days_before: number[]; // e.g., [7, 3, 1]
}

// All settings combined
export interface AllSettings {
  company: CompanySettings;
  contract: ContractSettings;
  invoice: InvoiceSettings;
  payment: PaymentSettings;
  notification: NotificationSettings;
}

// =============================================
// HOOKS
// =============================================

/**
 * useSetting - Get a single setting by key
 */
export const useSetting = (key: string) => {
  const { data: user } = useAuth();

  return useQuery({
    queryKey: ['settings', user?.id, key],
    queryFn: async () => {
      if (!user?.id) return null;

      const { data, error } = await supabase
        .from('settings')
        .select('*')
        .eq('user_id', user.id)
        .eq('key', key)
        .single();

      if (error) {
        // Setting doesn't exist yet
        if (error.code === 'PGRST116') return null;
        throw error;
      }

      return data as Setting;
    },
    enabled: !!user?.id,
  });
};

/**
 * useSettings - Get all settings for current user
 */
export const useSettings = () => {
  const { data: user } = useAuth();

  return useQuery({
    queryKey: ['settings', user?.id],
    queryFn: async () => {
      if (!user?.id) return [];

      const { data, error } = await supabase
        .from('settings')
        .select('*')
        .eq('user_id', user.id);

      if (error) throw error;

      return (data || []) as Setting[];
    },
    enabled: !!user?.id,
  });
};

/**
 * useAllSettings - Get all settings grouped by category
 */
export const useAllSettings = () => {
  const { data: settings = [] } = useSettings();

  const groupedSettings: Partial<AllSettings> = {
    company: {} as CompanySettings,
    contract: {} as ContractSettings,
    invoice: {} as InvoiceSettings,
    payment: {} as PaymentSettings,
    notification: {} as NotificationSettings,
  };

  settings.forEach(setting => {
    const [category, ...keyParts] = setting.key.split('.');
    const key = keyParts.join('.');

    if (category in groupedSettings) {
      (groupedSettings as any)[category][key] = setting.value;
    }
  });

  return groupedSettings as AllSettings;
};

/**
 * useUpdateSetting - Update or create a setting
 */
export const useUpdateSetting = () => {
  const queryClient = useQueryClient();
  const { data: user } = useAuth();

  return useMutation({
    mutationFn: async ({ key, value }: { key: string; value: any }) => {
      if (!user?.id) throw new Error('User not authenticated');

      // Upsert setting
      const { data, error } = await supabase
        .from('settings')
        .upsert(
          {
            user_id: user.id,
            key,
            value,
            updated_at: new Date().toISOString(),
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
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['settings', user?.id] });
      queryClient.invalidateQueries({ queryKey: ['settings', user?.id, variables.key] });
      toast.success('Cài đặt đã được lưu');
    },
    onError: (error) => {
      console.error('Error updating setting:', error);
      toast.error('Không thể lưu cài đặt');
    },
  });
};

/**
 * useBulkUpdateSettings - Update multiple settings at once
 */
export const useBulkUpdateSettings = () => {
  const queryClient = useQueryClient();
  const { data: user } = useAuth();

  return useMutation({
    mutationFn: async (settings: { key: string; value: any }[]) => {
      if (!user?.id) throw new Error('User not authenticated');

      const settingsToUpsert = settings.map(s => ({
        user_id: user.id,
        key: s.key,
        value: s.value,
        updated_at: new Date().toISOString(),
      }));

      const { data, error } = await supabase
        .from('settings')
        .upsert(settingsToUpsert, {
          onConflict: 'user_id,key',
        })
        .select();

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings', user?.id] });
      toast.success('Tất cả cài đặt đã được lưu');
    },
    onError: (error) => {
      console.error('Error updating settings:', error);
      toast.error('Không thể lưu cài đặt');
    },
  });
};

// =============================================
// HELPER FUNCTIONS
// =============================================

/**
 * Get default company settings
 */
export const getDefaultCompanySettings = (): CompanySettings => ({
  company_name: '',
  company_address: '',
  company_phone: '',
  company_email: '',
  company_tax_code: '',
  company_logo_url: '',
});

/**
 * Get default contract settings
 */
export const getDefaultContractSettings = (): ContractSettings => ({
  auto_generate_contract_number: true,
  contract_number_format: 'HD-{YYYY}-{####}',
  contract_number_prefix: 'HD',
  require_deposit_before_contract: true,
  min_deposit_percentage: 100,
  allow_partial_deposit: false,
  default_payment_cycle: 'MONTHLY',
  default_contract_duration_months: 12,
  allow_early_termination: true,
  early_termination_penalty_percentage: 50,
  allow_contract_extension: true,
  allow_room_transfer: true,
  allow_contract_transfer: true,
});

/**
 * Get default invoice settings
 */
export const getDefaultInvoiceSettings = (): InvoiceSettings => ({
  auto_generate_invoice_number: true,
  invoice_number_format: 'INV-{YYYY}{MM}-{####}',
  invoice_number_prefix: 'INV',
  auto_generate_monthly_invoices: true,
  invoice_generation_day: 1,
  invoice_due_days: 5,
  allow_partial_payment: true,
  late_payment_penalty_percentage: 0.5,
  late_payment_penalty_days: 3,
  show_previous_debt_on_invoice: true,
  show_payment_qr_code: false,
});

/**
 * Get default payment settings
 */
export const getDefaultPaymentSettings = (): PaymentSettings => ({
  default_payment_method: 'CASH',
  require_payment_receipt: true,
  auto_send_payment_receipt: false,
  bank_name: '',
  bank_account_number: '',
  bank_account_name: '',
  momo_phone: '',
  vnpay_merchant_id: '',
  zalopay_app_id: '',
});

/**
 * Get default notification settings
 */
export const getDefaultNotificationSettings = (): NotificationSettings => ({
  enable_in_app_notifications: true,
  enable_email_notifications: false,
  enable_sms_notifications: false,
  enable_zalo_notifications: false,
  notify_on_new_invoice: true,
  notify_on_payment_received: true,
  notify_on_contract_expiring: true,
  notify_on_issue_created: true,
  notify_on_issue_resolved: true,
  contract_expiring_notice_days: [30, 15, 7],
  payment_reminder_days_before: [7, 3, 1],
});
