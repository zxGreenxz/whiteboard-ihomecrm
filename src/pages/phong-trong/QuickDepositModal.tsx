import React, { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useCreateIncomeExpense } from "@/hooks/useIncomeExpenses";
import { useAccounts } from "@/hooks/useAccounts";
import { getSessionUser } from "@/lib/authSession";
import { tryPlaceRoomHold } from "@/lib/reservationHold";
import { Icon } from "./icons";
import { fmtPrice, type Room } from "./sampleData";
import { useTrack } from "./useTracking";

/**
 * Modal "Tạo phiếu cọc nhanh" — chỉ hiển thị cho user ĐANG ĐĂNG NHẬP có quyền
 * `sale_phong.create_deposit`. Mục đích: khi nhận cọc của khách, lock phòng
 * realtime ngay (tạo phiếu thu cọc → trigger recompute_room_reservation tự set
 * rooms.status='RESERVED' → phòng rời danh sách "trống").
 *
 * Sổ quỹ: cọc THẬT (>1đ) ghi vào sổ thu của chính staff (RLS-safe); giữ chỗ
 * 1đ / không có sổ riêng → sổ ảo "CỌC (giữ hộ khách)" (get_or_create_deposit_account).
 * Hạng mục = "Tiền cọc" (RPC ensure_room_deposit_type — đảm bảo is_deposit=TRUE).
 * Nội dung = "Cọc phòng {x} tòa {y}". Ô số tiền để trống → mặc định 1đ.
 * "Ngày bổ sung cọc" + "Ngày vào" là thông tin thêm; điền thì ghi vào nội dung.
 */

/** "2026-06-08" -> "08/06/2026" (ghi vào nội dung cho dễ đọc). */
function fmtVNDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

/** Chỉ giữ chữ số. */
function digitsOnly(s: string): string {
  return s.replace(/\D/g, "");
}

/** Định dạng nhóm nghìn kiểu vi-VN từ chuỗi chữ số. */
function groupThousands(digits: string): string {
  if (!digits) return "";
  return Number(digits).toLocaleString("vi-VN");
}

