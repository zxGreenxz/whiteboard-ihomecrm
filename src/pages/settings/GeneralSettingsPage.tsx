import { useState } from 'react';
import MainLayout from "@/components/layout/MainLayout";
import { Settings, Building, FileText, DollarSign, Bell, Save } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import {
  useCompanyInfo,
  useUpdateCompanyInfo,
  useContractConfig,
  useUpdateContractConfig,
  useInvoiceConfig,
  useUpdateInvoiceConfig,
  usePaymentConfig,
  useUpdatePaymentConfig,
  useNotificationConfig,
  useUpdateNotificationConfig,
  type CompanyInfo,
  type ContractConfig,
  type InvoiceConfig,
  type PaymentConfig,
  type NotificationConfig,
} from '@/hooks/useSettings';

const GeneralSettingsPage = () => {
  const [activeTab, setActiveTab] = useState('company');

  // Company Info
  const { data: companyInfo, isLoading: loadingCompany } = useCompanyInfo();
  const updateCompanyInfo = useUpdateCompanyInfo();
  const [companyForm, setCompanyForm] = useState<CompanyInfo | undefined>(companyInfo);

  // Contract Config
  const { data: contractConfig, isLoading: loadingContract } = useContractConfig();
  const updateContractConfig = useUpdateContractConfig();
  const [contractForm, setContractForm] = useState<ContractConfig | undefined>(contractConfig);

  // Invoice Config
  const { data: invoiceConfig, isLoading: loadingInvoice } = useInvoiceConfig();
  const updateInvoiceConfig = useUpdateInvoiceConfig();
  const [invoiceForm, setInvoiceForm] = useState<InvoiceConfig | undefined>(invoiceConfig);

  // Payment Config
  const { data: paymentConfig, isLoading: loadingPayment } = usePaymentConfig();
  const updatePaymentConfig = useUpdatePaymentConfig();
  const [paymentForm, setPaymentForm] = useState<PaymentConfig | undefined>(paymentConfig);

  // Notification Config
  const { data: notificationConfig, isLoading: loadingNotification } = useNotificationConfig();
  const updateNotificationConfig = useUpdateNotificationConfig();
  const [notificationForm, setNotificationForm] = useState<NotificationConfig | undefined>(notificationConfig);

  // Update forms when data loads
  useState(() => {
    if (companyInfo) setCompanyForm(companyInfo);
  });
  useState(() => {
    if (contractConfig) setContractForm(contractConfig);
  });
  useState(() => {
    if (invoiceConfig) setInvoiceForm(invoiceConfig);
  });
  useState(() => {
    if (paymentConfig) setPaymentForm(paymentConfig);
  });
  useState(() => {
    if (notificationConfig) setNotificationForm(notificationConfig);
  });

  // Save handlers
  const handleSaveCompany = () => {
    if (companyForm) {
      updateCompanyInfo.mutate(companyForm);
    }
  };

  const handleSaveContract = () => {
    if (contractForm) {
      updateContractConfig.mutate(contractForm);
    }
  };

  const handleSaveInvoice = () => {
    if (invoiceForm) {
      updateInvoiceConfig.mutate(invoiceForm);
    }
  };

  const handleSavePayment = () => {
    if (paymentForm) {
      updatePaymentConfig.mutate(paymentForm);
    }
  };

  const handleSaveNotification = () => {
    if (notificationForm) {
      updateNotificationConfig.mutate(notificationForm);
    }
  };

  const isLoading = loadingCompany || loadingContract || loadingInvoice || loadingPayment || loadingNotification;

  if (isLoading) {
    return (
      <MainLayout>
        <div className="container mx-auto p-6">
          <p className="text-center text-muted-foreground">Đang tải cài đặt...</p>
        </div>
      </MainLayout>
    );
  }

  return (
    <MainLayout>
      <div className="container mx-auto p-6 max-w-6xl">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <div className="h-10 w-10 rounded-lg bg-gray-100 flex items-center justify-center">
            <Settings className="h-5 w-5 text-gray-600" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">Cài đặt chung</h1>
            <p className="text-sm text-muted-foreground">
              Quản lý thông tin công ty và cấu hình hệ thống
            </p>
          </div>
        </div>

        {/* Settings Tabs */}
        <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="grid w-full grid-cols-5">
          <TabsTrigger value="company">
            <Building className="h-4 w-4 mr-2" />
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
            <DollarSign className="h-4 w-4 mr-2" />
            Thanh toán
          </TabsTrigger>
          <TabsTrigger value="notification">
            <Bell className="h-4 w-4 mr-2" />
            Thông báo
          </TabsTrigger>
        </TabsList>

        {/* Company Info Tab */}
        <TabsContent value="company">
          <Card>
            <CardHeader>
              <CardTitle>Thông tin công ty</CardTitle>
              <CardDescription>
                Thông tin hiển thị trên hợp đồng, hóa đơn và các tài liệu
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="company_name">Tên công ty *</Label>
                  <Input
                    id="company_name"
                    value={companyForm?.company_name || ''}
                    onChange={(e) =>
                      setCompanyForm({ ...companyForm!, company_name: e.target.value })
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="company_tax_code">Mã số thuế</Label>
                  <Input
                    id="company_tax_code"
                    value={companyForm?.company_tax_code || ''}
                    onChange={(e) =>
                      setCompanyForm({ ...companyForm!, company_tax_code: e.target.value })
                    }
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="company_address">Địa chỉ *</Label>
                <Input
                  id="company_address"
                  value={companyForm?.company_address || ''}
                  onChange={(e) =>
                    setCompanyForm({ ...companyForm!, company_address: e.target.value })
                  }
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="company_phone">Số điện thoại *</Label>
                  <Input
                    id="company_phone"
                    value={companyForm?.company_phone || ''}
                    onChange={(e) =>
                      setCompanyForm({ ...companyForm!, company_phone: e.target.value })
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="company_email">Email *</Label>
                  <Input
                    id="company_email"
                    type="email"
                    value={companyForm?.company_email || ''}
                    onChange={(e) =>
                      setCompanyForm({ ...companyForm!, company_email: e.target.value })
                    }
                  />
                </div>
              </div>

              <Separator />

              <h3 className="font-semibold">Thông tin ngân hàng</h3>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="bank_name">Tên ngân hàng</Label>
                  <Input
                    id="bank_name"
                    value={companyForm?.bank_name || ''}
                    onChange={(e) =>
                      setCompanyForm({ ...companyForm!, bank_name: e.target.value })
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="bank_account_number">Số tài khoản</Label>
                  <Input
                    id="bank_account_number"
                    value={companyForm?.bank_account_number || ''}
                    onChange={(e) =>
                      setCompanyForm({ ...companyForm!, bank_account_number: e.target.value })
                    }
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="bank_account_name">Tên chủ tài khoản</Label>
                <Input
                  id="bank_account_name"
                  value={companyForm?.bank_account_name || ''}
                  onChange={(e) =>
                    setCompanyForm({ ...companyForm!, bank_account_name: e.target.value })
                  }
                />
              </div>

              <div className="flex justify-end">
                <Button onClick={handleSaveCompany} disabled={updateCompanyInfo.isPending}>
                  <Save className="h-4 w-4 mr-2" />
                  {updateCompanyInfo.isPending ? 'Đang lưu...' : 'Lưu thay đổi'}
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Contract Config Tab */}
        <TabsContent value="contract">
          <Card>
            <CardHeader>
              <CardTitle>Cấu hình hợp đồng</CardTitle>
              <CardDescription>
                Quy tắc và cấu hình cho việc tạo và quản lý hợp đồng
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {/* Deposit Settings */}
              <div className="space-y-4">
                <h3 className="font-semibold">Cài đặt đặt cọc</h3>
                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label>Bắt buộc đặt cọc</Label>
                    <p className="text-sm text-muted-foreground">
                      Yêu cầu khách phải đặt cọc trước khi ký hợp đồng
                    </p>
                  </div>
                  <Switch
                    checked={contractForm?.require_deposit}
                    onCheckedChange={(checked) =>
                      setContractForm({ ...contractForm!, require_deposit: checked })
                    }
                  />
                </div>

                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label>Cho phép đặt cọc một phần</Label>
                    <p className="text-sm text-muted-foreground">
                      Cho phép khách đặt cọc dưới 100%
                    </p>
                  </div>
                  <Switch
                    checked={contractForm?.allow_partial_deposit}
                    onCheckedChange={(checked) =>
                      setContractForm({ ...contractForm!, allow_partial_deposit: checked })
                    }
                  />
                </div>

                <div className="space-y-2">
                  <Label>Tỷ lệ đặt cọc mặc định (%)</Label>
                  <Input
                    type="number"
                    min="0"
                    max="100"
                    value={contractForm?.deposit_percentage}
                    onChange={(e) =>
                      setContractForm({
                        ...contractForm!,
                        deposit_percentage: Number(e.target.value),
                      })
                    }
                  />
                </div>
              </div>

              <Separator />

              {/* Contract Number Settings */}
              <div className="space-y-4">
                <h3 className="font-semibold">Mã hợp đồng</h3>
                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label>Tự động tạo mã hợp đồng</Label>
                    <p className="text-sm text-muted-foreground">
                      Hệ thống tự động tạo mã theo định dạng
                    </p>
                  </div>
                  <Switch
                    checked={contractForm?.auto_generate_contract_number}
                    onCheckedChange={(checked) =>
                      setContractForm({ ...contractForm!, auto_generate_contract_number: checked })
                    }
                  />
                </div>

                {contractForm?.auto_generate_contract_number && (
                  <>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label>Tiền tố</Label>
                        <Input
                          value={contractForm?.contract_number_prefix}
                          onChange={(e) =>
                            setContractForm({
                              ...contractForm!,
                              contract_number_prefix: e.target.value,
                            })
                          }
                          placeholder="HD"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>Định dạng</Label>
                        <Input
                          value={contractForm?.contract_number_format}
                          onChange={(e) =>
                            setContractForm({
                              ...contractForm!,
                              contract_number_format: e.target.value,
                            })
                          }
                          placeholder="{prefix}{year}{month}{seq:4}"
                        />
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Ví dụ: HD202511001, HD202511002, ...
                    </p>
                  </>
                )}
              </div>

              <Separator />

              {/* Other Settings */}
              <div className="space-y-4">
                <h3 className="font-semibold">Cài đặt khác</h3>
                <div className="space-y-2">
                  <Label>Kỳ thanh toán mặc định</Label>
                  <Select
                    value={contractForm?.payment_cycle_default}
                    onValueChange={(value: any) =>
                      setContractForm({ ...contractForm!, payment_cycle_default: value })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="MONTHLY">Hàng tháng</SelectItem>
                      <SelectItem value="QUARTERLY">Hàng quý</SelectItem>
                      <SelectItem value="YEARLY">Hàng năm</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label>Tự động tạo hóa đơn</Label>
                    <p className="text-sm text-muted-foreground">
                      Tạo hóa đơn ngay sau khi ký hợp đồng
                    </p>
                  </div>
                  <Switch
                    checked={contractForm?.auto_create_invoice}
                    onCheckedChange={(checked) =>
                      setContractForm({ ...contractForm!, auto_create_invoice: checked })
                    }
                  />
                </div>

                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label>Cho phép nhượng hợp đồng</Label>
                    <p className="text-sm text-muted-foreground">
                      Cho phép chuyển nhượng hợp đồng cho người khác
                    </p>
                  </div>
                  <Switch
                    checked={contractForm?.allow_contract_transfer}
                    onCheckedChange={(checked) =>
                      setContractForm({ ...contractForm!, allow_contract_transfer: checked })
                    }
                  />
                </div>

                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label>Yêu cầu duyệt khi thanh lý</Label>
                    <p className="text-sm text-muted-foreground">
                      Cần xác nhận trước khi thanh lý hợp đồng
                    </p>
                  </div>
                  <Switch
                    checked={contractForm?.require_approval_for_termination}
                    onCheckedChange={(checked) =>
                      setContractForm({ ...contractForm!, require_approval_for_termination: checked })
                    }
                  />
                </div>
              </div>

              <div className="flex justify-end">
                <Button onClick={handleSaveContract} disabled={updateContractConfig.isPending}>
                  <Save className="h-4 w-4 mr-2" />
                  {updateContractConfig.isPending ? 'Đang lưu...' : 'Lưu thay đổi'}
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Invoice Config Tab */}
        <TabsContent value="invoice">
          <Card>
            <CardHeader>
              <CardTitle>Cấu hình hóa đơn</CardTitle>
              <CardDescription>
                Quy tắc và cấu hình cho việc tạo và quản lý hóa đơn
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {/* Invoice Number Settings */}
              <div className="space-y-4">
                <h3 className="font-semibold">Mã hóa đơn</h3>
                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label>Tự động tạo mã hóa đơn</Label>
                    <p className="text-sm text-muted-foreground">
                      Hệ thống tự động tạo mã theo định dạng
                    </p>
                  </div>
                  <Switch
                    checked={invoiceForm?.auto_generate_invoice_number}
                    onCheckedChange={(checked) =>
                      setInvoiceForm({ ...invoiceForm!, auto_generate_invoice_number: checked })
                    }
                  />
                </div>

                {invoiceForm?.auto_generate_invoice_number && (
                  <>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label>Tiền tố</Label>
                        <Input
                          value={invoiceForm?.invoice_number_prefix}
                          onChange={(e) =>
                            setInvoiceForm({
                              ...invoiceForm!,
                              invoice_number_prefix: e.target.value,
                            })
                          }
                          placeholder="INV"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>Định dạng</Label>
                        <Input
                          value={invoiceForm?.invoice_number_format}
                          onChange={(e) =>
                            setInvoiceForm({
                              ...invoiceForm!,
                              invoice_number_format: e.target.value,
                            })
                          }
                          placeholder="{prefix}{year}{month}{seq:4}"
                        />
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Ví dụ: INV202511001, INV202511002, ...
                    </p>
                  </>
                )}
              </div>

              <Separator />

              {/* Payment Settings */}
              <div className="space-y-4">
                <h3 className="font-semibold">Thanh toán</h3>
                <div className="space-y-2">
                  <Label>Số ngày đến hạn thanh toán</Label>
                  <Input
                    type="number"
                    min="1"
                    value={invoiceForm?.payment_due_days}
                    onChange={(e) =>
                      setInvoiceForm({
                        ...invoiceForm!,
                        payment_due_days: Number(e.target.value),
                      })
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    Số ngày từ khi phát hành hóa đơn đến hạn thanh toán
                  </p>
                </div>

                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label>Gộp nợ cũ vào hóa đơn mới</Label>
                    <p className="text-sm text-muted-foreground">
                      Tự động cộng công nợ cũ vào hóa đơn mới
                    </p>
                  </div>
                  <Switch
                    checked={invoiceForm?.include_previous_debt}
                    onCheckedChange={(checked) =>
                      setInvoiceForm({ ...invoiceForm!, include_previous_debt: checked })
                    }
                  />
                </div>

                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label>Cho phép thanh toán một phần</Label>
                    <p className="text-sm text-muted-foreground">
                      Cho phép khách thanh toán dưới 100%
                    </p>
                  </div>
                  <Switch
                    checked={invoiceForm?.allow_partial_payment}
                    onCheckedChange={(checked) =>
                      setInvoiceForm({ ...invoiceForm!, allow_partial_payment: checked })
                    }
                  />
                </div>
              </div>

              <Separator />

              {/* Late Payment Fee */}
              <div className="space-y-4">
                <h3 className="font-semibold">Phí trễ hạn</h3>
                <div className="space-y-2">
                  <Label>Loại phí trễ hạn</Label>
                  <Select
                    value={invoiceForm?.late_payment_fee_type}
                    onValueChange={(value: any) =>
                      setInvoiceForm({ ...invoiceForm!, late_payment_fee_type: value })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="NONE">Không tính phí</SelectItem>
                      <SelectItem value="PERCENTAGE">Theo phần trăm (%)</SelectItem>
                      <SelectItem value="FIXED">Số tiền cố định (VND)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {invoiceForm?.late_payment_fee_type !== 'NONE' && (
                  <div className="space-y-2">
                    <Label>
                      {invoiceForm?.late_payment_fee_type === 'PERCENTAGE'
                        ? 'Tỷ lệ phí (%/ngày)'
                        : 'Số tiền (VND/ngày)'}
                    </Label>
                    <Input
                      type="number"
                      min="0"
                      value={invoiceForm?.late_payment_fee_value}
                      onChange={(e) =>
                        setInvoiceForm({
                          ...invoiceForm!,
                          late_payment_fee_value: Number(e.target.value),
                        })
                      }
                    />
                  </div>
                )}
              </div>

              <div className="flex justify-end">
                <Button onClick={handleSaveInvoice} disabled={updateInvoiceConfig.isPending}>
                  <Save className="h-4 w-4 mr-2" />
                  {updateInvoiceConfig.isPending ? 'Đang lưu...' : 'Lưu thay đổi'}
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Payment Config Tab */}
        <TabsContent value="payment">
          <Card>
            <CardHeader>
              <CardTitle>Cấu hình thanh toán</CardTitle>
              <CardDescription>
                Phương thức thanh toán và cài đặt liên quan
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label>Phương thức thanh toán mặc định</Label>
                  <Select
                    value={paymentForm?.default_payment_method}
                    onValueChange={(value: any) =>
                      setPaymentForm({ ...paymentForm!, default_payment_method: value })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="CASH">Tiền mặt</SelectItem>
                      <SelectItem value="BANK_TRANSFER">Chuyển khoản</SelectItem>
                      <SelectItem value="MOMO">MoMo</SelectItem>
                      <SelectItem value="VNPAY">VNPay</SelectItem>
                      <SelectItem value="OTHER">Khác</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label>Tự động gửi biên lai</Label>
                    <p className="text-sm text-muted-foreground">
                      Gửi biên lai qua email sau khi thanh toán
                    </p>
                  </div>
                  <Switch
                    checked={paymentForm?.auto_send_receipt}
                    onCheckedChange={(checked) =>
                      setPaymentForm({ ...paymentForm!, auto_send_receipt: checked })
                    }
                  />
                </div>
              </div>

              <div className="flex justify-end">
                <Button onClick={handleSavePayment} disabled={updatePaymentConfig.isPending}>
                  <Save className="h-4 w-4 mr-2" />
                  {updatePaymentConfig.isPending ? 'Đang lưu...' : 'Lưu thay đổi'}
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Notification Config Tab */}
        <TabsContent value="notification">
          <Card>
            <CardHeader>
              <CardTitle>Cấu hình thông báo</CardTitle>
              <CardDescription>
                Cài đặt thông báo tự động cho khách thuê và quản lý
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label>Gửi xác nhận thanh toán</Label>
                    <p className="text-sm text-muted-foreground">
                      Gửi thông báo khi thanh toán thành công
                    </p>
                  </div>
                  <Switch
                    checked={notificationForm?.send_payment_confirmation}
                    onCheckedChange={(checked) =>
                      setNotificationForm({ ...notificationForm!, send_payment_confirmation: checked })
                    }
                  />
                </div>

                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label>Gửi cập nhật sự cố</Label>
                    <p className="text-sm text-muted-foreground">
                      Gửi thông báo khi sự cố được cập nhật
                    </p>
                  </div>
                  <Switch
                    checked={notificationForm?.send_issue_updates}
                    onCheckedChange={(checked) =>
                      setNotificationForm({ ...notificationForm!, send_issue_updates: checked })
                    }
                  />
                </div>

                <Separator />

                <div className="space-y-2">
                  <Label>Tần suất nhắc quá hạn</Label>
                  <Select
                    value={notificationForm?.overdue_reminder_frequency}
                    onValueChange={(value: any) =>
                      setNotificationForm({ ...notificationForm!, overdue_reminder_frequency: value })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="NONE">Không nhắc</SelectItem>
                      <SelectItem value="DAILY">Hàng ngày</SelectItem>
                      <SelectItem value="WEEKLY">Hàng tuần</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="flex justify-end">
                <Button onClick={handleSaveNotification} disabled={updateNotificationConfig.isPending}>
                  <Save className="h-4 w-4 mr-2" />
                  {updateNotificationConfig.isPending ? 'Đang lưu...' : 'Lưu thay đổi'}
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
        </Tabs>
      </div>
    </MainLayout>
  );
};

export default GeneralSettingsPage;
