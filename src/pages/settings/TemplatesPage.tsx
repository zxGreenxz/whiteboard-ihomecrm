import { useState, useMemo } from "react";
import MainLayout from "@/components/layout/MainLayout";
import {
  FileText,
  Plus,
  Pencil,
  Trash2,
  Download,
  Eye,
  Search,
  PenTool,
  FileSignature,
  Home,
  ClipboardList,
  Receipt,
  Wallet,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  useDocumentTemplatesByType,
  useUpdateDocumentTemplate,
  useDownloadTemplate,
  DocumentTemplate,
  TemplateType,
  TEMPLATE_TYPE_LABELS,
  TEMPLATE_TYPES,
  CATEGORY_LABELS,
} from "@/hooks/useDocumentTemplates";
import { CreateTemplateDialog } from "@/components/document-templates/CreateTemplateDialog";
import { EditTemplateDialog } from "@/components/document-templates/EditTemplateDialog";
import { DeleteTemplateDialog } from "@/components/document-templates/DeleteTemplateDialog";

const TAB_ICONS: Record<TemplateType, React.ReactNode> = {
  signature: <PenTool className="h-4 w-4" />,
  deposit_contract: <FileSignature className="h-4 w-4" />,
  lease_contract: <Home className="h-4 w-4" />,
  handover_report: <ClipboardList className="h-4 w-4" />,
  invoice: <Receipt className="h-4 w-4" />,
  receipt: <Wallet className="h-4 w-4" />,
};

interface TemplateListProps {
  templateType: TemplateType;
  onEdit: (template: DocumentTemplate) => void;
  onDelete: (template: DocumentTemplate) => void;
}

