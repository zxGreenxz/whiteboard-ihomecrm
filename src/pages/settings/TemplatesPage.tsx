import { useState } from 'react';
import { FileText, Upload, Download, Trash2, Star, Eye, Plus } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
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
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { format } from 'date-fns';
import { vi } from 'date-fns/locale';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';

// Note: This page requires a 'templates' table in the database.
// For now, it serves as a complete UI implementation showing the concept.
// Database migration needed for full functionality.

// =============================================
// MOCK DATA (for demonstration)
// =============================================

const MOCK_TEMPLATES = [
  {
    id: '1',
    name: 'Hợp đồng thuê phòng chuẩn',
    type: 'CONTRACT' as const,
    file_name: 'hop-dong-thue-phong.docx',
    file_size: 45600,
    description: 'Mẫu hợp đồng chuẩn cho thuê phòng trọ',
    is_default: true,
    created_at: '2025-01-15T10:00:00Z',
  },
  {
    id: '2',
    name: 'Hóa đơn tiền phòng A4',
    type: 'INVOICE' as const,
    file_name: 'hoa-don-a4.docx',
    file_size: 23400,
    description: 'Mẫu hóa đơn khổ A4',
    is_default: true,
    created_at: '2025-01-15T10:00:00Z',
  },
  {
    id: '3',
    name: 'Hóa đơn nhiệt 80mm',
    type: 'INVOICE' as const,
    file_name: 'hoa-don-thermal.docx',
    file_size: 18200,
    description: 'Mẫu hóa đơn cho máy in nhiệt 80mm',
    is_default: false,
    created_at: '2025-01-16T10:00:00Z',
  },
];

// =============================================
// TYPES
// =============================================

type TemplateType = 'CONTRACT' | 'INVOICE' | 'RECEIPT';

const uploadSchema = z.object({
  name: z.string().min(1, 'Tên mẫu biểu là bắt buộc'),
  type: z.enum(['CONTRACT', 'INVOICE', 'RECEIPT']),
  description: z.string().optional(),
  file: z.any().refine((files) => files?.length > 0, 'File là bắt buộc'),
});

// =============================================
// MAIN COMPONENT
// =============================================

const TemplatesPage = () => {
  const [activeTab, setActiveTab] = useState<TemplateType>('CONTRACT');
  const [isUploadOpen, setIsUploadOpen] = useState(false);

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Quản lý Mẫu biểu</h1>
          <p className="text-muted-foreground mt-2">
            Tải lên và quản lý mẫu hợp đồng, hóa đơn, phiếu thu
          </p>
        </div>
        <Dialog open={isUploadOpen} onOpenChange={setIsUploadOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="h-4 w-4 mr-2" />
              Tải lên mẫu biểu
            </Button>
          </DialogTrigger>
          <UploadTemplateDialog onClose={() => setIsUploadOpen(false)} />
        </Dialog>
      </div>

      {/* Database Alert */}
      <Alert>
        <AlertDescription>
          <strong>Lưu ý:</strong> Tính năng này yêu cầu bảng <code>templates</code> trong database.
          Hiện tại đang sử dụng mock data để minh họa giao diện.
        </AlertDescription>
      </Alert>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as TemplateType)}>
        <TabsList>
          <TabsTrigger value="CONTRACT">
            <FileText className="h-4 w-4 mr-2" />
            Hợp đồng
          </TabsTrigger>
          <TabsTrigger value="INVOICE">
            <FileText className="h-4 w-4 mr-2" />
            Hóa đơn
          </TabsTrigger>
          <TabsTrigger value="RECEIPT">
            <FileText className="h-4 w-4 mr-2" />
            Phiếu thu
          </TabsTrigger>
        </TabsList>

        <TabsContent value="CONTRACT">
          <TemplatesList type="CONTRACT" templates={MOCK_TEMPLATES.filter(t => t.type === 'CONTRACT')} />
        </TabsContent>

        <TabsContent value="INVOICE">
          <TemplatesList type="INVOICE" templates={MOCK_TEMPLATES.filter(t => t.type === 'INVOICE')} />
        </TabsContent>

        <TabsContent value="RECEIPT">
          <TemplatesList type="RECEIPT" templates={MOCK_TEMPLATES.filter(t => t.type === 'RECEIPT')} />
        </TabsContent>
      </Tabs>

      {/* Variables Reference */}
      <Card>
        <CardHeader>
          <CardTitle>Biến động (Variables)</CardTitle>
          <CardDescription>
            Các biến có thể sử dụng trong mẫu biểu. Click để copy vào clipboard.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <VariablesReference type={activeTab} />
        </CardContent>
      </Card>
    </div>
  );
};

