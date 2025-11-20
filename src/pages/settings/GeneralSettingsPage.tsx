import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Building2, FileText, Wallet, Bell, Save } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import {
  useAllSettings,
  useBulkUpdateSettings,
  getDefaultCompanySettings,
  getDefaultContractSettings,
  getDefaultInvoiceSettings,
  getDefaultPaymentSettings,
  getDefaultNotificationSettings,
} from '@/hooks/useSettings';

// =============================================
// SCHEMAS
// =============================================

const companySchema = z.object({
  company_name: z.string().min(1, 'Tên công ty là bắt buộc'),
  company_address: z.string(),
  company_phone: z.string(),
  company_email: z.string().email('Email không hợp lệ').or(z.literal('')),
  company_tax_code: z.string(),
  company_logo_url: z.string().url('URL không hợp lệ').or(z.literal('')),
});

const contractSchema = z.object({
  auto_generate_contract_number: z.boolean(),
  contract_number_format: z.string(),
  contract_number_prefix: z.string(),
  require_deposit_before_contract: z.boolean(),
  min_deposit_percentage: z.number().min(0).max(100),
  allow_partial_deposit: z.boolean(),
  default_payment_cycle: z.enum(['MONTHLY', 'QUARTERLY', 'SEMI_ANNUAL', 'ANNUAL']),
  default_contract_duration_months: z.number().min(1).max(120),
  allow_early_termination: z.boolean(),
  early_termination_penalty_percentage: z.number().min(0).max(100),
  allow_contract_extension: z.boolean(),
  allow_room_transfer: z.boolean(),
  allow_contract_transfer: z.boolean(),
});

const invoiceSchema = z.object({
  auto_generate_invoice_number: z.boolean(),
  invoice_number_format: z.string(),
  invoice_number_prefix: z.string(),
  auto_generate_monthly_invoices: z.boolean(),
  invoice_generation_day: z.number().min(1).max(28),
  invoice_due_days: z.number().min(1).max(90),
  allow_partial_payment: z.boolean(),
  late_payment_penalty_percentage: z.number().min(0).max(100),
  late_payment_penalty_days: z.number().min(0).max(30),
  show_previous_debt_on_invoice: z.boolean(),
  show_payment_qr_code: z.boolean(),
});

const paymentSchema = z.object({
  default_payment_method: z.enum(['CASH', 'BANK_TRANSFER', 'MOMO', 'VNPAY', 'ZALO_PAY']),
  require_payment_receipt: z.boolean(),
  auto_send_payment_receipt: z.boolean(),
  bank_name: z.string(),
  bank_account_number: z.string(),
  bank_account_name: z.string(),
  momo_phone: z.string(),
  vnpay_merchant_id: z.string(),
  zalopay_app_id: z.string(),
});

const notificationSchema = z.object({
  enable_in_app_notifications: z.boolean(),
  enable_email_notifications: z.boolean(),
  enable_sms_notifications: z.boolean(),
  enable_zalo_notifications: z.boolean(),
  notify_on_new_invoice: z.boolean(),
  notify_on_payment_received: z.boolean(),
  notify_on_contract_expiring: z.boolean(),
  notify_on_issue_created: z.boolean(),
  notify_on_issue_resolved: z.boolean(),
});

// =============================================
// MAIN COMPONENT
// =============================================