function TemplateList({ templateType, onEdit, onDelete }: TemplateListProps) {
  const [searchTerm, setSearchTerm] = useState("");
  const { data: templates, isLoading } = useDocumentTemplatesByType(templateType);
  const updateMutation = useUpdateDocumentTemplate();
  const downloadMutation = useDownloadTemplate();

  const filteredTemplates = useMemo(() => {
    if (!templates) return [];
    if (!searchTerm) return templates;
    const search = searchTerm.toLowerCase();
    return templates.filter(
      (t) =>
        t.name.toLowerCase().includes(search) ||
        t.code.toLowerCase().includes(search)
    );
  }, [templates, searchTerm]);

  const handleToggleDefault = async (template: DocumentTemplate) => {
    try {
      await updateMutation.mutateAsync({
        id: template.id,
        is_default: !template.is_default,
      });
    } catch {
      // Error handled by mutation
    }
  };

  const handleDownload = (template: DocumentTemplate) => {
    downloadMutation.mutate({
      fileUrl: template.file_url,
      fileName: template.file_name,
    });
  };

  const handleView = (template: DocumentTemplate) => {
    window.open(template.file_url, "_blank");
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-32">
        <p className="text-muted-foreground">Đang tải...</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
        <Input
          placeholder="Tìm kiếm mẫu..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="pl-10"
        />
      </div>

      {/* Variables info */}
      {templates && templates.length > 0 && templates.some((t) => t.variables && Array.isArray(t.variables) && t.variables.length > 0) && (
        <div className="text-xs text-muted-foreground bg-blue-50 p-3 rounded-lg">
          Mẫu biểu hỗ trợ biến thay thế (variables) để tự động điền thông tin khi in.
        </div>
      )}

      {/* Table */}
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[120px]">Mã</TableHead>
                <TableHead className="w-[100px]">Thao tác</TableHead>
                <TableHead>Tên mẫu</TableHead>
                <TableHead>Loại</TableHead>
                <TableHead className="w-[120px]">Xem mẫu PDF</TableHead>
                <TableHead className="w-[120px] text-center">Mặc định</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredTemplates.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center py-8">
                    <div className="flex flex-col items-center gap-2">
                      <FileText className="h-12 w-12 text-gray-300" />
                      <p className="text-muted-foreground">
                        {searchTerm
                          ? "Không tìm thấy mẫu nào"
                          : `Chưa có ${TEMPLATE_TYPE_LABELS[templateType]} nào. Nhấn 'Thêm mẫu' để tạo mới.`}
                      </p>
                    </div>
                  </TableCell>
                </TableRow>
              ) : (
                filteredTemplates.map((template) => (
                  <TableRow key={template.id}>
                    <TableCell className="font-medium text-green-600">
                      {template.code}
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-green-600 hover:text-green-700 hover:bg-green-50"
                          onClick={() => onEdit(template)}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-red-600 hover:text-red-700 hover:bg-red-50"
                          onClick={() => onDelete(template)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div>
                        <p className="font-medium">{template.name}</p>
                        {template.description && (
                          <p className="text-xs text-muted-foreground mt-1">
                            {template.description}
                          </p>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">
                        {template.type
                          ? TEMPLATE_TYPE_LABELS[template.type]
                          : CATEGORY_LABELS[template.category]}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        <Button
                          variant="link"
                          size="sm"
                          className="h-auto p-0 text-green-600"
                          onClick={() => handleView(template)}
                        >
                          <Eye className="h-3 w-3 mr-1" />
                          Xem
                        </Button>
                        <span className="text-gray-300">|</span>
                        <Button
                          variant="link"
                          size="sm"
                          className="h-auto p-0 text-green-600"
                          onClick={() => handleDownload(template)}
                        >
                          <Download className="h-3 w-3 mr-1" />
                          Tải
                        </Button>
                      </div>
                    </TableCell>
                    <TableCell className="text-center">
                      <Switch
                        checked={template.is_default}
                        onCheckedChange={() => handleToggleDefault(template)}
                        disabled={updateMutation.isPending}
                      />
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
          {filteredTemplates.length > 0 && (
            <div className="px-4 py-3 border-t text-sm text-muted-foreground text-right">
              1 - {filteredTemplates.length} trên tổng số {filteredTemplates.length} bản ghi
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

const TemplatesPage = () => {
  const [activeTab, setActiveTab] = useState<TemplateType>("signature");
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState<DocumentTemplate | null>(null);

  const handleEdit = (template: DocumentTemplate) => {
    setSelectedTemplate(template);
    setEditDialogOpen(true);
  };

  const handleDelete = (template: DocumentTemplate) => {
    setSelectedTemplate(template);
    setDeleteDialogOpen(true);
  };

  return (
    <MainLayout>
      <div className="container mx-auto p-6 max-w-7xl">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-lg bg-purple-100 flex items-center justify-center">
              <FileText className="h-5 w-5 text-purple-600" />
            </div>
            <div>
              <h1 className="text-2xl font-bold">Mẫu biểu</h1>
              <p className="text-sm text-muted-foreground">
                Quản lý 6 loại mẫu biểu: chữ ký, hợp đồng, biên bản, hóa đơn, thu chi
              </p>
            </div>
          </div>

          <Button
            onClick={() => setCreateDialogOpen(true)}
            className="bg-green-600 hover:bg-green-700"
          >
            <Plus className="h-4 w-4 mr-2" />
            Thêm mẫu
          </Button>
        </div>

        {/* Tabs for 6 template types */}
        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as TemplateType)}>
          <TabsList className="mb-4 flex flex-wrap h-auto gap-1">
            {TEMPLATE_TYPES.map((type) => (
              <TabsTrigger key={type} value={type} className="flex items-center gap-1.5">
                {TAB_ICONS[type]}
                {TEMPLATE_TYPE_LABELS[type]}
              </TabsTrigger>
            ))}
          </TabsList>

          {TEMPLATE_TYPES.map((type) => (
            <TabsContent key={type} value={type}>
              <TemplateList
                templateType={type}
                onEdit={handleEdit}
                onDelete={handleDelete}
              />
            </TabsContent>
          ))}
        </Tabs>

        {/* Dialogs */}
        <CreateTemplateDialog
          open={createDialogOpen}
          onOpenChange={setCreateDialogOpen}
        />

        <EditTemplateDialog
          open={editDialogOpen}
          onOpenChange={setEditDialogOpen}
          template={selectedTemplate}
        />

        <DeleteTemplateDialog
          open={deleteDialogOpen}
          onOpenChange={setDeleteDialogOpen}
          template={selectedTemplate}
        />
      </div>
    </MainLayout>
  );
};

export default TemplatesPage;
