import { FileDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DateInput } from '@/components/ui/date-input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { useContractDraftEditor } from './useContractDraftEditor';

export function ContractDraftDocuments({ editor, canExport }: {
  editor: ReturnType<typeof useContractDraftEditor>; canExport: boolean;
}) {
  const { templatesQuery, templates, templateId, setTemplateId, owner, setOwner, current, pending } = editor;
  return <div className="space-y-3 border-t pt-4">
    <div className="space-y-2"><Label>Mẫu hợp đồng</Label>
      {templatesQuery.isError ? <p className="text-destructive text-sm">Không thể tải mẫu. <Button type="button" variant="link" onClick={() => void templatesQuery.refetch()}>Thử lại</Button></p>
        : <Select value={templateId || 'NO_TEMPLATE'} onValueChange={value => {
          // Radix can emit an empty value while async options arrive. Clearing is explicit.
          if (value) setTemplateId(value === 'NO_TEMPLATE' ? '' : value);
        }} disabled={pending || templatesQuery.isLoading}>
          <SelectTrigger><SelectValue placeholder="Chọn mẫu hợp đồng" /></SelectTrigger>
          <SelectContent><SelectItem value="NO_TEMPLATE">Chưa chọn mẫu (chỉ lưu nháp)</SelectItem>
            {templates.map(t => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
          </SelectContent>
        </Select>}
      {templateId && <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => setTemplateId('')}>Bỏ chọn mẫu</Button>}
      {templateId && !templatesQuery.isLoading && !templates.some(t => t.id === templateId) && <p className="text-xs text-muted-foreground">Mẫu đã ngừng hoạt động hoặc bị xoá. Chọn mẫu mới để xuất tiếp; tài liệu đã xuất vẫn tải được.</p>}
    </div>
    <details><summary className="cursor-pointer text-sm font-medium">Thông tin chủ nhà trên tài liệu</summary>
      <p className="my-2 text-xs text-muted-foreground">Tên và điện thoại để trống sẽ lấy từ hồ sơ chủ toà. Giấy tờ chỉ điền khi mẫu yêu cầu.</p>
      <div className="grid gap-3 md:grid-cols-3">{([
        ['name', 'Tên chủ nhà'], ['phone', 'Điện thoại chủ nhà'], ['id_number', 'CCCD/hộ chiếu chủ nhà'],
        ['id_issue_place', 'Nơi cấp giấy tờ'], ['id_issue_date', 'Ngày cấp giấy tờ'], ['birthday', 'Ngày sinh chủ nhà'],
      ] as const).map(([key, label]) => <div key={key} className="space-y-1"><Label htmlFor={`contract-owner-${key}`}>{label}</Label>
        {key === 'id_issue_date' || key === 'birthday'
          ? <DateInput name={`contract-owner-${key}`} value={owner[key]} onChange={value => setOwner(previous => ({ ...previous, [key]: value }))} />
          : <Input id={`contract-owner-${key}`} value={owner[key]} onChange={event => setOwner(previous => ({ ...previous, [key]: event.target.value }))} />}
      </div>)}</div>
    </details>
    {canExport && <div className="flex flex-wrap gap-2">
      <Button type="button" variant="outline" disabled={pending} onClick={() => void editor.persist({ exportAfter: true })}><FileDown className="mr-2 h-4 w-4" />Lưu và xuất nháp .docx</Button>
      {current?.documents.map(document => <Button key={document.id} type="button" variant="ghost" size="sm" disabled={pending} onClick={() => editor.download.mutate(document)}>
        Nháp v{document.revision} · {document.template_snapshot.name}
      </Button>)}
    </div>}
  </div>;
}
