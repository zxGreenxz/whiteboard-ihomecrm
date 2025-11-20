import { useState, useRef } from 'react';
import { FileSignature, Upload, Pencil, Type, Trash2, Check, X, Plus } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { cn } from '@/lib/utils';

// =============================================
// MOCK DATA (for demonstration)
// Actual implementation will use signature_templates table
// =============================================

const MOCK_SIGNATURES = [
  {
    id: '1',
    code: 'SIG001',
    name: 'Chữ ký giám đốc',
    signature_type: 'UPLOAD' as const,
    signature_url: '/placeholder-signature.png',
    is_active: true,
    created_at: '2025-01-15T10:00:00Z',
  },
  {
    id: '2',
    code: 'SIG002',
    name: 'Chữ ký kế toán',
    signature_type: 'DRAW' as const,
    is_active: true,
    created_at: '2025-01-16T10:00:00Z',
  },
  {
    id: '3',
    code: 'SIG003',
    name: 'Chữ ký văn bản',
    signature_type: 'TEXT' as const,
    text_content: 'Nguyễn Văn A',
    font_style: 'dancing-script',
    is_active: false,
    created_at: '2025-01-17T10:00:00Z',
  },
];

// =============================================
// TYPES
// =============================================

type SignatureType = 'UPLOAD' | 'DRAW' | 'TEXT';

const signatureSchema = z.object({
  code: z.string().min(1, 'Mã chữ ký là bắt buộc'),
  name: z.string().min(1, 'Tên là bắt buộc'),
  signatureType: z.enum(['UPLOAD', 'DRAW', 'TEXT']),
});

// =============================================
// MAIN COMPONENT
// =============================================

const SignaturesPage = () => {
  const [isCreateOpen, setIsCreateOpen] = useState(false);

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Quản lý Mẫu chữ ký</h1>
          <p className="text-muted-foreground mt-2">
            Tạo và quản lý chữ ký điện tử cho hợp đồng và tài liệu
          </p>
        </div>
        <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="h-4 w-4 mr-2" />
              Tạo chữ ký mới
            </Button>
          </DialogTrigger>
          <CreateSignatureDialog onClose={() => setIsCreateOpen(false)} />
        </Dialog>
      </div>

      {/* Database Note */}
      <Alert>
        <AlertDescription>
          Tính năng này sử dụng bảng <code>signature_templates</code> đã có sẵn trong database.
          Hiện tại đang dùng mock data để minh họa.
        </AlertDescription>
      </Alert>

      {/* Signatures List */}
      <Card>
        <CardHeader>
          <CardTitle>Danh sách chữ ký</CardTitle>
          <CardDescription>
            Quản lý các mẫu chữ ký điện tử của bạn
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SignaturesList signatures={MOCK_SIGNATURES} />
        </CardContent>
      </Card>
    </div>
  );
};

// =============================================
// SIGNATURES LIST
// =============================================

interface SignaturesListProps {
  signatures: typeof MOCK_SIGNATURES;
}

const SignaturesList = ({ signatures }: SignaturesListProps) => {
  if (signatures.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        <FileSignature className="h-12 w-12 mx-auto mb-4 opacity-50" />
        <p>Chưa có chữ ký nào</p>
        <p className="text-sm mt-2">Click "Tạo chữ ký mới" để bắt đầu</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {signatures.map((signature) => (
        <SignatureCard key={signature.id} signature={signature} />
      ))}
    </div>
  );
};

// =============================================
// SIGNATURE CARD
// =============================================

interface SignatureCardProps {
  signature: typeof MOCK_SIGNATURES[0];
}

