/**
 * Trang QUẢN TRỊ sự kiện vòng xoay (/quayso/admin) — trong CRM, cần đăng nhập.
 *
 * Server tự guard (OWNER/STAFF của org, RPC ném 42501) nên route chỉ cần
 * ProtectedRoute; người không đủ quyền thấy thông báo lỗi thay vì trang.
 *
 * Quản trị: tạo sự kiện, khai đội (web CẤP SẴN MÃ 6 SỐ — chỉ trang này thấy mã),
 * hẹn giờ mở thưởng, copy link công khai gửi group, điểm danh hộ, quay tay,
 * reset kết quả.
 */

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import MainLayout from '@/components/layout/MainLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { supabase } from '@/integrations/supabase/client';
import { SIGNED_URL_TTL } from '@/lib/storage';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  LUCKY_GAMES, PROOF_BUCKET, formatVnd, luckyAdminApi, luckyGameOf, luckyPublicUrl,
  type LuckyEventAdmin, type LuckyGame, type LuckyTeamAdmin,
} from '@/lib/luckyDrawApi';

const QK = ['lucky-admin'] as const;

/** ISO (UTC) → giá trị input datetime-local theo giờ máy quản trị. */
function isoToLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** input datetime-local → ISO UTC (rỗng = xoá hẹn giờ). */
function localInputToIso(v: string): string | null {
  if (!v) return null;
  return new Date(v).toISOString();
}

interface TeamDraft {
  name: string;
  deals: number;
  topRank: number | null;
  topPrize: number | null;
  inWheel: boolean;
}

const EMPTY_DRAFT: TeamDraft = { name: '', deals: 1, topRank: null, topPrize: null, inWheel: true };

