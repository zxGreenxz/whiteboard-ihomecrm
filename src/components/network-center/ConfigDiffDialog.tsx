import { FileDiff } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ConfigDiff, ConfigRevision } from "@/lib/network-center/contracts";

interface ConfigDiffDialogProps {
  siteId: string;
  revisions: ConfigRevision[];
  compare: (fromRevisionId: string, toRevisionId: string) => Promise<ConfigDiff>;
}

export function ConfigDiffDialog({ siteId, revisions, compare }: ConfigDiffDialogProps) {
  const initialFromId = revisions[1]?.id ?? revisions[0]?.id ?? "";
  const initialToId = revisions[0]?.id ?? "";
  const revisionSignature = revisions.map((revision) => revision.id).join("|");
  const [open, setOpen] = useState(false);
  const [fromId, setFromId] = useState(initialFromId);
  const [toId, setToId] = useState(initialToId);
  const [diff, setDiff] = useState<ConfigDiff | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setOpen(false);
    setFromId(initialFromId);
    setToId(initialToId);
    setDiff(null);
    setError("");
    setLoading(false);
  }, [initialFromId, initialToId, revisionSignature, siteId]);

  const changeOpen = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) {
      setDiff(null);
      setError("");
    }
  };

  const changeFrom = (value: string) => {
    setFromId(value);
    setDiff(null);
    setError("");
  };

  const changeTo = (value: string) => {
    setToId(value);
    setDiff(null);
    setError("");
  };

  const showDiff = async () => {
    setLoading(true);
    try {
      setDiff(await compare(fromId, toId));
      setError("");
    } catch (caught) {
      setDiff(null);
      setError(caught instanceof Error ? caught.message : "Không thể so sánh");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger asChild>
        <Button variant="outline"><FileDiff data-icon="inline-start" aria-hidden="true" /> So sánh hai bản</Button>
      </DialogTrigger>
      <DialogContent className="network-center network-center-dialog nc-dialog nc-dialog-wide">
        <DialogHeader>
          <DialogTitle>So sánh cấu hình đã làm sạch</DialogTitle>
          <DialogDescription>
            Chọn hai bản cấu hình khác nhau. Thông tin xác thực và giá trị nhạy cảm luôn được thay bằng [ĐÃ ẨN].
          </DialogDescription>
        </DialogHeader>
        <div className="nc-diff-controls">
          <RevisionSelect label="Bản gốc" value={fromId} revisions={revisions} onChange={changeFrom} />
          <RevisionSelect label="Bản so sánh" value={toId} revisions={revisions} onChange={changeTo} />
          <Button onClick={() => void showDiff()} disabled={loading || !fromId || !toId}>
            {loading ? "Đang so sánh…" : "Hiện kết quả so sánh"}
          </Button>
        </div>
        {error ? <p className="nc-form-error" role="alert">{error}</p> : null}
        {diff ? (
          <div className="nc-diff" aria-label="Kết quả so sánh cấu hình">
            <strong>{diff.changeCount} trường thay đổi</strong>
            {diff.lines.map((line, index) => (
              <code className={`nc-diff-${line.kind}`} key={`${line.kind}-${index}`}>{line.text}</code>
            ))}
          </div>
        ) : <p className="nc-empty-copy">Chưa có kết quả so sánh.</p>}
      </DialogContent>
    </Dialog>
  );
}

function RevisionSelect({ label, value, revisions, onChange }: {
  label: string;
  value: string;
  revisions: ConfigRevision[];
  onChange: (value: string) => void;
}) {
  return (
    <div className="nc-field">
      <span>{label}</span>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger aria-label={label}><SelectValue /></SelectTrigger>
        <SelectContent className="network-center nc-select-content">
          <SelectGroup>
            {revisions.map((revision) => (
              <SelectItem key={revision.id} value={revision.id}>{revision.label} · {revision.hash.slice(-8)}</SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </div>
  );
}
