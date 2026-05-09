import { useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Search, Copy, Check } from "lucide-react";
import { toast } from "sonner";

import {
  CONTRACT_TEMPLATE_CODE_SECTIONS,
  TOTAL_CONTRACT_CODES,
} from "@/lib/contractTemplateCodes";

interface TemplateCodesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function TemplateCodesDialog({
  open,
  onOpenChange,
}: TemplateCodesDialogProps) {
  const [search, setSearch] = useState("");
  const [copied, setCopied] = useState<string | null>(null);

  const filteredSections = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return CONTRACT_TEMPLATE_CODE_SECTIONS;
    return CONTRACT_TEMPLATE_CODE_SECTIONS.map((s) => ({
      ...s,
      codes: s.codes.filter(
        (c) =>
          c.code.toLowerCase().includes(term) ||
          c.label.toLowerCase().includes(term),
      ),
    })).filter((s) => s.codes.length > 0);
  }, [search]);

  const visibleCount = filteredSections.reduce(
    (sum, s) => sum + s.codes.length,
    0,
  );

  const copy = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(code);
      toast.success(`Đã copy ${code}`);
      setTimeout(() => setCopied((cur) => (cur === code ? null : cur)), 1200);
    } catch {
      toast.error("Không thể copy");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Danh sách mã code biểu mẫu hợp đồng</DialogTitle>
          <DialogDescription>
            {TOTAL_CONTRACT_CODES} mã được hỗ trợ. Dán trực tiếp vào file .docx
            (ví dụ {"{REPRESENT_NAME}"}); khi in hợp đồng hệ thống tự điền giá trị.
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Tìm theo mã hoặc tên trường..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>

        <ScrollArea className="flex-1 -mx-6 px-6">
          {filteredSections.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-10">
              Không tìm thấy mã nào.
            </p>
          ) : (
            <div className="space-y-5 pr-2">
              {filteredSections.map((section) => (
                <section key={section.title}>
                  <h3 className="text-sm font-semibold border-b pb-1 mb-2">
                    {section.title}{" "}
                    <span className="text-xs text-muted-foreground font-normal">
                      ({section.codes.length})
                    </span>
                  </h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    {section.codes.map((entry) => (
                      <button
                        type="button"
                        key={entry.code}
                        onClick={() => copy(entry.code)}
                        className="group flex items-start justify-between gap-2 rounded border px-3 py-2 text-left hover:border-green-400 hover:bg-green-50/50 transition-colors"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="font-mono text-xs text-green-700 truncate">
                            {entry.code}
                          </div>
                          <div className="text-xs text-muted-foreground truncate">
                            {entry.label}
                          </div>
                        </div>
                        {copied === entry.code ? (
                          <Check className="h-4 w-4 text-green-600 shrink-0" />
                        ) : (
                          <Copy className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 shrink-0" />
                        )}
                      </button>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </ScrollArea>

        <div className="flex items-center justify-between text-xs text-muted-foreground border-t pt-3">
          <span>
            Hiển thị {visibleCount}/{TOTAL_CONTRACT_CODES} mã
          </span>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Đóng
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