export function QuickDepositModal({
  room,
  onClose,
  onDone,
}: {
  room: Room | null;
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const qc = useQueryClient();
  const track = useTrack();
  const createIE = useCreateIncomeExpense();
  const { data: accounts = [] } = useAccounts();
  const [amount, setAmount] = useState(""); // chuỗi chữ số (đã bỏ separator)
  const [topupDate, setTopupDate] = useState(""); // ngày bổ sung cọc (YYYY-MM-DD)
  const [moveInDate, setMoveInDate] = useState(""); // ngày vào (YYYY-MM-DD)
  const [submitting, setSubmitting] = useState(false);
  const [myUserId, setMyUserId] = useState<string | null>(null);

  // Sổ thu THẬT của chính staff (user_id = auth.uid()) — RLS cho phép ghi.
  // Tiền cọc thật vào sổ này; sổ CỌC chỉ là sổ ảo (fallback / giữ chỗ 1đ).
  useEffect(() => {
    let active = true;
    getSessionUser().then((u) => {
      if (active) setMyUserId(u?.id ?? null);
    });
    return () => {
      active = false;
    };
  }, []);
  const myDefaultAccount = useMemo(() => {
    const mine = accounts.filter((a) => a.user_id === myUserId);
    return mine.find((a) => a.is_default) ?? mine[0] ?? null;
  }, [accounts, myUserId]);

  // Reset form mỗi khi mở phòng mới.
  const roomId = room?.id ?? null;
  useEffect(() => {
    setAmount("");
    setTopupDate("");
    setMoveInDate("");
    setSubmitting(false);
  }, [roomId]);

  const roomLabel = room ? room.code || String(room.no) : "";
  const baseContent = room ? `Cọc phòng ${roomLabel} tòa ${room.buildingName}` : "";

  // Nhãn sổ quỹ hiển thị: cọc thật → sổ thu của staff; giữ chỗ → sổ CỌC ảo.
  const accountLabel =
    Number(digitsOnly(amount)) > 1 && myDefaultAccount
      ? myDefaultAccount.name
      : "CỌC (giữ hộ khách) — sổ ảo";

  // Nội dung phiếu (preview) — gắn thêm ngày nếu có.
  const contentPreview = useMemo(() => {
    const extras: string[] = [];
    if (moveInDate) extras.push(`vào ${fmtVNDate(moveInDate)}`);
    if (topupDate) extras.push(`bổ sung cọc ${fmtVNDate(topupDate)}`);
    return extras.length ? `${baseContent} (${extras.join(", ")})` : baseContent;
  }, [baseContent, moveInDate, topupDate]);

  if (!room) return null;

  const submit = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      // Số tiền: để trống / không hợp lệ → 1đ (giữ chỗ).
      const parsed = Number(digitsOnly(amount));
      const unitPrice = parsed > 0 ? parsed : 1;

      // Khoá giữ-phòng 24h (canonical deposit.hold.v1): chặn 2 nhân viên thu
      // cọc đè cùng phòng; throw nếu người khác đang giữ, cho qua nếu writer tắt.
      await tryPlaceRoomHold(room.id, unitPrice);

      // RPC: hạng mục "Tiền cọc" (is_deposit=TRUE) + sổ "CỌC (giữ hộ khách)".
      const rpc = (supabase as unknown as {
        rpc: (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
      }).rpc.bind(supabase);

      const { data: typeId, error: typeErr } = await rpc("ensure_room_deposit_type");
      if (typeErr || !typeId) {
        throw new Error("Không lấy được hạng mục \"Tiền cọc\".");
      }
      // Cọc THẬT (>1đ) → sổ thu của chính staff (RLS-safe). Giữ chỗ 1đ / không
      // có sổ riêng → sổ CỌC ảo (get_or_create_deposit_account, theo auth.uid()).
      let accId: string | null =
        unitPrice > 1 && myDefaultAccount ? myDefaultAccount.id : null;
      if (!accId) {
        const { data: depAcc, error: accErr } = await rpc("get_or_create_deposit_account");
        if (accErr || !depAcc) {
          throw new Error("Không lấy được sổ quỹ để ghi cọc.");
        }
        accId = depAcc as string;
      }

      const today = new Date().toISOString().slice(0, 10);
      const extras: string[] = [];
      if (moveInDate) extras.push(`Ngày vào: ${fmtVNDate(moveInDate)}`);
      if (topupDate) extras.push(`Ngày bổ sung cọc: ${fmtVNDate(topupDate)}`);
      const itemDesc = extras.length ? extras.join(" · ") : null;

      await createIE.mutateAsync({
        type: "INCOME",
        name: contentPreview,
        building_id: room.buildingId,
        room_id: room.id,
        tenant_id: null,
        contract_id: null, // cọc giữ chỗ — chưa có hợp đồng
        payer_name: null,
        account_id: accId as string,
        voucher_date: today,
        business_result_accounting: null, // hạng mục cọc tự loại khỏi KQKD
        repeat_cycle: "NONE",
        repeat_infinity: false,
        repeat_count: 0,
        attachments: [],
        items: [
          {
            income_expense_type_id: typeId as string,
            description: itemDesc,
            quantity: 1,
            unit_price: unitPrice,
            start_date: today,
            end_date: today,
          },
        ],
      });

      // Phòng vừa bị khoá (RESERVED) → refetch danh sách công khai để ẩn ngay.
      qc.invalidateQueries({ queryKey: ["phong-trong"] });
      track.track("deposit_dialog", {
        room_id: room.id, room_code: room.code, room_name: String(room.no),
        building_id: room.buildingId, building_name: room.buildingName,
        metadata: { created: true, amount: unitPrice },
      });
      onDone(`Đã tạo cọc — phòng ${roomLabel} đã được giữ`);
      onClose();
    } catch (e) {
      track.track("error", { room_id: room.id, metadata: { where: "deposit", msg: (e as Error)?.message?.slice(0, 300) } });
      onDone((e as Error)?.message || "Tạo phiếu cọc thất bại");
      setSubmitting(false);
    }
  };

  return (
    <>
      <div className="qd-scrim show" onClick={submitting ? undefined : onClose} />
      <div className="qd-modal show" role="dialog" aria-modal="true">
        <div className="qd-head">
          <div className="qd-title">
            <Icon.Money />
            <span>Tạo phiếu cọc nhanh</span>
          </div>
          <button className="qd-x" onClick={onClose} aria-label="Đóng" disabled={submitting}>
            <Icon.Close />
          </button>
        </div>

        <div className="qd-body">
          {/* Tóm tắt phòng */}
          <div className="qd-room">
            <span className="qd-room-name">Phòng {roomLabel} · Tòa {room.buildingName}</span>
            <span className="qd-room-price">{fmtPrice(room.price)} tr/th</span>
          </div>

          {/* Thông tin mặc định (chỉ đọc) */}
          <div className="qd-fixed">
            <div className="qd-fixed-row">
              <span className="qd-fixed-lbl">Sổ quỹ</span>
              <span className="qd-fixed-val">{accountLabel}</span>
            </div>
            <div className="qd-fixed-row">
              <span className="qd-fixed-lbl">Hạng mục</span>
              <span className="qd-fixed-val">Tiền cọc</span>
            </div>
            <div className="qd-fixed-row">
              <span className="qd-fixed-lbl">Nội dung</span>
              <span className="qd-fixed-val qd-content">{contentPreview}</span>
            </div>
          </div>

          {/* Số tiền cọc */}
          <label className="qd-field">
            <span className="qd-field-lbl">Số tiền cọc</span>
            <div className="qd-money">
              <input
                className="qd-input"
                type="text"
                inputMode="numeric"
                placeholder="Để trống = 1đ"
                value={groupThousands(digitsOnly(amount))}
                onChange={(e) => setAmount(digitsOnly(e.target.value))}
                autoFocus
              />
              <span className="qd-suffix">đ</span>
            </div>
          </label>

          {/* Ngày bổ sung cọc + Ngày vào (tùy chọn) */}
          <div className="qd-dates">
            <label className="qd-field">
              <span className="qd-field-lbl">Ngày bổ sung cọc <i>(tùy chọn)</i></span>
              <input
                className="qd-input"
                type="date"
                value={topupDate}
                onChange={(e) => setTopupDate(e.target.value)}
              />
            </label>
            <label className="qd-field">
              <span className="qd-field-lbl">Ngày vào <i>(tùy chọn)</i></span>
              <input
                className="qd-input"
                type="date"
                value={moveInDate}
                onChange={(e) => setMoveInDate(e.target.value)}
              />
            </label>
          </div>
        </div>

        <div className="qd-actions">
          <button className="qd-btn qd-cancel" onClick={onClose} disabled={submitting}>
            Hủy
          </button>
          <button className="qd-btn qd-submit" onClick={submit} disabled={submitting}>
            {submitting ? "Đang lưu…" : "Tạo cọc & giữ phòng"}
          </button>
        </div>
      </div>
    </>
  );
}
