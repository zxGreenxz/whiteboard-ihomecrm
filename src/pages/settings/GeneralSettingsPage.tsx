import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import MainLayout from "@/components/layout/MainLayout";
import { supabase } from '@/integrations/supabase/client';
import { CurrencyInput } from '@/components/ui/currency-input';
import { Settings, FileText, DollarSign, Bell, Upload, Info, Receipt, MapPin } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NumberInput } from '@/components/ui/number-input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  useGeneralSettings,
  useUpdateGeneralSetting,
  useCompanyInfo,
  useUpdateCompanyInfo,
  useAcceptanceGeofenceSetting,
  useUpdateAcceptanceGeofenceSetting,
} from '@/hooks/useSettings';
import { toast } from 'sonner';

// =============================================
// Setting item configuration for each tab
// =============================================

interface ToggleSettingItem {
  type: 'toggle';
  key: string;
  label: string;
  tooltip: string;
}

interface SelectSettingItem {
  type: 'select';
  key: string;
  label: string;
  tooltip: string;
  options: { value: string; label: string }[];
}

interface NumberSettingItem {
  type: 'number';
  key: string;
  label: string;
  tooltip: string;
  min?: number;
  max?: number;
  suffix?: string;
}

type SettingItem = ToggleSettingItem | SelectSettingItem | NumberSettingItem;

const CONTRACT_SETTINGS: SettingItem[] = [
  {
    type: 'toggle',
    key: 'contract_auto_set_service_users',
    label: 'Tự cài số người dùng DV',
    tooltip: 'Tự động cài đặt số lượng người sử dụng dịch vụ khi tạo hợp đồng mới',
  },
  {
    type: 'toggle',
    key: 'contract_asset_inspection',
    label: 'Kiểm kê tài sản khi ký/thanh lý',
    tooltip: 'Yêu cầu kiểm kê tài sản khi ký hợp đồng mới hoặc thanh lý hợp đồng',
  },
  {
    type: 'toggle',
    key: 'contract_auto_create_on_renewal',
    label: 'Tự động lập HĐ mới khi gia hạn',
    tooltip: 'Hệ thống tự động tạo hợp đồng mới khi hợp đồng hiện tại được gia hạn',
  },
  {
    type: 'toggle',
    key: 'contract_e_signing_enabled',
    label: 'Ký HĐ online',
    tooltip: 'Cho phép ký hợp đồng điện tử online. Chủ nhà gửi link ký cho khách hàng',
  },
  {
    type: 'toggle',
    key: 'contract_payment_date_setting',
    label: 'Cài đặt ngày thanh toán',
    tooltip: 'Cho phép cài đặt ngày thanh toán cố định hàng tháng cho hợp đồng',
  },
  {
    type: 'toggle',
    key: 'contract_show_expiring_status',
    label: 'Hiển thị trạng thái sắp hết hạn',
    tooltip: 'Hiển thị cảnh báo khi hợp đồng sắp hết hạn trên danh sách và bảng tin',
  },
  {
    type: 'toggle',
    key: 'contract_overdue_notification',
    label: 'Nhận thông báo quá hạn HĐ',
    tooltip: 'Gửi thông báo tự động khi hợp đồng quá hạn chưa được gia hạn hoặc thanh lý',
  },
];