const SignatureCard = ({ signature }: SignatureCardProps) => {
  return (
    <Card className={cn(!signature.is_active && 'opacity-60')}>
      <CardHeader>
        <div className="flex items-start justify-between">
          <div className="space-y-1">
            <CardTitle className="text-base">{signature.name}</CardTitle>
            <code className="text-xs text-muted-foreground">{signature.code}</code>
          </div>
          <Badge variant={signature.signature_type === 'UPLOAD' ? 'default' : signature.signature_type === 'DRAW' ? 'secondary' : 'outline'}>
            {getSignatureTypeLabel(signature.signature_type)}
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        {/* Preview */}
        <div className="border rounded-lg p-4 h-32 flex items-center justify-center bg-muted/30 mb-4">
          {signature.signature_type === 'UPLOAD' && signature.signature_url && (
            <img
              src={signature.signature_url}
              alt={signature.name}
              className="max-h-full max-w-full object-contain"
            />
          )}
          {signature.signature_type === 'DRAW' && (
            <div className="text-muted-foreground">
              <Pencil className="h-8 w-8" />
            </div>
          )}
          {signature.signature_type === 'TEXT' && signature.text_content && (
            <div className={cn('text-2xl', getFontClass(signature.font_style))}>
              {signature.text_content}
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2">
          {signature.is_active ? (
            <Badge variant="success" className="gap-1">
              <Check className="h-3 w-3" />
              Đang dùng
            </Badge>
          ) : (
            <Button variant="outline" size="sm" className="flex-1">
              Kích hoạt
            </Button>
          )}
          <Button variant="ghost" size="icon" className="text-destructive">
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
};

// =============================================
// CREATE SIGNATURE DIALOG
// =============================================

interface CreateSignatureDialogProps {
  onClose: () => void;
}

const CreateSignatureDialog = ({ onClose }: CreateSignatureDialogProps) => {
  const [signatureType, setSignatureType] = useState<SignatureType>('UPLOAD');

  const form = useForm({
    resolver: zodResolver(signatureSchema),
    defaultValues: {
      code: '',
      name: '',
      signatureType: 'UPLOAD' as SignatureType,
    },
  });

  const onSubmit = (data: any) => {
    console.log('Create signature:', data);
    onClose();
  };

  return (
    <DialogContent className="sm:max-w-[700px]">
      <DialogHeader>
        <DialogTitle>Tạo chữ ký mới</DialogTitle>
        <DialogDescription>
          Chọn phương thức và tạo chữ ký điện tử
        </DialogDescription>
      </DialogHeader>

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
          {/* Basic Info */}
          <div className="grid grid-cols-2 gap-4">
            <FormField
              control={form.control}
              name="code"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Mã chữ ký *</FormLabel>
                  <FormControl>
                    <Input placeholder="VD: SIG001" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Tên *</FormLabel>
                  <FormControl>
                    <Input placeholder="VD: Chữ ký giám đốc" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          {/* Signature Type */}
          <FormField
            control={form.control}
            name="signatureType"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Phương thức *</FormLabel>
                <Tabs
                  value={field.value}
                  onValueChange={(value) => {
                    field.onChange(value);
                    setSignatureType(value as SignatureType);
                  }}
                >
                  <TabsList className="grid w-full grid-cols-3">
                    <TabsTrigger value="UPLOAD">
                      <Upload className="h-4 w-4 mr-2" />
                      Tải lên
                    </TabsTrigger>
                    <TabsTrigger value="DRAW">
                      <Pencil className="h-4 w-4 mr-2" />
                      Vẽ tay
                    </TabsTrigger>
                    <TabsTrigger value="TEXT">
                      <Type className="h-4 w-4 mr-2" />
                      Văn bản
                    </TabsTrigger>
                  </TabsList>

                  {/* Upload Tab */}
                  <TabsContent value="UPLOAD" className="space-y-4">
                    <div className="border-2 border-dashed rounded-lg p-8">
                      <div className="text-center">
                        <Upload className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
                        <p className="text-sm text-muted-foreground mb-4">
                          Tải lên file ảnh chữ ký (PNG, JPG)
                        </p>
                        <Input
                          type="file"
                          accept="image/png,image/jpeg,image/jpg"
                          className="max-w-sm mx-auto"
                        />
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Khuyến nghị: Ảnh nền trong suốt (PNG) kích thước 200x80px
                    </p>
                  </TabsContent>

                  {/* Draw Tab */}
                  <TabsContent value="DRAW" className="space-y-4">
                    <DrawSignatureCanvas />
                    <p className="text-xs text-muted-foreground">
                      Dùng chuột hoặc tay để vẽ chữ ký. Click "Xóa" để vẽ lại.
                    </p>
                  </TabsContent>

                  {/* Text Tab */}
                  <TabsContent value="TEXT" className="space-y-4">
                    <div className="space-y-4">
                      <div>
                        <label className="text-sm font-medium">Nội dung chữ ký</label>
                        <Input
                          placeholder="VD: Nguyễn Văn A"
                          className="mt-1.5"
                        />
                      </div>

                      <div>
                        <label className="text-sm font-medium">Font chữ</label>
                        <Select defaultValue="dancing-script">
                          <SelectTrigger className="mt-1.5">
                            <SelectValue placeholder="Chọn font" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="dancing-script">Dancing Script (Thảo)</SelectItem>
                            <SelectItem value="great-vibes">Great Vibes (Nghệ thuật)</SelectItem>
                            <SelectItem value="pacifico">Pacifico (Đậm)</SelectItem>
                            <SelectItem value="caveat">Caveat (Tự nhiên)</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>

                      {/* Preview */}
                      <div className="border rounded-lg p-6 bg-muted/30">
                        <p className="text-sm text-muted-foreground mb-2">Xem trước:</p>
                        <div className="text-center">
                          <span className="text-3xl font-['Dancing_Script']">
                            Nguyễn Văn A
                          </span>
                        </div>
                      </div>
                    </div>
                  </TabsContent>
                </Tabs>
                <FormMessage />
              </FormItem>
            )}
          />

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Hủy
            </Button>
            <Button type="submit">
              <Check className="h-4 w-4 mr-2" />
              Tạo chữ ký
            </Button>
          </DialogFooter>
        </form>
      </Form>
    </DialogContent>
  );
};

// =============================================
// DRAW SIGNATURE CANVAS
// =============================================

const DrawSignatureCanvas = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isDrawing, setIsDrawing] = useState(false);

  const startDrawing = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    setIsDrawing(true);
    ctx.beginPath();
    ctx.moveTo(e.clientX - rect.left, e.clientY - rect.top);
  };

  const draw = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDrawing) return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.lineTo(e.clientX - rect.left, e.clientY - rect.top);
    ctx.stroke();
  };

  const stopDrawing = () => {
    setIsDrawing(false);
  };

  const clearCanvas = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
  };

  return (
    <div className="space-y-2">
      <canvas
        ref={canvasRef}
        width={600}
        height={200}
        className="border rounded-lg cursor-crosshair bg-white"
        onMouseDown={startDrawing}
        onMouseMove={draw}
        onMouseUp={stopDrawing}
        onMouseLeave={stopDrawing}
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={clearCanvas}
      >
        <X className="h-4 w-4 mr-2" />
        Xóa và vẽ lại
      </Button>
    </div>
  );
};

// =============================================
// HELPER FUNCTIONS
// =============================================

const getSignatureTypeLabel = (type: SignatureType): string => {
  const labels: Record<SignatureType, string> = {
    UPLOAD: 'Tải lên',
    DRAW: 'Vẽ tay',
    TEXT: 'Văn bản',
  };
  return labels[type] || type;
};

const getFontClass = (fontStyle?: string | null): string => {
  const fonts: Record<string, string> = {
    'dancing-script': "font-['Dancing_Script']",
    'great-vibes': "font-['Great_Vibes']",
    'pacifico': "font-['Pacifico']",
    'caveat': "font-['Caveat']",
  };
  return fonts[fontStyle || 'dancing-script'] || fonts['dancing-script'];
};

export default SignaturesPage;
