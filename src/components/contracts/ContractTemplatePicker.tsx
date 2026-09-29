import { FileText, Loader2 } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import type { DocumentTemplate } from '@/hooks/useDocumentTemplates';

export type ContractTemplateOption = Pick<DocumentTemplate, 'id' | 'name' | 'file_name' | 'is_default' | 'is_active'>;

/** The lease template chooser used by official contracts and saved drafts. */
export function ContractTemplatePicker({ templates, selectedId, onSelect, isLoading, isError = false, idPrefix = 'tpl' }: {
  templates: ContractTemplateOption[]; selectedId: string; onSelect: (id: string) => void;
  isLoading: boolean; isError?: boolean; idPrefix?: string;
}) {
  return <div>
    <Label className="text-sm font-medium">Chọn mẫu hợp đồng</Label>
    {isLoading ? <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
      <Loader2 className="h-4 w-4 animate-spin" /> Đang tải mẫu…
    </div> : isError ? <p role="alert" className="py-4 text-sm text-destructive">Không thể tải danh sách mẫu hợp đồng.</p>
      : templates.length === 0 ? <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground text-center">
        Chưa có mẫu HĐ thuê. Vào <span className="font-medium">Cài đặt → Mẫu biểu</span> để tải lên.
      </div> : <RadioGroup value={selectedId} onValueChange={onSelect} className="mt-2 space-y-1 max-h-64 overflow-auto">
        {templates.map(template => <Label key={template.id} htmlFor={`${idPrefix}-${template.id}`}
          className="flex items-center gap-3 rounded border px-3 py-2 cursor-pointer hover:bg-muted/50">
          <RadioGroupItem value={template.id} id={`${idPrefix}-${template.id}`} />
          <FileText className="h-4 w-4 text-muted-foreground" />
          <span className="flex-1 text-sm">{template.name}{template.is_default && <span className="ml-2 text-xs bg-blue-100 text-blue-800 px-1.5 py-0.5 rounded">Mặc định</span>}
            {!template.is_active && <span className="ml-2 text-xs text-muted-foreground">Bản đã xuất</span>}</span>
          <span className="text-xs text-muted-foreground truncate max-w-[160px]">{template.file_name}</span>
        </Label>)}
      </RadioGroup>}
  </div>;
}