const INVOICE_SETTINGS: SettingItem[] = [
  {
    type: 'toggle',
    key: 'invoice_auto_approve_meter',
    label: 'Tự động duyệt chỉ số',
    tooltip: 'Tự động duyệt chỉ số công tơ điện nước sau khi nhân viên ghi chỉ số',
  },
  {
    type: 'toggle',
    key: 'invoice_auto_approve',
    label: 'Tự động duyệt hóa đơn',
    tooltip: 'Hóa đơn được tự động duyệt ngay sau khi tạo, không cần xác nhận thủ công',
  },
  {
    type: 'toggle',
    key: 'invoice_use_coefficient',
    label: 'Sử dụng hệ số',
    tooltip: 'Áp dụng hệ số nhân khi tính tiền dịch vụ (ví dụ: hệ số điện bậc thang)',
  },
  {
    type: 'toggle',
    key: 'invoice_auto_calc_coefficient',
    label: 'Tự động tính hệ số theo ngày',
    tooltip: 'Hệ thống tự động tính hệ số dựa trên số ngày sử dụng thực tế trong kỳ',
  },
  {
    type: 'select',
    key: 'invoice_service_cycle_type',
    label: 'Chu kỳ tính dịch vụ',
    tooltip: 'Chọn cách tính chu kỳ dịch vụ: theo tháng, theo ngày bắt đầu, hoặc theo ngày chốt',
    options: [
      { value: 'monthly', label: 'Theo chu kỳ trong tháng' },
      { value: 'start_date', label: 'Theo ngày bắt đầu tính tiền' },
      { value: 'cutoff_date', label: 'Theo ngày chốt tiền' },
    ],
  },
  {
    type: 'select',
    key: 'invoice_prorate_method',
    label: 'Chia tỷ lệ lẻ ngày',
    tooltip: 'Phương pháp tính tiền khi số ngày sử dụng không đủ tháng',
    options: [
      { value: 'actual_days', label: 'Theo số ngày trong tháng' },
      { value: 'fixed_30', label: 'Chia cố định 30 ngày' },
    ],
  },
  {
    type: 'number',
    key: 'invoice_payment_deadline_days',
    label: 'Hạn thanh toán',
    tooltip: 'Số ngày kể từ ngày phát hành hóa đơn đến hạn thanh toán',
    min: 1,
    max: 90,
    suffix: 'ngày',
  },
  {
    type: 'toggle',
    key: 'invoice_auto_create_deposit',
    label: 'Tự lập hóa đơn đặt cọc',
    tooltip: 'Tự động tạo hóa đơn đặt cọc khi khách hàng xác nhận đặt cọc',
  },
  {
    type: 'toggle',
    key: 'invoice_auto_generate_next',
    label: 'Tự động sinh hóa đơn kỳ tiếp',
    tooltip: 'Hệ thống tự động tạo hóa đơn cho kỳ thanh toán tiếp theo',
  },
  {
    type: 'toggle',
    key: 'invoice_allow_tenant_meter',
    label: 'Cho phép cư dân chốt điện nước',
    tooltip: 'Cho phép khách hàng tự nhập chỉ số điện nước từ ứng dụng Resident',
  },
];

const PAYMENT_SETTINGS: SettingItem[] = [
  {
    type: 'toggle',
    key: 'payment_auto_approve',
    label: 'Tự động duyệt thu chi',
    tooltip: 'Phiếu thu/chi được tự động duyệt ngay sau khi tạo, không cần xác nhận thủ công',
  },
];

const NOTIFICATION_SETTINGS: SettingItem[] = [
  {
    type: 'toggle',
    key: 'notification_invoice_reminder',
    label: 'Nhắc ngày lập hóa đơn',
    tooltip: 'Gửi thông báo nhắc nhở khi đến ngày lập hóa đơn hàng tháng',
  },
  {
    type: 'toggle',
    key: 'notification_payment_reminder',
    label: 'Nhắc hạn thanh toán',
    tooltip: 'Gửi thông báo nhắc nhở khách hàng khi sắp đến hạn thanh toán hóa đơn',
  },
];

// =============================================
// Reusable Setting Row Component with Tooltip
// =============================================

interface SettingRowProps {
  item: SettingItem;
  value: boolean | string | number;
  onChange: (key: string, value: boolean | string | number) => void;
}