export default function LuckyDrawAdminPage() {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<TeamDraft>(EMPTY_DRAFT);
  const [editTeam, setEditTeam] = useState<LuckyTeamAdmin | null>(null);
  const [editDraft, setEditDraft] = useState<TeamDraft>(EMPTY_DRAFT);

  const q = useQuery({ queryKey: QK, queryFn: luckyAdminApi.get, retry: 1 });
  const events = useMemo(() => q.data?.events ?? [], [q.data]);
  const event: LuckyEventAdmin | undefined =
    events.find((e) => e.id === selectedId) ?? events[0];

  const invalidate = () => queryClient.invalidateQueries({ queryKey: QK });

  const mUpsert = useMutation({
    mutationFn: luckyAdminApi.upsertEvent,
    onSuccess: (r) => {
      setSelectedId(r.eventId);
      invalidate();
      toast.success('Đã lưu sự kiện.');
    },
    onError: (e: Error) => toast.error(e.message || 'Không lưu được sự kiện.'),
  });
  const mAddTeam = useMutation({
    mutationFn: luckyAdminApi.addTeam,
    onSuccess: (r) => {
      invalidate();
      setDraft(EMPTY_DRAFT);
      toast.success(`Đã thêm đội — mã điểm danh: ${r.code}`);
    },
    onError: (e: Error) =>
      toast.error(/duplicate|unique/i.test(e.message) ? 'Tên đội đã tồn tại trong sự kiện.' : e.message),
  });
  const mUpdateTeam = useMutation({
    mutationFn: (args: { teamId: string; p: Parameters<typeof luckyAdminApi.updateTeam>[1] }) =>
      luckyAdminApi.updateTeam(args.teamId, args.p),
    onSuccess: () => invalidate(),
    onError: (e: Error) => toast.error(e.message || 'Không cập nhật được đội.'),
  });
  const mDeleteTeam = useMutation({
    mutationFn: luckyAdminApi.deleteTeam,
    onSuccess: () => invalidate(),
    onError: (e: Error) => toast.error(e.message || 'Không xoá được đội.'),
  });
  const mForceDraw = useMutation({
    mutationFn: luckyAdminApi.forceDraw,
    onSuccess: (r) => {
      invalidate();
      if (r.ok) toast.success('Đã quay! Mở trang công khai để xem bánh xe chạy.');
      else if (r.reason === 'no_checked_in_teams') toast.error('Chưa có đội nào điểm danh — không quay được.');
      else toast.error('Không quay được.');
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const mResetDraw = useMutation({
    mutationFn: luckyAdminApi.resetDraw,
    onSuccess: () => {
      invalidate();
      toast.success('Đã huỷ kết quả — sự kiện mở lại.');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // Bucket `lucky-proofs` là PRIVATE (anon chỉ upload được, không đọc) nên phải
  // ký URL tạm mới xem được. Mở tab mới ngay trong handler click để Safari
  // không chặn popup — điền URL sau khi ký xong.
  const openProof = async (path: string) => {
    const tab = window.open('', '_blank');
    try {
      const { data, error } = await supabase.storage
        .from(PROOF_BUCKET)
        .createSignedUrl(path, SIGNED_URL_TTL);
      if (error || !data?.signedUrl) throw error ?? new Error('Không ký được URL.');
      if (tab) tab.location.href = data.signedUrl;
      else window.location.href = data.signedUrl;
    } catch (e) {
      tab?.close();
      toast.error((e as Error)?.message || 'Không mở được giấy cọc.');
    }
  };

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`Đã copy ${label}.`);
    } catch {
      window.prompt(`Copy ${label}:`, text);
    }
  };

  if (q.isError) {
    return (
      <MainLayout>
        <div className="mx-auto max-w-xl p-6 text-center space-y-2">
          <h1 className="text-lg font-semibold">Không mở được trang quản trị sự kiện</h1>
          <p className="text-sm text-muted-foreground">
            {(q.error as Error)?.message?.includes('42501') || /quyền/.test((q.error as Error)?.message ?? '')
              ? 'Tài khoản của bạn không có quyền quản trị (cần OWNER/STAFF của tổ chức).'
              : (q.error as Error)?.message}
          </p>
        </div>
      </MainLayout>
    );
  }

  const winner = event?.teams.find((t) => t.id === event.winnerTeamId) ?? null;

  return (
    <MainLayout>
      <div className="mx-auto max-w-4xl space-y-4 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="text-xl font-bold">🎰 Sự kiện quay số may mắn</h1>
            <p className="text-sm text-muted-foreground">
              Cấp mã 6 số cho đội, hẹn giờ mở thưởng — sale vào /quayso điểm danh, tới giờ tự quay.
            </p>
          </div>
          <Button
            onClick={() => mUpsert.mutate({ title: 'IHOME · Trao thưởng' })}
            disabled={mUpsert.isPending}
          >
            + Sự kiện mới
          </Button>
        </div>

        {q.isLoading && <p className="text-sm text-muted-foreground">Đang tải…</p>}

        {!q.isLoading && !event && (
          <Card>
            <CardContent className="py-10 text-center text-sm text-muted-foreground">
              Chưa có sự kiện nào — bấm “+ Sự kiện mới” để bắt đầu.
            </CardContent>
          </Card>
        )}

        {events.length > 1 && (
          <div className="flex flex-wrap gap-2">
            {events.map((e) => (
              <Button
                key={e.id}
                size="sm"
                variant={e.id === event?.id ? 'default' : 'outline'}
                onClick={() => setSelectedId(e.id)}
              >
                {e.title} · {new Date(e.createdAt).toLocaleDateString('vi-VN')}
              </Button>
            ))}
          </div>
        )}

        {event && (
          <>
            {/* Thông số sự kiện */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                  Thông số
                  <Badge variant={event.status === 'drawn' ? 'default' : event.status === 'closed' ? 'secondary' : 'outline'}>
                    {event.status === 'drawn' ? 'Đã quay' : event.status === 'closed' ? 'Đã đóng' : 'Đang mở'}
                  </Badge>
                  {winner && <Badge className="bg-amber-500 text-black hover:bg-amber-500">Trúng: {winner.name}</Badge>}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <EventForm key={event.id} event={event} onSave={(p) => mUpsert.mutate({ id: event.id, ...p })} saving={mUpsert.isPending} />
                <div className="space-y-1 rounded-md border bg-muted/40 px-3 py-2 text-sm">
                  <div>
                    <span className="text-muted-foreground">Link gửi sale: </span>
                    <a
                      href={`/quayso/${event.slug}`}
                      target="_blank"
                      rel="noreferrer"
                      className="font-mono font-semibold underline underline-offset-2"
                    >
                      {luckyPublicUrl(event.id, event.slug).replace(/^https?:\/\//, '')}
                    </a>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Màn quay để ghi hình: </span>
                    <a
                      href={`/quayso/${event.slug}/quay`}
                      target="_blank"
                      rel="noreferrer"
                      className="font-mono font-semibold underline underline-offset-2"
                    >
                      {`${luckyPublicUrl(event.id, event.slug)}/quay`.replace(/^https?:\/\//, '')}
                    </a>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2 border-t pt-3">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void copy(luckyPublicUrl(event.id, event.slug), 'link công khai')}
                  >
                    📋 Copy link gửi sale
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={event.status !== 'open' || mForceDraw.isPending}
                    onClick={() => {
                      if (window.confirm('Quay NGAY bây giờ (bỏ qua giờ hẹn)? Kết quả chốt một lần cho tất cả.')) {
                        mForceDraw.mutate(event.id);
                      }
                    }}
                  >
                    🎲 Quay ngay
                  </Button>
                  {event.status === 'drawn' && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={mResetDraw.isPending}
                      onClick={() => {
                        if (window.confirm('Huỷ kết quả đã quay và mở lại sự kiện?')) mResetDraw.mutate(event.id);
                      }}
                    >
                      ↺ Huỷ kết quả
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={mUpsert.isPending}
                    onClick={() =>
                      mUpsert.mutate({ id: event.id, status: event.status === 'closed' ? 'open' : 'closed' })
                    }
                  >
                    {event.status === 'closed' ? 'Mở lại sự kiện' : 'Đóng sự kiện'}
                  </Button>
                </div>
              </CardContent>
            </Card>

            {/* Danh sách đội + mã */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">
                  Đội tham gia ({event.teams.length}) — mã 6 số chỉ trang này thấy
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                        <th className="py-2 pr-2">Đội</th>
                        <th className="px-2 py-2">Mã</th>
                        <th className="px-2 py-2">Vai trò</th>
                        <th className="px-2 py-2">Điểm danh</th>
                        <th className="px-2 py-2">Hồ sơ nhận thưởng</th>
                        <th className="px-2 py-2 text-right">Thao tác</th>
                      </tr>
                    </thead>
                    <tbody>
                      {event.teams.map((t) => (
                        <tr key={t.id} className="border-b last:border-0">
                          <td className="py-2 pr-2">
                            <div className="font-medium">{t.name}</div>
                            <div className="text-xs text-muted-foreground">{t.deals} deal</div>
                          </td>
                          <td className="px-2 py-2">
                            <button
                              type="button"
                              className="rounded bg-muted px-2 py-1 font-mono text-sm font-semibold tracking-widest"
                              title="Bấm để copy mã"
                              onClick={() => void copy(t.code, `mã của ${t.name}`)}
                            >
                              {t.code}
                            </button>
                          </td>
                          <td className="px-2 py-2">
                            {t.topRank ? (
                              <Badge className="bg-amber-500 text-black hover:bg-amber-500">
                                TOP {t.topRank}{t.topPrizeAmount != null ? ` · ${formatVnd(t.topPrizeAmount)}` : ''}
                              </Badge>
                            ) : t.inWheel ? (
                              <Badge variant="outline">Quay số</Badge>
                            ) : (
                              <Badge variant="secondary">Ngoài bánh xe</Badge>
                            )}
                          </td>
                          <td className="px-2 py-2">
                            <Button
                              size="sm"
                              variant={t.checkedIn ? 'default' : 'outline'}
                              onClick={() => mUpdateTeam.mutate({ teamId: t.id, p: { checkedIn: !t.checkedIn } })}
                              disabled={mUpdateTeam.isPending}
                            >
                              {t.checkedIn ? '✓ Có mặt' : 'Chưa'}
                            </Button>
                          </td>
                          <td className="px-2 py-2">
                            <div className="space-y-1 text-xs">
                              {t.payoutAccount ? (
                                <div className="font-mono font-semibold">
                                  {t.payoutAccount}
                                  {t.payoutBank ? ` · ${t.payoutBank}` : ''}
                                  {t.payoutHolder ? (
                                    <div className="font-sans font-normal text-muted-foreground">{t.payoutHolder}</div>
                                  ) : null}
                                </div>
                              ) : (
                                <div className="text-muted-foreground">Chưa có STK</div>
                              )}
                              {t.proofs?.length ? (
                                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                                  <span className="text-muted-foreground">
                                    📎 {t.proofs.length} tấm:
                                  </span>
                                  {t.proofs.map((pr, i) => (
                                    <Button
                                      key={pr.path}
                                      size="sm"
                                      variant="link"
                                      className="h-auto p-0 text-xs"
                                      title={pr.name}
                                      onClick={() => void openProof(pr.path)}
                                    >
                                      #{i + 1}
                                    </Button>
                                  ))}
                                </div>
                              ) : (
                                <div className="text-muted-foreground">Chưa có giấy cọc</div>
                              )}
                            </div>
                          </td>
                          <td className="px-2 py-2 text-right">
                            <div className="flex justify-end gap-1">
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => {
                                  setEditTeam(t);
                                  setEditDraft({
                                    name: t.name,
                                    deals: t.deals,
                                    topRank: t.topRank,
                                    topPrize: t.topPrizeAmount,
                                    inWheel: t.inWheel,
                                  });
                                }}
                              >
                                Sửa
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="text-destructive"
                                onClick={() => {
                                  if (window.confirm(`Xoá đội "${t.name}"?`)) mDeleteTeam.mutate(t.id);
                                }}
                              >
                                Xoá
                              </Button>
                            </div>
                          </td>
                        </tr>
                      ))}
                      {event.teams.length === 0 && (
                        <tr>
                          <td colSpan={6} className="py-6 text-center text-muted-foreground">
                            Chưa có đội nào — thêm bên dưới, web sẽ cấp mã tự động.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>

                {/* Thêm đội */}
                <div className="flex flex-wrap items-end gap-2 border-t pt-3">
                  <div className="min-w-40 flex-1">
                    <Label htmlFor="ld-name">Tên đội</Label>
                    <Input
                      id="ld-name"
                      value={draft.name}
                      placeholder="vd: Phụng Đào"
                      onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && draft.name.trim() && event.id) {
                          mAddTeam.mutate({ eventId: event.id, ...draft, name: draft.name.trim() });
                        }
                      }}
                    />
                  </div>
                  <div className="w-20">
                    <Label htmlFor="ld-deals">Deal</Label>
                    <Input
                      id="ld-deals"
                      type="number"
                      min={0}
                      value={draft.deals}
                      onChange={(e) => setDraft((d) => ({ ...d, deals: Math.max(0, Number(e.target.value) || 0) }))}
                    />
                  </div>
                  <div className="w-24">
                    <Label htmlFor="ld-top">TOP (1/2)</Label>
                    <Input
                      id="ld-top"
                      type="number"
                      min={1}
                      max={3}
                      placeholder="—"
                      value={draft.topRank ?? ''}
                      onChange={(e) => {
                        const v = e.target.value ? Number(e.target.value) : null;
                        setDraft((d) => ({ ...d, topRank: v, inWheel: v == null }));
                      }}
                    />
                  </div>
                  <div className="w-32">
                    <Label htmlFor="ld-prize">Tiền giải TOP</Label>
                    <Input
                      id="ld-prize"
                      type="number"
                      min={0}
                      step={100000}
                      placeholder="—"
                      value={draft.topPrize ?? ''}
                      onChange={(e) => setDraft((d) => ({ ...d, topPrize: e.target.value ? Number(e.target.value) : null }))}
                    />
                  </div>
                  <Button
                    disabled={!draft.name.trim() || mAddTeam.isPending}
                    onClick={() => mAddTeam.mutate({ eventId: event.id, ...draft, name: draft.name.trim() })}
                  >
                    + Thêm đội
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Đội có TOP sẽ hiện ở khối “nhận giải”, không lên bánh xe. Đội thường tự động tham gia quay.
                </p>
              </CardContent>
            </Card>
          </>
        )}
      </div>

      {/* Dialog sửa đội */}
      <Dialog open={!!editTeam} onOpenChange={(open) => !open && setEditTeam(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Sửa đội {editTeam?.name}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label htmlFor="ed-name">Tên đội</Label>
              <Input id="ed-name" value={editDraft.name} onChange={(e) => setEditDraft((d) => ({ ...d, name: e.target.value }))} />
            </div>
            <div className="flex gap-2">
              <div className="w-24">
                <Label htmlFor="ed-deals">Deal</Label>
                <Input id="ed-deals" type="number" min={0} value={editDraft.deals}
                  onChange={(e) => setEditDraft((d) => ({ ...d, deals: Math.max(0, Number(e.target.value) || 0) }))} />
              </div>
              <div className="w-24">
                <Label htmlFor="ed-top">TOP</Label>
                <Input id="ed-top" type="number" min={1} max={3} placeholder="—" value={editDraft.topRank ?? ''}
                  onChange={(e) => {
                    const v = e.target.value ? Number(e.target.value) : null;
                    setEditDraft((d) => ({ ...d, topRank: v, inWheel: v == null ? d.inWheel : false }));
                  }} />
              </div>
              <div className="flex-1">
                <Label htmlFor="ed-prize">Tiền giải TOP</Label>
                <Input id="ed-prize" type="number" min={0} step={100000} placeholder="—" value={editDraft.topPrize ?? ''}
                  onChange={(e) => setEditDraft((d) => ({ ...d, topPrize: e.target.value ? Number(e.target.value) : null }))} />
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={editDraft.inWheel}
                onCheckedChange={(v) => setEditDraft((d) => ({ ...d, inWheel: v === true }))}
              />
              Tham gia vòng xoay
            </label>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                if (editTeam && window.confirm('Cấp lại mã mới cho đội này? Mã cũ sẽ hết hiệu lực.')) {
                  mUpdateTeam.mutate({ teamId: editTeam.id, p: { regenCode: true } });
                  setEditTeam(null);
                }
              }}
            >
              🔑 Cấp lại mã 6 số
            </Button>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditTeam(null)}>Huỷ</Button>
            <Button
              disabled={!editDraft.name.trim() || mUpdateTeam.isPending}
              onClick={() => {
                if (!editTeam) return;
                mUpdateTeam.mutate({
                  teamId: editTeam.id,
                  p: {
                    name: editDraft.name.trim(),
                    deals: editDraft.deals,
                    topRank: editDraft.topRank,
                    topPrizeAmount: editDraft.topPrize,
                    inWheel: editDraft.topRank == null ? editDraft.inWheel : false,
                  },
                });
                setEditTeam(null);
              }}
            >
              Lưu
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </MainLayout>
  );
}

/* ── Form thông số sự kiện (tách để reset theo key={event.id}) ── */

function EventForm({
  event,
  onSave,
  saving,
}: {
  event: LuckyEventAdmin;
  onSave: (p: {
    title: string;
    slug: string;
    prizeLabel: string;
    prizeAmount: number;
    drawAt: string | null;
    game: LuckyGame;
  }) => void;
  saving: boolean;
}) {
  const [title, setTitle] = useState(event.title);
  const [slug, setSlug] = useState(event.slug);
  const [prizeLabel, setPrizeLabel] = useState(event.prizeLabel);
  const [prizeAmount, setPrizeAmount] = useState(event.prizeAmount);
  const [drawAtLocal, setDrawAtLocal] = useState(isoToLocalInput(event.drawAt));
  const [game, setGame] = useState<LuckyGame>(luckyGameOf(event.game));
  const moTa = LUCKY_GAMES.find((g) => g.value === game)?.hint ?? '';

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="min-w-48 flex-1">
        <Label htmlFor="ev-title">Tiêu đề</Label>
        <Input id="ev-title" value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="w-52">
        <Label htmlFor="ev-slug">Đường dẫn ngắn</Label>
        <div className="flex items-center gap-1">
          <span className="whitespace-nowrap text-xs text-muted-foreground">/quayso/</span>
          <Input
            id="ev-slug"
            value={slug}
            placeholder="deal"
            // Gõ sao cũng ra slug hợp lệ: hạ chữ thường, đổi khoảng trắng thành
            // gạch ngang, bỏ ký tự lạ (kể cả dấu tiếng Việt).
            onChange={(e) =>
              setSlug(
                e.target.value
                  .toLowerCase()
                  .replace(/\s+/g, '-')
                  .replace(/[^a-z0-9-]/g, '')
                  .slice(0, 32),
              )
            }
          />
        </div>
      </div>
      <div className="w-40">
        <Label htmlFor="ev-plabel">Tên giải</Label>
        <Input id="ev-plabel" value={prizeLabel} onChange={(e) => setPrizeLabel(e.target.value)} />
      </div>
      <div className="w-36">
        <Label htmlFor="ev-pamount">Tiền giải (đ)</Label>
        <Input
          id="ev-pamount"
          type="number"
          min={0}
          step={100000}
          value={prizeAmount}
          onChange={(e) => setPrizeAmount(Math.max(0, Number(e.target.value) || 0))}
        />
      </div>
      <div className="w-56">
        <Label htmlFor="ev-game">Trò chơi công bố</Label>
        <Select value={game} onValueChange={(v) => setGame(v as LuckyGame)}>
          <SelectTrigger id="ev-game">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LUCKY_GAMES.map((g) => (
              <SelectItem key={g.value} value={g.value}>{g.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="mt-1 text-xs text-muted-foreground">{moTa}</p>
      </div>
      <div className="w-56">
        <Label htmlFor="ev-drawat">Giờ mở thưởng (giờ máy bạn)</Label>
        <Input
          id="ev-drawat"
          type="datetime-local"
          value={drawAtLocal}
          onChange={(e) => setDrawAtLocal(e.target.value)}
        />
      </div>
      <Button
        disabled={saving || !title.trim()}
        onClick={() =>
          onSave({
            title: title.trim(),
            slug: slug.trim(),
            prizeLabel: prizeLabel.trim() || 'Giải may mắn',
            prizeAmount,
            drawAt: localInputToIso(drawAtLocal),
            game,
          })
        }
      >
        Lưu
      </Button>
    </div>
  );
}