const GeneralSettingsPage = () => {
  const [activeTab, setActiveTab] = useState('company');
  const { data: settings, isLoading } = useAllSettings();

  // Show loading state
  if (isLoading) {
    return (
      <div className="p-6 space-y-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Cài đặt chung</h1>
          <p className="text-muted-foreground mt-2">
            Quản lý cấu hình hệ thống, công ty, hợp đồng, hóa đơn và thông báo
          </p>
        </div>
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary"></div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Cài đặt chung</h1>
        <p className="text-muted-foreground mt-2">
          Quản lý cấu hình hệ thống, công ty, hợp đồng, hóa đơn và thông báo
        </p>
      </div>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="grid w-full grid-cols-5">
          <TabsTrigger value="company">
            <Building2 className="h-4 w-4 mr-2" />
            Công ty
          </TabsTrigger>
          <TabsTrigger value="contract">
            <FileText className="h-4 w-4 mr-2" />
            Hợp đồng
          </TabsTrigger>
          <TabsTrigger value="invoice">
            <FileText className="h-4 w-4 mr-2" />
            Hóa đơn
          </TabsTrigger>
          <TabsTrigger value="payment">
            <Wallet className="h-4 w-4 mr-2" />
            Thanh toán
          </TabsTrigger>
          <TabsTrigger value="notification">
            <Bell className="h-4 w-4 mr-2" />
            Thông báo
          </TabsTrigger>
        </TabsList>

        {/* Company Settings Tab */}
        <TabsContent value="company">
          <CompanySettingsForm
            defaultValues={settings.company || getDefaultCompanySettings()}
          />
        </TabsContent>

        {/* Contract Settings Tab */}
        <TabsContent value="contract">
          <ContractSettingsForm
            defaultValues={settings.contract || getDefaultContractSettings()}
          />
        </TabsContent>

        {/* Invoice Settings Tab */}
        <TabsContent value="invoice">
          <InvoiceSettingsForm
            defaultValues={settings.invoice || getDefaultInvoiceSettings()}
          />
        </TabsContent>

        {/* Payment Settings Tab */}
        <TabsContent value="payment">
          <PaymentSettingsForm
            defaultValues={settings.payment || getDefaultPaymentSettings()}
          />
        </TabsContent>

        {/* Notification Settings Tab */}
        <TabsContent value="notification">
          <NotificationSettingsForm
            defaultValues={settings.notification || getDefaultNotificationSettings()}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
};

// =============================================
// COMPANY SETTINGS FORM
// =============================================

const CompanySettingsForm = ({ defaultValues }: { defaultValues: any }) => {
  const bulkUpdateMutation = useBulkUpdateSettings();

  const form = useForm({
    resolver: zodResolver(companySchema),
    defaultValues,
  });

  const onSubmit = (data: any) => {
    const settings = Object.entries(data).map(([key, value]) => ({
      key: `company.${key}`,
      value,
    }));
    bulkUpdateMutation.mutate(settings);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Thông tin công ty</CardTitle>
        <CardDescription>
          Cập nhật thông tin công ty/doanh nghiệp của bạn
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
            <FormField
              control={form.control}
              name="company_name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Tên công ty *</FormLabel>
                  <FormControl>
                    <Input placeholder="VD: Công ty TNHH ABC" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="company_address"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Địa chỉ</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="VD: 123 Nguyễn Văn A, Quận 1, TP.HCM"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="company_phone"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Số điện thoại</FormLabel>
                    <FormControl>
                      <Input placeholder="0901234567" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="company_email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Email</FormLabel>
                    <FormControl>
                      <Input
                        type="email"
                        placeholder="contact@company.com"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="company_tax_code"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Mã số thuế</FormLabel>
                    <FormControl>
                      <Input placeholder="0123456789" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="company_logo_url"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>URL Logo</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="https://example.com/logo.png"
                        {...field}
                      />
                    </FormControl>
                    <FormDescription>URL hình ảnh logo công ty</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <div className="flex justify-end">
              <Button type="submit" disabled={bulkUpdateMutation.isPending}>
                <Save className="h-4 w-4 mr-2" />
                {bulkUpdateMutation.isPending ? 'Đang lưu...' : 'Lưu cài đặt'}
              </Button>
            </div>
          </form>
        </Form>
      </CardContent>
    </Card>
  );
};

// =============================================
// CONTRACT SETTINGS FORM
// =============================================

const ContractSettingsForm = ({ defaultValues }: { defaultValues: any }) => {
  const bulkUpdateMutation = useBulkUpdateSettings();

  const form = useForm({
    resolver: zodResolver(contractSchema),
    defaultValues,
  });

  const onSubmit = (data: any) => {
    const settings = Object.entries(data).map(([key, value]) => ({
      key: `contract.${key}`,
      value,
    }));
    bulkUpdateMutation.mutate(settings);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Cấu hình hợp đồng</CardTitle>
        <CardDescription>
          Cài đặt các quy tắc và cấu hình cho hợp đồng thuê
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
            {/* Contract Number Generation */}
            <div className="space-y-4">
              <h3 className="text-lg font-semibold">Sinh mã hợp đồng</h3>
              <Separator />

              <FormField
                control={form.control}
                name="auto_generate_contract_number"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between rounded-lg border p-4">
                    <div className="space-y-0.5">
                      <FormLabel className="text-base">
                        Tự động sinh mã hợp đồng
                      </FormLabel>
                      <FormDescription>
                        Hệ thống sẽ tự động tạo mã hợp đồng theo format
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="contract_number_prefix"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Tiền tố mã HĐ</FormLabel>
                      <FormControl>
                        <Input placeholder="HD" {...field} />
                      </FormControl>
                      <FormDescription>VD: HD, CONTRACT</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="contract_number_format"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Format mã HĐ</FormLabel>
                      <FormControl>
                        <Input placeholder="HD-{YYYY}-{####}" {...field} />
                      </FormControl>
                      <FormDescription>
                        {'{YYYY}'} năm, {'{MM}'} tháng, {'{####}'} số thứ tự
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            </div>

            {/* Deposit Rules */}
            <div className="space-y-4">
              <h3 className="text-lg font-semibold">Quy định đặt cọc</h3>
              <Separator />

              <FormField
                control={form.control}
                name="require_deposit_before_contract"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between rounded-lg border p-4">
                    <div className="space-y-0.5">
                      <FormLabel className="text-base">
                        Bắt buộc đặt cọc trước khi ký HĐ
                      </FormLabel>
                      <FormDescription>
                        Khách phải đặt cọc trước khi tạo hợp đồng
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="allow_partial_deposit"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between rounded-lg border p-4">
                    <div className="space-y-0.5">
                      <FormLabel className="text-base">
                        Cho phép đặt cọc một phần
                      </FormLabel>
                      <FormDescription>
                        Khách có thể đặt cọc chưa đủ 100%
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="min_deposit_percentage"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Tỷ lệ đặt cọc tối thiểu (%)</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min="0"
                        max="100"
                        {...field}
                        onChange={e => field.onChange(Number(e.target.value))}
                      />
                    </FormControl>
                    <FormDescription>
                      Phần trăm tiền cọc tối thiểu (0-100%)
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            {/* Contract Terms */}
            <div className="space-y-4">
              <h3 className="text-lg font-semibold">Điều khoản hợp đồng</h3>
              <Separator />

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="default_payment_cycle"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Chu kỳ thanh toán mặc định</FormLabel>
                      <Select
                        onValueChange={field.onChange}
                        defaultValue={field.value}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Chọn chu kỳ" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="MONTHLY">Hàng tháng</SelectItem>
                          <SelectItem value="QUARTERLY">3 tháng</SelectItem>
                          <SelectItem value="SEMI_ANNUAL">6 tháng</SelectItem>
                          <SelectItem value="ANNUAL">1 năm</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="default_contract_duration_months"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Thời hạn HĐ mặc định (tháng)</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          min="1"
                          max="120"
                          {...field}
                          onChange={e => field.onChange(Number(e.target.value))}
                        />
                      </FormControl>
                      <FormDescription>Thời hạn hợp đồng (1-120 tháng)</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <FormField
                control={form.control}
                name="allow_early_termination"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between rounded-lg border p-4">
                    <div className="space-y-0.5">
                      <FormLabel className="text-base">
                        Cho phép thanh lý sớm
                      </FormLabel>
                      <FormDescription>
                        Khách có thể thanh lý HĐ trước hạn
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="early_termination_penalty_percentage"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Phạt thanh lý sớm (%)</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min="0"
                        max="100"
                        {...field}
                        onChange={e => field.onChange(Number(e.target.value))}
                      />
                    </FormControl>
                    <FormDescription>
                      Phần trăm phạt trên tiền cọc (0-100%)
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            {/* Contract Actions */}
            <div className="space-y-4">
              <h3 className="text-lg font-semibold">Thao tác hợp đồng</h3>
              <Separator />

              <FormField
                control={form.control}
                name="allow_contract_extension"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between rounded-lg border p-4">
                    <div className="space-y-0.5">
                      <FormLabel className="text-base">Cho phép gia hạn HĐ</FormLabel>
                      <FormDescription>
                        Khách có thể gia hạn hợp đồng
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="allow_room_transfer"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between rounded-lg border p-4">
                    <div className="space-y-0.5">
                      <FormLabel className="text-base">Cho phép chuyển phòng</FormLabel>
                      <FormDescription>
                        Khách có thể chuyển sang phòng khác
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="allow_contract_transfer"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between rounded-lg border p-4">
                    <div className="space-y-0.5">
                      <FormLabel className="text-base">Cho phép nhượng HĐ</FormLabel>
                      <FormDescription>
                        Khách có thể nhượng HĐ cho người khác
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
            </div>

            <div className="flex justify-end">
              <Button type="submit" disabled={bulkUpdateMutation.isPending}>
                <Save className="h-4 w-4 mr-2" />
                {bulkUpdateMutation.isPending ? 'Đang lưu...' : 'Lưu cài đặt'}
              </Button>
            </div>
          </form>
        </Form>
      </CardContent>
    </Card>
  );
};

// =============================================
// INVOICE SETTINGS FORM
// =============================================

const InvoiceSettingsForm = ({ defaultValues }: { defaultValues: any }) => {
  const bulkUpdateMutation = useBulkUpdateSettings();

  const form = useForm({
    resolver: zodResolver(invoiceSchema),
    defaultValues,
  });

  const onSubmit = (data: any) => {
    const settings = Object.entries(data).map(([key, value]) => ({
      key: `invoice.${key}`,
      value,
    }));
    bulkUpdateMutation.mutate(settings);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Cấu hình hóa đơn</CardTitle>
        <CardDescription>
          Cài đặt các quy tắc về hóa đơn và thanh toán
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
            {/* Invoice Number Generation */}
            <div className="space-y-4">
              <h3 className="text-lg font-semibold">Sinh mã hóa đơn</h3>
              <Separator />

              <FormField
                control={form.control}
                name="auto_generate_invoice_number"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between rounded-lg border p-4">
                    <div className="space-y-0.5">
                      <FormLabel className="text-base">
                        Tự động sinh mã hóa đơn
                      </FormLabel>
                      <FormDescription>
                        Hệ thống sẽ tự động tạo mã hóa đơn theo format
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="invoice_number_prefix"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Tiền tố mã HĐ</FormLabel>
                      <FormControl>
                        <Input placeholder="INV" {...field} />
                      </FormControl>
                      <FormDescription>VD: INV, HD, BILL</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="invoice_number_format"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Format mã HĐ</FormLabel>
                      <FormControl>
                        <Input placeholder="INV-{YYYY}{MM}-{####}" {...field} />
                      </FormControl>
                      <FormDescription>
                        {'{YYYY}'} năm, {'{MM}'} tháng, {'{####}'} số thứ tự
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            </div>

            {/* Auto Generation Rules */}
            <div className="space-y-4">
              <h3 className="text-lg font-semibold">Tạo hóa đơn tự động</h3>
              <Separator />

              <FormField
                control={form.control}
                name="auto_generate_monthly_invoices"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between rounded-lg border p-4">
                    <div className="space-y-0.5">
                      <FormLabel className="text-base">
                        Tự động tạo hóa đơn hàng tháng
                      </FormLabel>
                      <FormDescription>
                        Hệ thống tự động tạo hóa đơn vào ngày được chỉ định
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="invoice_generation_day"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Ngày tạo hóa đơn</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          min="1"
                          max="28"
                          {...field}
                          onChange={e => field.onChange(Number(e.target.value))}
                        />
                      </FormControl>
                      <FormDescription>
                        Ngày trong tháng tạo HĐ (1-28)
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="invoice_due_days"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Số ngày đến hạn thanh toán</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          min="1"
                          max="90"
                          {...field}
                          onChange={e => field.onChange(Number(e.target.value))}
                        />
                      </FormControl>
                      <FormDescription>
                        Số ngày sau ngày phát hành (1-90)
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            </div>

            {/* Payment Rules */}
            <div className="space-y-4">
              <h3 className="text-lg font-semibold">Quy định thanh toán</h3>
              <Separator />

              <FormField
                control={form.control}
                name="allow_partial_payment"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between rounded-lg border p-4">
                    <div className="space-y-0.5">
                      <FormLabel className="text-base">
                        Cho phép thanh toán từng phần
                      </FormLabel>
                      <FormDescription>
                        Khách có thể thanh toán chưa đủ 100%
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="late_payment_penalty_percentage"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Phạt trễ hạn (%/ngày)</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          min="0"
                          max="100"
                          step="0.1"
                          {...field}
                          onChange={e => field.onChange(Number(e.target.value))}
                        />
                      </FormControl>
                      <FormDescription>
                        Phần trăm phạt mỗi ngày trễ (0-100%)
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="late_payment_penalty_days"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Số ngày gia hạn miễn phí</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          min="0"
                          max="30"
                          {...field}
                          onChange={e => field.onChange(Number(e.target.value))}
                        />
                      </FormControl>
                      <FormDescription>
                        Số ngày không tính phạt sau hạn (0-30)
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            </div>

            {/* Display Options */}
            <div className="space-y-4">
              <h3 className="text-lg font-semibold">Hiển thị</h3>
              <Separator />

              <FormField
                control={form.control}
                name="show_previous_debt_on_invoice"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between rounded-lg border p-4">
                    <div className="space-y-0.5">
                      <FormLabel className="text-base">
                        Hiển thị công nợ cũ trên hóa đơn
                      </FormLabel>
                      <FormDescription>
                        Cộng dồn công nợ kỳ trước vào hóa đơn mới
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="show_payment_qr_code"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between rounded-lg border p-4">
                    <div className="space-y-0.5">
                      <FormLabel className="text-base">
                        Hiển thị mã QR thanh toán
                      </FormLabel>
                      <FormDescription>
                        Thêm mã QR để khách quét thanh toán
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
            </div>

            <div className="flex justify-end">
              <Button type="submit" disabled={bulkUpdateMutation.isPending}>
                <Save className="h-4 w-4 mr-2" />
                {bulkUpdateMutation.isPending ? 'Đang lưu...' : 'Lưu cài đặt'}
              </Button>
            </div>
          </form>
        </Form>
      </CardContent>
    </Card>
  );
};

// =============================================
// PAYMENT SETTINGS FORM (Simplified for brevity)
// =============================================

const PaymentSettingsForm = ({ defaultValues }: { defaultValues: any }) => {
  const bulkUpdateMutation = useBulkUpdateSettings();

  const form = useForm({
    resolver: zodResolver(paymentSchema),
    defaultValues,
  });

  const onSubmit = (data: any) => {
    const settings = Object.entries(data).map(([key, value]) => ({
      key: `payment.${key}`,
      value,
    }));
    bulkUpdateMutation.mutate(settings);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Cấu hình thanh toán</CardTitle>
        <CardDescription>
          Cài đặt phương thức thanh toán và thông tin ngân hàng
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
            <FormField
              control={form.control}
              name="default_payment_method"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Phương thức thanh toán mặc định</FormLabel>
                  <Select onValueChange={field.onChange} defaultValue={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Chọn phương thức" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="CASH">Tiền mặt</SelectItem>
                      <SelectItem value="BANK_TRANSFER">Chuyển khoản</SelectItem>
                      <SelectItem value="MOMO">MoMo</SelectItem>
                      <SelectItem value="VNPAY">VNPay</SelectItem>
                      <SelectItem value="ZALO_PAY">ZaloPay</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="space-y-4">
              <h3 className="text-lg font-semibold">Thông tin ngân hàng</h3>
              <Separator />

              <FormField
                control={form.control}
                name="bank_name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Tên ngân hàng</FormLabel>
                    <FormControl>
                      <Input placeholder="VD: Vietcombank" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="bank_account_number"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Số tài khoản</FormLabel>
                    <FormControl>
                      <Input placeholder="1234567890" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="bank_account_name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Tên tài khoản</FormLabel>
                    <FormControl>
                      <Input placeholder="NGUYEN VAN A" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <div className="flex justify-end">
              <Button type="submit" disabled={bulkUpdateMutation.isPending}>
                <Save className="h-4 w-4 mr-2" />
                {bulkUpdateMutation.isPending ? 'Đang lưu...' : 'Lưu cài đặt'}
              </Button>
            </div>
          </form>
        </Form>
      </CardContent>
    </Card>
  );
};

// =============================================
// NOTIFICATION SETTINGS FORM (Simplified for brevity)
// =============================================

const NotificationSettingsForm = ({ defaultValues }: { defaultValues: any }) => {
  const bulkUpdateMutation = useBulkUpdateSettings();

  const form = useForm({
    resolver: zodResolver(notificationSchema),
    defaultValues,
  });

  const onSubmit = (data: any) => {
    const settings = Object.entries(data).map(([key, value]) => ({
      key: `notification.${key}`,
      value,
    }));
    bulkUpdateMutation.mutate(settings);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Cấu hình thông báo</CardTitle>
        <CardDescription>
          Cài đặt các kênh thông báo và sự kiện kích hoạt thông báo
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
            <div className="space-y-4">
              <h3 className="text-lg font-semibold">Kênh thông báo</h3>
              <Separator />

              <FormField
                control={form.control}
                name="enable_in_app_notifications"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between rounded-lg border p-4">
                    <div className="space-y-0.5">
                      <FormLabel className="text-base">
                        Thông báo trong app
                      </FormLabel>
                      <FormDescription>
                        Hiển thị thông báo trong ứng dụng
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="enable_email_notifications"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between rounded-lg border p-4">
                    <div className="space-y-0.5">
                      <FormLabel className="text-base">Thông báo Email</FormLabel>
                      <FormDescription>Gửi thông báo qua Email</FormDescription>
                    </div>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="enable_sms_notifications"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between rounded-lg border p-4">
                    <div className="space-y-0.5">
                      <FormLabel className="text-base">Thông báo SMS</FormLabel>
                      <FormDescription>Gửi thông báo qua SMS</FormDescription>
                    </div>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="enable_zalo_notifications"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between rounded-lg border p-4">
                    <div className="space-y-0.5">
                      <FormLabel className="text-base">Thông báo Zalo</FormLabel>
                      <FormDescription>Gửi thông báo qua Zalo ZNS</FormDescription>
                    </div>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
            </div>

            <div className="space-y-4">
              <h3 className="text-lg font-semibold">Sự kiện kích hoạt</h3>
              <Separator />

              <FormField
                control={form.control}
                name="notify_on_new_invoice"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between rounded-lg border p-4">
                    <div className="space-y-0.5">
                      <FormLabel className="text-base">Hóa đơn mới</FormLabel>
                      <FormDescription>
                        Thông báo khi có hóa đơn mới
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="notify_on_payment_received"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between rounded-lg border p-4">
                    <div className="space-y-0.5">
                      <FormLabel className="text-base">
                        Thanh toán được nhận
                      </FormLabel>
                      <FormDescription>
                        Thông báo khi nhận được thanh toán
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="notify_on_contract_expiring"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between rounded-lg border p-4">
                    <div className="space-y-0.5">
                      <FormLabel className="text-base">
                        Hợp đồng sắp hết hạn
                      </FormLabel>
                      <FormDescription>
                        Thông báo khi hợp đồng sắp hết hạn
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="notify_on_issue_created"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between rounded-lg border p-4">
                    <div className="space-y-0.5">
                      <FormLabel className="text-base">
                        Sự cố được tạo
                      </FormLabel>
                      <FormDescription>
                        Thông báo khi có sự cố mới
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="notify_on_issue_resolved"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between rounded-lg border p-4">
                    <div className="space-y-0.5">
                      <FormLabel className="text-base">
                        Sự cố được giải quyết
                      </FormLabel>
                      <FormDescription>
                        Thông báo khi sự cố được giải quyết
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
            </div>

            <div className="flex justify-end">
              <Button type="submit" disabled={bulkUpdateMutation.isPending}>
                <Save className="h-4 w-4 mr-2" />
                {bulkUpdateMutation.isPending ? 'Đang lưu...' : 'Lưu cài đặt'}
              </Button>
            </div>
          </form>
        </Form>
      </CardContent>
    </Card>
  );
};

export default GeneralSettingsPage;