// =============================================
// TEMPLATES LIST
// =============================================

interface TemplatesListProps {
  type: TemplateType;
  templates: typeof MOCK_TEMPLATES;
}

const TemplatesList = ({ templates }: TemplatesListProps) => {
  if (templates.length === 0) {
    return (
      <Card>
        <CardContent className="py-12">
          <div className="text-center text-muted-foreground">
            <FileText className="h-12 w-12 mx-auto mb-4 opacity-50" />
            <p>Chưa có mẫu biểu nào</p>
            <p className="text-sm mt-2">Click "Tải lên mẫu biểu" để thêm mẫu mới</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Tên mẫu</TableHead>
              <TableHead>File</TableHead>
              <TableHead>Kích thước</TableHead>
              <TableHead>Mặc định</TableHead>
              <TableHead>Ngày tạo</TableHead>
              <TableHead className="text-right">Thao tác</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {templates.map((template) => (
              <TableRow key={template.id}>
                <TableCell>
                  <div>
                    <div className="font-medium">{template.name}</div>
                    {template.description && (
                      <div className="text-sm text-muted-foreground">{template.description}</div>
                    )}
                  </div>
                </TableCell>
                <TableCell>
                  <code className="text-xs bg-muted px-2 py-1 rounded">
                    {template.file_name}
                  </code>
                </TableCell>
                <TableCell>{formatFileSize(template.file_size)}</TableCell>
                <TableCell>
                  {template.is_default && (
                    <Badge variant="default" className="gap-1">
                      <Star className="h-3 w-3 fill-current" />
                      Mặc định
                    </Badge>
                  )}
                </TableCell>
                <TableCell>
                  {format(new Date(template.created_at), 'dd/MM/yyyy', { locale: vi })}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex items-center justify-end gap-2">
                    <Button variant="ghost" size="icon" title="Xem trước">
                      <Eye className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" title="Tải xuống">
                      <Download className="h-4 w-4" />
                    </Button>
                    {!template.is_default && (
                      <Button variant="ghost" size="icon" title="Đặt làm mặc định">
                        <Star className="h-4 w-4" />
                      </Button>
                    )}
                    <Button variant="ghost" size="icon" title="Xóa" className="text-destructive">
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
};

// =============================================
// UPLOAD TEMPLATE DIALOG
// =============================================

interface UploadTemplateDialogProps {
  onClose: () => void;
}

const UploadTemplateDialog = ({ onClose }: UploadTemplateDialogProps) => {
  const form = useForm({
    resolver: zodResolver(uploadSchema),
    defaultValues: {
      name: '',
      type: 'CONTRACT' as TemplateType,
      description: '',
    },
  });

  const onSubmit = (data: any) => {
    console.log('Upload template:', data);
    onClose();
  };

  return (
    <DialogContent className="sm:max-w-[600px]">
      <DialogHeader>
        <DialogTitle>Tải lên mẫu biểu</DialogTitle>
        <DialogDescription>
          Tải lên file Word (.docx) chứa mẫu biểu.
        </DialogDescription>
      </DialogHeader>

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <FormField
            control={form.control}
            name="name"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Tên mẫu biểu *</FormLabel>
                <FormControl>
                  <Input placeholder="VD: Hợp đồng thuê phòng chuẩn" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="type"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Loại mẫu biểu *</FormLabel>
                <Select onValueChange={field.onChange} defaultValue={field.value}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="Chọn loại" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value="CONTRACT">Hợp đồng</SelectItem>
                    <SelectItem value="INVOICE">Hóa đơn</SelectItem>
                    <SelectItem value="RECEIPT">Phiếu thu</SelectItem>
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="description"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Mô tả</FormLabel>
                <FormControl>
                  <Textarea
                    placeholder="Mô tả ngắn gọn về mẫu biểu này"
                    rows={3}
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="file"
            render={({ field: { onChange, value, ...field } }) => (
              <FormItem>
                <FormLabel>File mẫu biểu *</FormLabel>
                <FormControl>
                  <Input
                    type="file"
                    accept=".docx,.doc"
                    onChange={(e) => onChange(e.target.files)}
                    {...field}
                  />
                </FormControl>
                <FormDescription>Chỉ hỗ trợ file .docx và .doc</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Hủy
            </Button>
            <Button type="submit">
              <Upload className="h-4 w-4 mr-2" />
              Tải lên
            </Button>
          </DialogFooter>
        </form>
      </Form>
    </DialogContent>
  );
};

// =============================================
// VARIABLES REFERENCE
// =============================================

interface VariablesReferenceProps {
  type: TemplateType;
}

const VariablesReference = ({ type }: VariablesReferenceProps) => {
  const variables = getVariablesForType(type);

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {variables.map((variable) => (
        <div
          key={variable.key}
          className="flex items-start gap-2 p-3 border rounded-lg hover:bg-accent/50 cursor-pointer"
          onClick={() => navigator.clipboard.writeText(variable.key)}
          title="Click để copy"
        >
          <code className="text-sm font-mono bg-muted px-2 py-1 rounded flex-shrink-0">
            {variable.key}
          </code>
          <span className="text-sm text-muted-foreground">{variable.label}</span>
        </div>
      ))}
    </div>
  );
};

// =============================================
// HELPER FUNCTIONS
// =============================================

const formatFileSize = (bytes: number): string => {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
};

const getVariablesForType = (type: TemplateType) => {
  const commonVariables = [
    { key: '{company_name}', label: 'Tên công ty' },
    { key: '{company_address}', label: 'Địa chỉ công ty' },
    { key: '{company_phone}', label: 'SĐT công ty' },
    { key: '{today}', label: 'Ngày hôm nay' },
  ];

  const contractVariables = [
    ...commonVariables,
    { key: '{contract_number}', label: 'Số hợp đồng' },
    { key: '{tenant_name}', label: 'Tên khách thuê' },
    { key: '{tenant_phone}', label: 'SĐT khách' },
    { key: '{room_name}', label: 'Tên phòng' },
    { key: '{rent_price}', label: 'Giá thuê' },
    { key: '{deposit_amount}', label: 'Tiền cọc' },
  ];

  const invoiceVariables = [
    ...commonVariables,
    { key: '{invoice_number}', label: 'Số hóa đơn' },
    { key: '{invoice_date}', label: 'Ngày hóa đơn' },
    { key: '{tenant_name}', label: 'Tên khách' },
    { key: '{room_name}', label: 'Phòng' },
    { key: '{total_amount}', label: 'Tổng tiền' },
  ];

  const receiptVariables = [
    ...commonVariables,
    { key: '{receipt_number}', label: 'Số phiếu thu' },
    { key: '{amount}', label: 'Số tiền' },
    { key: '{amount_in_words}', label: 'Số tiền (chữ)' },
    { key: '{tenant_name}', label: 'Tên khách' },
  ];

  switch (type) {
    case 'CONTRACT':
      return contractVariables;
    case 'INVOICE':
      return invoiceVariables;
    case 'RECEIPT':
      return receiptVariables;
    default:
      return commonVariables;
  }
};

export default TemplatesPage;
