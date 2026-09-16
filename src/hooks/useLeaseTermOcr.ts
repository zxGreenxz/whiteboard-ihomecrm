// Đọc thời hạn ghi trên ảnh hợp đồng ở nhờ bằng bộ nhận dạng chữ CHẠY TRONG MÁY
// (src/lib/ocr — cùng bộ đang dùng cho CCCD). Ảnh giấy tờ không rời trình duyệt.
//
// Đọc xong thì ghi vào chính dòng ảnh đó (lease_term_from/to) để lần sau mở lại
// không phải đọc lại: nhận dạng tốn vài giây và tốn pin trên điện thoại.
import { useCallback, useEffect, useRef, useState } from 'react';
import { createOcrScanner } from '@/lib/ocr/client';
import type { OcrScanner } from '@/lib/ocr/types';
import { docHanHopDong, hanConHieuLuc, type HanHopDong } from '@/lib/residenceLeaseTerm';
import { createSignedUrlFromStored } from '@/lib/storage';
import { dossierStorageValue, luuHanHopDong, type ResidenceDossierFile } from '@/lib/residenceDossierFiles';

export type TrangThaiDocHan = 'nghi' | 'dang-doc' | 'xong' | 'khong-doc-duoc' | 'loi';

export interface KetQuaDocHan {
  trangThai: TrangThaiDocHan;
  han: HanHopDong | null;
  /** Đọc lại ảnh hiện tại, kể cả khi lần trước đã thất bại. */
  docLai: () => void;
}

/** Ngày đã lưu sẵn trên dòng ảnh (yyyy-mm-dd của Postgres) → dd/mm/yyyy. */
function hanDaLuu(file: ResidenceDossierFile | undefined): HanHopDong | null {
  const to = file?.lease_term_to;
  const from = file?.lease_term_from;
  if (!to || !from) return null;
  const doi = (v: string) => { const [y, m, d] = v.split('-'); return `${d}/${m}/${y}`; };
  return { from: doi(from), to: doi(to), nguon: 'cap-ngay' };
}

/**
 * @param leaseFile ảnh hợp đồng ở nhờ mới nhất của khách; đổi ảnh thì đọc lại.
 * @param tuDong bật đọc khi chưa có hạn lưu sẵn (tắt trong test và khi không có quyền).
 */
export function useLeaseTermOcr(
  leaseFile: ResidenceDossierFile | undefined,
  tuDong = true,
  taoScanner: () => OcrScanner = createOcrScanner,
): KetQuaDocHan {
  const [trangThai, setTrangThai] = useState<TrangThaiDocHan>('nghi');
  const [han, setHan] = useState<HanHopDong | null>(null);
  const lan = useRef(0);
  const scanner = useRef<OcrScanner | null>(null);
  const controller = useRef<AbortController | null>(null);
  const song = useRef(true);
  const taoScannerRef = useRef(taoScanner);
  taoScannerRef.current = taoScanner;

  const daLuu = hanDaLuu(leaseFile);

  const doc = useCallback(async (file: ResidenceDossierFile) => {
    const token = ++lan.current;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    setTrangThai('dang-doc');
    setHan(null);
    try {
      const url = await createSignedUrlFromStored(dossierStorageValue(file));
      const response = await fetch(url, { signal: abort.signal });
      if (!response.ok) throw new Error('tai anh that bai');
      const blob = await response.blob();
      scanner.current?.dispose();
      scanner.current = taoScannerRef.current();
      const ket = await scanner.current.readText(blob, { signal: abort.signal });
      scanner.current?.dispose();
      scanner.current = null;
      if (!song.current || token !== lan.current) return;
      if (ket.status !== 'lines') { setTrangThai(ket.status === 'cancelled' ? 'nghi' : 'khong-doc-duoc'); return; }
      const docDuoc = docHanHopDong(ket.lines.map((l) => l.text));
      if (!docDuoc || !hanConHieuLuc(docDuoc)) { setTrangThai('khong-doc-duoc'); return; }
      setHan(docDuoc);
      setTrangThai('xong');
      // Ghi hụt không làm hỏng việc: lần sau đọc lại là có. Lỗi quyền thật sẽ
      // lộ ở chỗ tải ảnh chứ không phải ở đây.
      try { await luuHanHopDong(file.id, docDuoc.from, docDuoc.to); } catch { /* chỉ là bộ nhớ đệm */ }
    } catch {
      if (!song.current || token !== lan.current) return;
      setTrangThai(abort.signal.aborted ? 'nghi' : 'loi');
    }
  }, []);

  useEffect(() => {
    song.current = true;
    return () => {
      song.current = false;
      ++lan.current;
      controller.current?.abort();
      scanner.current?.dispose();
      scanner.current = null;
    };
  }, []);

  useEffect(() => {
    if (daLuu) { setHan(daLuu); setTrangThai('xong'); return; }
    if (!leaseFile || !tuDong) { setHan(null); setTrangThai('nghi'); return; }
    void doc(leaseFile);
    // Chỉ đọc lại khi ĐỔI ảnh, không phải mỗi lần danh sách được nạp lại.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leaseFile?.id, leaseFile?.lease_term_to, tuDong]);

  const docLai = useCallback(() => { if (leaseFile) void doc(leaseFile); }, [leaseFile, doc]);
  return { trangThai, han, docLai };
}