function SettingRow({ item, value, onChange }: SettingRowProps) {
  return (
    <div className="flex items-center justify-between py-3">
      <div className="flex items-center gap-2 flex-1 min-w-0">
        <div className="space-y-0.5">
          <Label className="text-sm font-medium">{item.label}</Label>
        </div>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Info className="h-4 w-4 text-muted-foreground shrink-0 cursor-help" />
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-xs">
              <p>{item.tooltip}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>

      <div className="ml-4 shrink-0">
        {item.type === 'toggle' && (
          <Switch
            checked={value === true || value === 'true'}
            onCheckedChange={(checked) => onChange(item.key, checked)}
          />
        )}

        {item.type === 'select' && (
          <Select
            value={String(value)}
            onValueChange={(v) => onChange(item.key, v)}
          >
            <SelectTrigger className="w-[240px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {item.options.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {item.type === 'number' && (
          <div className="flex items-center gap-2">
            <NumberInput
              className="w-[100px]"
              min={item.min}
              max={item.max}
              value={Number(value)}
              onChange={(v) => onChange(item.key, v)}
            />
            {item.suffix && (
              <span className="text-sm text-muted-foreground">{item.suffix}</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// =============================================
// Settings Tab Content Component
// =============================================

interface SettingsTabContentProps {
  title: string;
  description: string;
  items: SettingItem[];
  settings: Record<string, boolean | string | number>;
  onSettingChange: (key: string, value: boolean | string | number) => void;
}

function SettingsTabContent({ title, description, items, settings, onSettingChange }: SettingsTabContentProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="divide-y">
          {items.map((item) => (
            <SettingRow
              key={item.key}
              item={item}
              value={settings[item.key] ?? (item.type === 'toggle' ? false : '')}
              onChange={onSettingChange}
            />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// =============================================
// Ngưỡng tự duyệt phiếu CHI (t5_23 — org-wide, chỉ Chủ sở hữu đổi được)
// Nguồn sự thật: app_private.ie_auto_approve_config qua RPC get/set.
// Bỏ trống = tự duyệt mọi phiếu chi thường; đặt số = chi >= ngưỡng sinh ở NHÁP.
// =============================================

function IeAutoApproveThresholdCard() {
  const qc = useQueryClient();
  const { data: threshold, isLoading } = useQuery({
    queryKey: ['ie-auto-approve-threshold'],
    queryFn: async (): Promise<number | null> => {
      const { data, error } = await (supabase as any).rpc('get_ie_auto_approve_threshold_v1');
      if (error) throw new Error(error.message);
      return data === null || data === undefined ? null : Number(data);
    },
  });
  const [value, setValue] = useState<number>(0);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setValue(threshold ?? 0);
  }, [threshold]);

  const save = async (v: number | null) => {
    setSaving(true);
    try {
      const { error } = await (supabase as any).rpc('set_ie_auto_approve_threshold_v1', {
        p_threshold: v,
      });
      if (error) throw new Error(error.message);
      qc.invalidateQueries({ queryKey: ['ie-auto-approve-threshold'] });
      toast.success(
        v === null
          ? 'Đã bỏ ngưỡng — mọi phiếu chi thường tự duyệt khi tạo'
          : `Đã đặt ngưỡng ${v.toLocaleString('vi-VN')}đ — phiếu chi từ mức này sinh ở NHÁP chờ duyệt`,
      );
    } catch (e) {
      toast.error((e as Error).message || 'Không lưu được ngưỡng');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Ngưỡng tự duyệt phiếu chi</CardTitle>
        <CardDescription>
          Phiếu CHI thường DƯỚI ngưỡng tự duyệt ngay khi tạo; từ ngưỡng trở lên sinh ở
          trạng thái Nháp chờ duyệt. Hạng mục đặc biệt (hoàn cọc, thanh lý, lương, lợi
          nhuận, hoa hồng, thưởng…) luôn phải duyệt bất kể số tiền. Phiếu thu không áp
          ngưỡng. Chỉ Chủ sở hữu tổ chức thay đổi được.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-3">
          <CurrencyInput value={value} onChange={(v: number) => setValue(v)} />
          <span className="text-sm text-muted-foreground">đ</span>
          <Button
            size="sm"
            disabled={saving || isLoading || !value || value <= 0}
            onClick={() => save(value)}
          >
            Lưu ngưỡng
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={saving || isLoading || threshold == null}
            onClick={() => save(null)}
          >
            Bỏ ngưỡng (tự duyệt tất cả)
          </Button>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {isLoading
            ? 'Đang tải…'
            : threshold == null
              ? 'Hiện chưa đặt ngưỡng — mọi phiếu chi thường đang tự duyệt.'
              : `Ngưỡng hiện tại: ${Number(threshold).toLocaleString('vi-VN')}đ.`}
        </p>
      </CardContent>
    </Card>
  );
}

// =============================================
// Main Page Component
// =============================================

const GeneralSettingsPage = () => {
  const logoInputRef = useRef<HTMLInputElement>(null);

  // General settings (individual keys)
  const { data: generalSettings, isLoading: loadingGeneral } = useGeneralSettings();
  const updateSetting = useUpdateGeneralSetting();

  // Company info (for logo upload in basic tab)
  const { data: companyInfo, isLoading: loadingCompany } = useCompanyInfo();
  const updateCompanyInfo = useUpdateCompanyInfo();

  // Geo-fence nghiệm thu (bật/tắt kiểm tra GPS + bán kính)
  const { data: geofence } = useAcceptanceGeofenceSetting();
  const updateGeofence = useUpdateAcceptanceGeofenceSetting();

  const handleSettingChange = (key: string, value: boolean | string | number) => {
    updateSetting.mutate({ key, value });
  };

  const handleLogoUpload = () => {
    logoInputRef.current?.click();
  };

  const handleLogoFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // For now, create a local URL preview. In production, upload to Supabase Storage.
    const url = URL.createObjectURL(file);
    if (companyInfo) {
      updateCompanyInfo.mutate({ ...companyInfo, company_logo_url: url });
    }
    toast.success('Dữ liệu đã được CẬP NHẬT thành công');
  };

  const isLoading = loadingGeneral || loadingCompany;

  if (isLoading) {
    return (
      <MainLayout>
        <div className="container mx-auto p-6">
          <p className="text-center text-muted-foreground">Đang tải cài đặt...</p>
        </div>
      </MainLayout>
    );
  }

  const settings = generalSettings ?? {};

  return (
    <MainLayout>
      <div className="container mx-auto p-6 max-w-4xl">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <div className="h-10 w-10 rounded-lg bg-gray-100 flex items-center justify-center">
            <Settings className="h-5 w-5 text-gray-600" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">Cài đặt chung</h1>
            <p className="text-sm text-muted-foreground">
              Quản lý cấu hình hệ thống cho hợp đồng, hóa đơn, thu chi và thông báo
            </p>
          </div>
        </div>

        {/* 5 Tabs */}
        <Tabs defaultValue="basic">
          <TabsList className="grid w-full grid-cols-5">
            <TabsTrigger value="basic">
              <Settings className="h-4 w-4 mr-2" />
              Cài đặt cơ bản
            </TabsTrigger>
            <TabsTrigger value="contract">
              <FileText className="h-4 w-4 mr-2" />
              Hợp đồng
            </TabsTrigger>
            <TabsTrigger value="invoice">
              <Receipt className="h-4 w-4 mr-2" />
              Hóa đơn
            </TabsTrigger>
            <TabsTrigger value="payment">
              <DollarSign className="h-4 w-4 mr-2" />
              Thu chi
            </TabsTrigger>
            <TabsTrigger value="notification">
              <Bell className="h-4 w-4 mr-2" />
              Thông báo
            </TabsTrigger>
          </TabsList>

          {/* Tab: Cài đặt cơ bản */}
          <TabsContent value="basic">
            <Card>
              <CardHeader>
                <CardTitle>Cài đặt cơ bản</CardTitle>
                <CardDescription>Upload logo và thông tin cơ bản của hệ thống</CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="space-y-4">
                  <Label>Logo công ty</Label>
                  <div className="flex items-center gap-4">
                    <div className="h-24 w-24 rounded-lg border-2 border-dashed border-gray-300 flex items-center justify-center overflow-hidden bg-gray-50">
                      {companyInfo?.company_logo_url ? (
                        <img
                          src={companyInfo.company_logo_url}
                          alt="Logo"
                          className="h-full w-full object-contain"
                        />
                      ) : (
                        <Upload className="h-8 w-8 text-gray-400" />
                      )}
                    </div>
                    <div className="space-y-2">
                      <Button variant="outline" onClick={handleLogoUpload}>
                        <Upload className="h-4 w-4 mr-2" />
                        Tải lên logo
                      </Button>
                      <p className="text-xs text-muted-foreground">
                        Định dạng: PNG, JPG, SVG. Kích thước tối đa: 2MB
                      </p>
                      <input
                        ref={logoInputRef}
                        type="file"
                        accept="image/png,image/jpeg,image/svg+xml"
                        className="hidden"
                        onChange={handleLogoFileChange}
                      />
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Geo-fence nghiệm thu công việc */}
            <Card className="mt-4">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <MapPin className="h-5 w-5 text-gray-600" />
                  Kiểm tra vị trí khi nghiệm thu
                </CardTitle>
                <CardDescription>
                  Khi nhân viên bấm "Hoàn thành công việc": luôn bắt chụp ảnh trực tiếp (gắn
                  ngày giờ + địa chỉ). Bật tuỳ chọn này để gắn thêm toạ độ GPS và cảnh báo nếu
                  chụp cách tòa quá bán kính cho phép (không chặn, chỉ ghi nhận để xem lại).
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex items-center justify-between py-3 border-b">
                  <div className="flex items-center gap-2">
                    <Label className="text-sm font-medium">Bật kiểm tra GPS (geo-fence)</Label>
                  </div>
                  <Switch
                    checked={geofence?.enabled ?? true}
                    onCheckedChange={(checked) =>
                      updateGeofence.mutate({
                        enabled: checked,
                        radius_m: geofence?.radius_m ?? 70,
                      })
                    }
                  />
                </div>
                <div className="flex items-center justify-between py-3">
                  <div className="flex items-center gap-2">
                    <Label className="text-sm font-medium">Bán kính cho phép</Label>
                  </div>
                  <div className="flex items-center gap-2">
                    <NumberInput
                      className="w-[100px]"
                      min={10}
                      max={2000}
                      value={geofence?.radius_m ?? 70}
                      onChange={(v) =>
                        updateGeofence.mutate({
                          enabled: geofence?.enabled ?? true,
                          radius_m: v,
                        })
                      }
                    />
                    <span className="text-sm text-muted-foreground">mét</span>
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Tab: Hợp đồng */}
          <TabsContent value="contract">
            <SettingsTabContent
              title="Cấu hình hợp đồng"
              description="Các tùy chọn liên quan đến quản lý hợp đồng thuê"
              items={CONTRACT_SETTINGS}
              settings={settings}
              onSettingChange={handleSettingChange}
            />
          </TabsContent>

          {/* Tab: Hóa đơn */}
          <TabsContent value="invoice">
            <SettingsTabContent
              title="Cấu hình hóa đơn"
              description="Các tùy chọn liên quan đến tạo và quản lý hóa đơn"
              items={INVOICE_SETTINGS}
              settings={settings}
              onSettingChange={handleSettingChange}
            />
          </TabsContent>

          {/* Tab: Thu chi */}
          <TabsContent value="payment">
            <div className="space-y-4">
              <SettingsTabContent
                title="Cấu hình thu chi"
                description="Các tùy chọn liên quan đến quản lý thu chi"
                items={PAYMENT_SETTINGS}
                settings={settings}
                onSettingChange={handleSettingChange}
              />
              <IeAutoApproveThresholdCard />
            </div>
          </TabsContent>

          {/* Tab: Thông báo */}
          <TabsContent value="notification">
            <SettingsTabContent
              title="Cấu hình thông báo"
              description="Các tùy chọn thông báo tự động cho hệ thống"
              items={NOTIFICATION_SETTINGS}
              settings={settings}
              onSettingChange={handleSettingChange}
            />
          </TabsContent>
        </Tabs>
      </div>
    </MainLayout>
  );
};

export default GeneralSettingsPage;
