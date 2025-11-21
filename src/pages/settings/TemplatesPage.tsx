import { useState, useMemo } from "react";
import {
  FileText,
  Plus,
  Pencil,
  Trash2,
  Download,
  Eye,
  Search,
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
import {
  useDocumentTemplates,
  useUpdateDocumentTemplate,
  useDownloadTemplate,
  DocumentTemplate,
  CATEGORY_LABELS,
} from "@/hooks/useDocumentTemplates";
import { CreateTemplateDialog } from "@/components/document-templates/CreateTemplateDialog";
import { EditTemplateDialog } from "@/components/document-templates/EditTemplateDialog";
import { DeleteTemplateDialog } from "@/components/document-templates/DeleteTemplateDialog";

const TemplatesPage = () => {
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState<DocumentTemplate | null>(null);
  const [searchTerm, setSearchTerm] = useState("");

  const { data: templates, isLoading } = useDocumentTemplates();
  const updateMutation = useUpdateDocumentTemplate();
  const downloadMutation = useDownloadTemplate();

  // Filter templates by search term
  const filteredTemplates = useMemo(() => {
    if (!templates) return [];
    if (!searchTerm) return templates;

    const search = searchTerm.toLowerCase();
    return templates.filter(
      (template) =>
        template.name.toLowerCase().includes(search) ||
        template.code.toLowerCase().includes(search) ||
        CATEGORY_LABELS[template.category].toLowerCase().includes(search)
    );
  }, [templates, searchTerm]);

  const handleEdit = (template: DocumentTemplate) => {
    setSelectedTemplate(template);
    setEditDialogOpen(true);
  };

  const handleDelete = (template: DocumentTemplate) => {
    setSelectedTemplate(template);
    setDeleteDialogOpen(true);
  };

  const handleToggleDefault = async (template: DocumentTemplate) => {
    try {
      await updateMutation.mutateAsync({
        id: template.id,
        is_default: !template.is_default,
      });
    } catch (error) {
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
      <div className="container mx-auto p-6 max-w-7xl">
        <div className="flex items-center justify-center h-64">
          <p className="text-muted-foreground">Đang tải...</p>
        </div>
      </div>
    );
  }

  return (
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
              Quản lý mẫu hợp đồng, hóa đơn và biên lai
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

      {/* Search */}
      <Card className="mb-6">
        <CardContent className="p-4">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
            <Input
              placeholder="Tìm kiếm..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-10"
            />
          </div>
        </CardContent>
      </Card>

      {/* Templates Table */}
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
                          : "Chưa có mẫu nào. Nhấn 'Thêm mẫu' để tạo mới."}
                      </p>
                    </div>
                  </TableCell>
                </TableRow>
              ) : (
                filteredTemplates.map((template) => (
                  <TableRow key={template.id}>
                    {/* Code */}
                    <TableCell className="font-medium text-green-600">
                      {template.code}
                    </TableCell>

                    {/* Actions */}
                    <TableCell>
                      <div className="flex gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-green-600 hover:text-green-700 hover:bg-green-50"
                          onClick={() => handleEdit(template)}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-red-600 hover:text-red-700 hover:bg-red-50"
                          onClick={() => handleDelete(template)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>

                    {/* Name */}
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

                    {/* Category */}
                    <TableCell>
                      <Badge variant="outline">
                        {CATEGORY_LABELS[template.category]}
                      </Badge>
                    </TableCell>

                    {/* View/Download */}
                    <TableCell>
                      <div className="flex gap-1">
                        <Button
                          variant="link"
                          size="sm"
                          className="h-auto p-0 text-green-600"
                          onClick={() => handleView(template)}
                        >
                          <Eye className="h-3 w-3 mr-1" />
                          Xem mẫu
                        </Button>
                        <span className="text-gray-300">|</span>
                        <Button
                          variant="link"
                          size="sm"
                          className="h-auto p-0 text-green-600"
                          onClick={() => handleDownload(template)}
                        >
                          <Download className="h-3 w-3 mr-1" />
                          Tải xuống
                        </Button>
                      </div>
                    </TableCell>

                    {/* Default Toggle */}
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

          {/* Footer with pagination info */}
          {filteredTemplates.length > 0 && (
            <div className="px-4 py-3 border-t text-sm text-muted-foreground text-right">
              1 - {filteredTemplates.length} trên tổng số {filteredTemplates.length} bản ghi
            </div>
          )}
        </CardContent>
      </Card>

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
  );
};

export default TemplatesPage;
