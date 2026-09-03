import { describe, expect, it } from 'vitest';

import { boCommentSql, chuKyHam, docSql, thanHam } from './helpers/sqlTestUtils';

// G2-E dựng hai action L4 theo Nonce ABI v1 (`meter_reading.create`,
// `reservation_deposit.create`).
//
// VÌ SAO CHỈ HAI CHỨ KHÔNG BA
//   Brief xin thêm `invoice.create_draft`. RPC gốc `create_invoice_v1` KHÔNG
//   nhận tham số nào chọn trạng thái: nó đọc
//   `organization_invoice_settings.auto_approve_invoice` rồi tự quyết
//   `APPROVED` hay `DRAFT`. Trên production (đo 03/09/2026) bảng đó có ĐÚNG
//   một hàng và hàng đó `auto_approve_invoice = true` — nghĩa là hoá đơn sinh
//   ra sẽ là hoá đơn ĐÃ PHÁT HÀNH. Đó chính là điều brief cấm, nên action đó
//   dừng ở NEEDS_CONTEXT và không có migration nào cho nó. Bài kiểm cuối file
//   ghim việc "không có migration nào dựng cặp RPC hoá đơn" để một bản sau
//   không lặng lẽ mở đường đó ra.
//
// TEST NÀY GHIM MỘT THỨ DUY NHẤT: THỨ TỰ (cùng lý do đã ghi ở
// `copilotActionsL3Migration.test.ts`), cộng hai bất biến riêng của L4:
//   · READBACK phải đọc lại từ BẢNG sau khi RPC gốc chạy, không tin giá trị nó
//     trả về — một hàm gốc bị thay thân sẽ trả JSON đẹp trong khi bảng trống.
//   · Đường cọc giữ chỗ phải ép trạng thái `PENDING_APPROVAL`. Đây là bất biến
//     NHÁP thật sự duy nhất của đợt này.
//
// MỌI assertion nội dung chạy trên bản ĐÃ LỘT BÌNH LUẬN.
//
// Đây là test ĐỌC FILE. Hành vi thật do khối nghiệm thu trong từng migration và
// hai lượt dry-run trên production đo.

interface CaAction {
  ten: string;
  file: string;
  actionId: string;
  permissionKey: string;
  previewRpc: string;
  executeRpc: string;
  rpcGoc: string;
  entityTable: string;
  refTable: string;
  bienThucThe: string;
}

const CAC_ACTION: readonly CaAction[] = [
  {
    ten: 'meter_reading.create',
    file: 'supabase/migrations/20260903085155_copilot_action_meter_reading_create_v1.sql',
    actionId: 'meter_reading.create',
    permissionKey: 'meter_readings.create',
    previewRpc: 'copilot_preview_meter_reading_v1',
    executeRpc: 'copilot_execute_meter_reading_v1',
    rpcGoc: 'create_meter_reading_v1',
    entityTable: 'meter_readings',
    refTable: 'meters',
    bienThucThe: 'v_meter',
  },
  {
    ten: 'reservation_deposit.create',
    file: 'supabase/migrations/20260903085654_copilot_action_reservation_deposit_create_v1.sql',
    actionId: 'reservation_deposit.create',
    permissionKey: 'deposits.create',
    previewRpc: 'copilot_preview_reservation_deposit_v1',
    executeRpc: 'copilot_execute_reservation_deposit_v1',
    rpcGoc: 'create_reservation_deposit_v1',
    entityTable: 'room_reservation_holds',
    refTable: 'rooms',
    bienThucThe: 'v_room',
  },
];

const FILE_CHI_SO = CAC_ACTION[0].file;
const FILE_GIU_CHO = CAC_ACTION[1].file;

/** Bản thô của migration đầu — CHỈ dùng cho bài kiểm đột biến ở cuối file. */
const thoChiSo = docSql(FILE_CHI_SO);

function doc(file: string): string {
  return boCommentSql(docSql(file));
}

/** Escape dấu chấm của một `action_id` để nhét vào RegExp. */
function nhuMau(gt: string): string {
  return gt.replace(/[.]/g, '\\.');
}

/**
 * Thân chính xác của một hàm: `thanHam` cắt tới khai báo kế tiếp hoặc khối ACL,
 * rồi cắt thêm ở dấu đóng dollar-quote để `not.toMatch` không đọc sang hàm sau.
 */
function than(sql: string, ten: string, schema = 'public'): string {
  const rong = thanHam(sql, ten, schema);
  const dong = /\n\$[a-z_]*\$;/.exec(rong);
  return dong ? rong.slice(0, dong.index) : rong;
}

/** Vị trí đầu tiên của một mẫu trong thân hàm; -1 nếu không có. */
function viTri(than_ham: string, mau: RegExp): number {
  return than_ham.search(mau);
}

/** Ghim một chuỗi vị trí TĂNG DẦN, kèm tên bước để lỗi đọc được. */
function thuTuTang(than_ham: string, buoc: readonly (readonly [string, RegExp])[]): void {
  const viTriTungBuoc = buoc.map(([ten, mau]) => [ten, viTri(than_ham, mau)] as const);
  for (const [ten, vt] of viTriTungBuoc) {
    expect(vt, `không thấy bước "${ten}" trong thân hàm`).toBeGreaterThan(-1);
  }
  for (let i = 1; i < viTriTungBuoc.length; i += 1) {
    const [tenTruoc, vtTruoc] = viTriTungBuoc[i - 1];
    const [tenSau, vtSau] = viTriTungBuoc[i];
    expect(vtSau, `"${tenTruoc}" phải đứng TRƯỚC "${tenSau}"`).toBeGreaterThan(vtTruoc);
  }
}

describe.each(CAC_ACTION)('G2-E — action L4 $ten', (ca) => {
  const sql = doc(ca.file);

  it('tồn tại và là một cặp BEGIN/COMMIT duy nhất', () => {
    expect(sql, `không đọc được ${ca.file}`).not.toBe('');
    expect(sql.match(/^BEGIN;$/gm)?.length ?? 0).toBe(1);
    expect(sql.match(/^COMMIT;$/gm)?.length ?? 0).toBe(1);
    expect(sql).toMatch(/SET LOCAL lock_timeout = '15s';/);
  });

  it('cặp RPC đúng chữ ký Nonce ABI v1', () => {
    expect(chuKyHam(sql, ca.previewRpc)).toBe('p_organization_id uuid, p_payload jsonb');
    expect(chuKyHam(sql, ca.executeRpc)).toBe('p_confirmation_nonce text, p_payload jsonb');
    for (const ten of [ca.previewRpc, ca.executeRpc]) {
      const t = than(sql, ten);
      expect(t).toMatch(/SECURITY DEFINER/);
      expect(t).toMatch(/SET search_path = pg_catalog, public, app_private, extensions/);
    }
  });

  it('xem trước: cổng chạy TRƯỚC khi phát nonce và trước khi tra thực thể', () => {
    const t = than(sql, ca.previewRpc);
    thuTuTang(t, [
      ['kiểm đăng nhập', /IF v_actor IS NULL THEN\s*\n\s*RAISE EXCEPTION 'unauthenticated'/],
      ['kiểm tổ chức', /organization_required/],
      ['cổng hành động', new RegExp(`copilot_action_gate_v1\\(\\s*\\n?\\s*'${nhuMau(ca.actionId)}'`)],
      ['fail-closed theo tổ chức', /entity_not_found/],
      ['dựng canonical', /v_canonical := jsonb_build_object\(/],
      ['ghi hàng xác nhận', /INSERT INTO app_private\.copilot_write_confirmations/],
      ['trả nonce một lần', /'confirmation_nonce',\s*encode\(v_nonce, 'hex'\)/],
    ]);
    expect(t).toMatch(new RegExp(`'${nhuMau(ca.actionId)}', app_private\\.copilot_payload_hash_v1`));
    expect(t).toMatch(
      new RegExp(`'${nhuMau(ca.permissionKey)}', clock_timestamp\\(\\) \\+ interval '5 minutes'`),
    );
  });

  it('xem trước: thực thể lấy fail-closed theo tổ chức, KHÔNG chỉ theo id', () => {
    const t = than(sql, ca.previewRpc);
    expect(t).toMatch(new RegExp(`FROM public\\.${ca.refTable}\\b`));
    expect(t).toMatch(/AND deleted_at IS NULL/);
    expect(t).toMatch(/AND organization_id = p_organization_id/);
  });

  it('xem trước: phạm vi TOÀ fail-closed, kể cả khi thực thể không gắn toà', () => {
    const t = than(sql, ca.previewRpc);
    expect(t).toMatch(
      new RegExp(`authorized_scope_v3\\('${nhuMau(ca.permissionKey)}', p_organization_id\\)`),
    );
    // Đúng hình dạng "NULL HOẶC không thuộc mảng", không phải "NOT NULL VÀ …".
    // Bài học F4 của G2-D: điều kiện cũ để lọt mọi thực thể không gắn toà.
    expect(t).toMatch(
      new RegExp(
        `AND \\(${ca.bienThucThe}\\.building_id IS NULL\\s*\\n\\s*OR NOT \\(${ca.bienThucThe}\\.building_id = ANY\\(`,
      ),
    );
    expect(t).not.toMatch(new RegExp(`AND ${ca.bienThucThe}\\.building_id IS NOT NULL`));
  });

  it('thực thi: 11 bước đúng thứ tự ABI, readback nằm SAU RPC gốc', () => {
    const t = than(sql, ca.executeRpc);
    thuTuTang(t, [
      ['regex nonce', /p_confirmation_nonce !~ '\^\[0-9a-fA-F\]\{64\}\$'/],
      ['khoá hàng xác nhận', /FOR UPDATE/],
      ['so hợp đồng tool/permission', /confirmation_contract_mismatch/],
      ['so payload_hash', /payload_changed/],
      ['tổ chức của hàng xác nhận', /organization_mismatch/],
      ['cổng hành động lần hai', new RegExp(`copilot_action_gate_v1\\('${nhuMau(ca.actionId)}'`)],
      ['advisory lock', /pg_advisory_xact_lock\(hashtextextended\(v_key, 0\)\)/],
      ['tra sổ audit', /FROM public\.ai_write_audit a/],
      ['CAS consumed_at', /SET consumed_at = clock_timestamp\(\)/],
      ['before_digest', /INTO v_before/],
      ['gọi RPC gốc', new RegExp(`public\\.${ca.rpcGoc}\\(`)],
      ['readback', /INTO v_doc_lai/],
      ['ghi ai_write_audit', /INSERT INTO public\.ai_write_audit/],
      ['ghi sổ hành động', /copilot_ledger_append_v1\(jsonb_build_object\(\s*\n\s*'event',\s*'action_executed'/],
    ]);
  });

  it('thực thi: readback đọc lại từ BẢNG và ép đúng công ty + đúng người tạo', () => {
    const t = than(sql, ca.executeRpc);
    // Đọc lại từ bảng thật, không phải dùng lại giá trị RPC gốc trả về.
    expect(t).toMatch(new RegExp(`SELECT \\* INTO v_doc_lai\\s*\\n\\s*FROM public\\.${ca.entityTable}\\b`));
    expect(t).toMatch(/v_doc_lai\.organization_id IS DISTINCT FROM v_org/);
    expect(t).toMatch(/copilot_write_readback_mismatch/);
    // Người tạo: `user_id` cho chỉ số, `held_by` cho phiếu giữ chỗ.
    expect(t).toMatch(/v_doc_lai\.(user_id|held_by) IS DISTINCT FROM v_actor/);
    // `after_digest` dựng TỪ bản đọc lại, không từ giá trị RPC gốc trả về.
    expect(t).toMatch(/v_after := to_jsonb\(v_doc_lai\);/);
    expect(t).toMatch(
      /'after_digest',\s*encode\(extensions\.digest\(\s*\n?\s*convert_to\(v_after::text, 'UTF8'\), 'sha256'\), 'hex'\)/,
    );
  });

  it('thực thi: nhánh lặp trả `da_thuc_hien_truoc_do` và KHÔNG ghi sổ', () => {
    const t = than(sql, ca.executeRpc);
    const lap = t.indexOf("'da_thuc_hien_truoc_do'");
    const ghiSo = t.search(/'event',\s*'action_executed'/);
    expect(lap).toBeGreaterThan(-1);
    expect(ghiSo).toBeGreaterThan(lap);
    // Lượt lặp không biết id thực thể từ payload (đây là hành động TẠO), nên nó
    // phải đọc lại từ chính dòng audit cũ — trả NULL ở đây là mất dấu bản ghi.
    expect(t).toMatch(/'entity_id',\s*v_prev\.entity_id/);
    expect(t).toMatch(/'status',\s*'da_thuc_hien'/);
    expect(t).toMatch(/'ledger_id',\s*v_ledger_id/);
    expect(t).toMatch(
      new RegExp(`v_key := 'copilot_action:${nhuMau(ca.actionId)}:' \\|\\| v_actor::text`),
    );
    expect(t).toMatch(/\|\| v_org::text \|\| ':' \|\| encode\(v_hash, 'hex'\)/);
  });

  it('thực thi: lỗi của RPC gốc ghi `action_failed` rồi RE-RAISE', () => {
    const t = than(sql, ca.executeRpc);
    thuTuTang(t, [
      ['bắt lỗi', /EXCEPTION WHEN others THEN\s*\n\s*GET STACKED DIAGNOSTICS/],
      ['ghi sổ thất bại', /'event',\s*'action_failed'/],
      ['re-raise', /^\s*RAISE;$/m],
    ]);
    expect(t).toMatch(/'error_code',\s*v_message/);
    expect(t).toMatch(/'sqlstate',\s*v_sqlstate/);
    // Sổ thất bại KHÔNG được mang `after_digest`: chưa có gì để đọc lại.
    const iFail = t.search(/'event',\s*'action_failed'/);
    const khoiFail = t.slice(iFail, t.indexOf('RAISE;', iFail));
    expect(khoiFail).not.toMatch(/after_digest/);
  });

  it('ACL: REVOKE PUBLIC/anon/service_role/authenticated rồi GRANT authenticated', () => {
    for (const ten of [ca.previewRpc, ca.executeRpc]) {
      expect(sql).toMatch(
        new RegExp(`REVOKE ALL ON FUNCTION public\\.${ten}\\([a-z, ]+\\)\\s*\\n?\\s*FROM PUBLIC;`),
      );
      for (const vai of ['anon', 'service_role', 'authenticated']) {
        expect(sql).toMatch(
          new RegExp(`REVOKE ALL ON FUNCTION public\\.${ten}\\([a-z, ]+\\) FROM ${vai};`),
        );
      }
      expect(sql).toMatch(
        new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${ten}\\([a-z, ]+\\) TO authenticated;`),
      );
    }
  });

  it('registry: một hàng risk L4 / nonce_abi_v1 / click, đúng khoá quyền và cặp RPC', () => {
    expect(sql).toMatch(/INSERT INTO app_private\.copilot_action_registry/);
    expect(sql).toMatch(new RegExp(`'${nhuMau(ca.actionId)}',`));
    expect(sql).toMatch(/\n\s*'L4',\n\s*'nonce_abi_v1',\n\s*'click',/);
    expect(sql).toMatch(new RegExp(`'${nhuMau(ca.permissionKey)}',\\n\\s*'L4',`));
    expect(sql).toMatch(new RegExp(`'${ca.previewRpc}',\\n\\s*'${ca.executeRpc}',`));
    expect(sql).toMatch(/ON CONFLICT \(action_id\) DO NOTHING;/);
    // Hai action này KHÔNG có RPC lùi, và điều đó phải khai TƯỜNG MINH bằng NULL
    // kèm một `rollback_note` nói người ta lùi bằng cách nào. Một ghi chú rỗng
    // nghĩa là không ai biết lùi thế nào.
    expect(sql).toMatch(/\n\s*NULL,\n\s*'[A-Za-z]/);
  });

  it('cờ kill switch: seed `disabled`, kẹp giữa hai lần set_config transition v2', () => {
    const iMo = sql.indexOf("set_config('app.copilot_feature_flag_transition', 'v2', true)");
    const iSeed = sql.indexOf('INSERT INTO public.copilot_feature_flags');
    const iDong = sql.indexOf("set_config('app.copilot_feature_flag_transition', '', true)");
    expect(iMo).toBeGreaterThan(-1);
    expect(iSeed).toBeGreaterThan(iMo);
    expect(iDong).toBeGreaterThan(iSeed);
    expect(sql).toMatch(new RegExp(`'action', '${nhuMau(ca.actionId)}', 'disabled'`));
    expect(sql).toMatch(/ON CONFLICT \(scope, contract_id\) DO NOTHING;/);
  });

  it('khối nghiệm thu chỉ soi catalog — chạy được trên database rỗng', () => {
    const iNghiemThu = sql.indexOf('DO $nghiem_thu$');
    expect(iNghiemThu).toBeGreaterThan(-1);
    const khoi = sql.slice(iNghiemThu);
    expect(khoi).toMatch(/to_regprocedure\(/);
    for (const bang of [
      'public.meter_readings',
      'public.meters',
      'public.rooms',
      'public.room_reservation_holds',
    ]) {
      expect(khoi).not.toMatch(new RegExp(`FROM ${nhuMau(bang)}\\b`));
    }
  });
});

describe('G2-E — chỉ số công tơ KHÔNG chạm ảnh, và không tự nhận là nháp', () => {
  const sql = doc(FILE_CHI_SO);

  it('gọi create_meter_reading_v1 với `p_meter_image_url` luôn NULL', () => {
    const t = than(sql, 'copilot_execute_meter_reading_v1');
    expect(t).toMatch(
      /v_moi := public\.create_meter_reading_v1\(v_meter_id, v_ngay, v_chi_so, v_ghi_chu, NULL\);/,
    );
  });

  it('không có đường nào nhận URL ảnh từ payload', () => {
    for (const ten of ['copilot_preview_meter_reading_v1', 'copilot_execute_meter_reading_v1']) {
      const t = than(sql, ten);
      expect(t).not.toMatch(/image/i);
      expect(t).not.toMatch(/attachment/i);
    }
  });

  it('registry KHÔNG khai `verify_kind` dạng nháp — RPC gốc ép status APPROVED', () => {
    // `create_meter_reading_v1` ghi cứng `status = 'APPROVED'`. Khai một
    // `verify_kind` chứa chữ "draft" ở đây sẽ là một lời hứa mà không dòng mã
    // nào giữ, và sổ đăng ký là thứ người vận hành đọc để biết action nào ghi
    // ra bản nháp.
    expect(sql).toMatch(/'readback_org_creator',/);
    const iRegistry = sql.indexOf('INSERT INTO app_private.copilot_action_registry');
    const khoi = sql.slice(iRegistry, sql.indexOf('ON CONFLICT (action_id)', iRegistry));
    expect(khoi).not.toMatch(/draft/i);
  });

  it('chỉ số kỳ trước lấy đúng luật của trigger auto_populate_previous_reading', () => {
    const t = than(sql, 'copilot_preview_meter_reading_v1');
    expect(t).toMatch(/ORDER BY mr\.reading_date DESC, mr\.created_at DESC/);
    expect(t).toMatch(/v_truoc := COALESCE\(v_meter\.initial_reading, 0\);/);
    // Tiêu thụ âm là CẢNH BÁO, không phải chặn: CHECK của bảng mới là hàng rào.
    expect(t).toMatch(/v_chi_so < v_truoc/);
    expect(t).toMatch(/'canh_bao',\s*v_canh_bao/);
  });
});

describe('G2-E — phiếu giữ chỗ ép bất biến CHỜ DUYỆT', () => {
  const sql = doc(FILE_GIU_CHO);

  it('readback ném `copilot_draft_invariant_violation` khi trạng thái khác PENDING_APPROVAL', () => {
    const t = than(sql, 'copilot_execute_reservation_deposit_v1');
    // Hình dạng đầy đủ của điều kiện (kèm phép so số tiền của fix#4) được ghim
    // ở khối `G2-E fix#4`; ở đây chỉ đo rằng trạng thái LÀ một trong các vế.
    expect(t).toMatch(/IF v_doc_lai.status IS DISTINCT FROM 'PENDING_APPROVAL'/);
    expect(t).toMatch(/RAISE EXCEPTION 'copilot_draft_invariant_violation'/);
    // Bất biến nháp phải nằm SAU readback (không có gì để so trước đó) và TRƯỚC
    // khi ghi sổ audit — ghi sổ rồi mới kiểm là ghi một sự kiện có thể phải rút.
    thuTuTang(t, [
      ['readback', /SELECT \* INTO v_doc_lai/],
      ['bất biến nháp', /copilot_draft_invariant_violation/],
      ['ghi ai_write_audit', /INSERT INTO public\.ai_write_audit/],
    ]);
  });

  it('khoá idempotency của RPC gốc dẫn xuất từ CÙNG payload_hash', () => {
    const t = than(sql, 'copilot_execute_reservation_deposit_v1');
    expect(t).toMatch(
      /v_key_goc := 'copilot_action_' \|\| substr\(encode\(v_hash, 'hex'\), 1, 40\);/,
    );
    expect(t).toMatch(
      /v_ket := public\.create_reservation_deposit_v1\(v_room_id, v_so_tien, v_key_goc\);/,
    );
  });

  it('khoá đó thoả regex mà RPC gốc đòi — regex đọc TỪ baseline, không chép tay', () => {
    // Nguồn độc lập: thân `create_reservation_deposit_v1` trong baseline schema.
    const baseline = docSql('supabase/baseline/schema.sql');
    const iHam = baseline.indexOf('CREATE FUNCTION public.create_reservation_deposit_v1(');
    expect(iHam, 'không tìm thấy create_reservation_deposit_v1 trong baseline').toBeGreaterThan(-1);
    const thanGoc = baseline.slice(iHam, iHam + 4000);
    const mau = /v_key !~ '(\^\[A-Za-z0-9\]\[A-Za-z0-9\._:-\]\{7,199\}\$)'/.exec(thanGoc);
    expect(mau, 'không bóc được regex idempotency_key từ baseline').not.toBeNull();
    const regexGoc = new RegExp(mau![1].replace(/\\\./g, '.'));

    // Khoá thật mà migration dựng: tiền tố + 40 ký tự hex đầu của sha256.
    const khoaMau = `copilot_action_${'a1b2c3d4e5'.repeat(4)}`;
    expect(khoaMau).toHaveLength(55);
    expect(regexGoc.test(khoaMau)).toBe(true);
    // Và một khoá rỗng/ngắn thì KHÔNG thoả — chứng minh regex thật sự đang đo.
    expect(regexGoc.test('copilot')).toBe(false);
  });

  it('phiếu giữ chỗ còn hiệu lực chỉ là CẢNH BÁO ở xem trước, không phải hàng rào thứ hai', () => {
    const t = than(sql, 'copilot_preview_reservation_deposit_v1');
    expect(t).toMatch(/h\.status IN \('PENDING_APPROVAL', 'APPROVED'\)/);
    expect(t).toMatch(/v_canh_bao := 'Phòng ĐANG có phiếu giữ chỗ/);
    // Không được RAISE vì lý do "đang có phiếu giữ chỗ": ràng buộc EXCLUDE của
    // bảng là hàng rào thật, và bản thứ hai của một luật là bản sẽ lệch.
    expect(t).not.toMatch(/RAISE EXCEPTION 'phong_dang_giu/);
  });
});

describe('G2-E — `invoice.create_draft` KHÔNG được dựng lén', () => {
  it('không migration nào của đợt này tạo cặp RPC hoá đơn cho Copilot', () => {
    for (const file of [FILE_CHI_SO, FILE_GIU_CHO]) {
      const sql = doc(file);
      expect(sql).not.toMatch(/copilot_(preview|execute)_invoice/);
      expect(sql).not.toMatch(/public\.create_invoice_v1\(/);
    }
  });
});

describe('G2-E — đột biến: bình luận hoá cổng phải làm test ĐỎ', () => {
  const MOC = "copilot_action_gate_v1('meter_reading.create', v_org)";
  const PIN = /copilot_action_gate_v1\('meter_reading\.create', v_org\)/;

  function binhLuanHoaCong(sqlTho: string): string {
    const dong = sqlTho.split('\n');
    const i = dong.findIndex((d) => d.includes(MOC));
    expect(i, 'không tìm thấy dòng cổng để đột biến').toBeGreaterThan(-1);
    dong[i] = `-- ${dong[i]}`;
    return dong.join('\n');
  }

  it('văn bản THÔ vẫn khớp pin sau khi bị bình luận hoá — đó chính là cái lỗ', () => {
    expect(binhLuanHoaCong(thoChiSo)).toMatch(PIN);
  });

  it('bản đã lột bình luận thì KHÔNG khớp nữa — cửa đã đóng', () => {
    expect(boCommentSql(binhLuanHoaCong(thoChiSo))).not.toMatch(PIN);
    expect(doc(FILE_CHI_SO)).toMatch(PIN);
  });
});

// ── Fix round 1 (review G2-E) ───────────────────────────────────────────────

describe('G2-E fix#1 — bản xem trước chỉ số công tơ NÓI RA trạng thái thật', () => {
  const sql = doc(FILE_CHI_SO);

  it('khối preview có `trang_thai` và nó nói ĐÃ DUYỆT, không hứa là nháp', () => {
    const t = than(sql, 'copilot_preview_meter_reading_v1');
    expect(t).toMatch(/'trang_thai',\s*'Đã duyệt ngay/);
    expect(t).toMatch(/KHÔNG phải bản nháp/);
    // Cấm hình dạng ngược: một chuỗi hứa "chờ duyệt" ở đúng trường này là lời
    // nói dối tốn kém nhất của cả đợt — người bấm sẽ tưởng còn một bước duyệt.
    expect(t).not.toMatch(/'trang_thai',\s*'[^']*[Cc]hờ duyệt/);
  });
});

describe('G2-E fix#2 — trần và sàn số tiền cọc giữ chỗ', () => {
  const sql = doc(FILE_GIU_CHO);

  it('hai hằng số khai trong hàm, không đọc từ bảng cấu hình', () => {
    const t = than(sql, 'copilot_preview_reservation_deposit_v1');
    expect(t).toMatch(/c_toi_thieu constant numeric := 10000;/);
    expect(t).toMatch(/c_toi_da\s+constant numeric := 500000000;/);
    // Một cái van an toàn đọc cấu hình là một cái van nới được mà không cần
    // review SQL. Cấm mọi đường đọc ngưỡng từ payload hoặc từ một bảng.
    expect(t).not.toMatch(/p_payload ->> '(min_amount|max_amount|amount_limit)'/);
  });

  it('chặn ở XEM TRƯỚC, TRƯỚC khi phát nonce — số vô lý không tiêu nonce nào', () => {
    const t = than(sql, 'copilot_preview_reservation_deposit_v1');
    expect(t).toMatch(
      /IF v_so_tien < c_toi_thieu OR v_so_tien > c_toi_da THEN\s*\n\s*RAISE EXCEPTION 'amount_out_of_range' USING ERRCODE = '22023';/,
    );
    thuTuTang(t, [
      ['chặn ngoài khoảng', /amount_out_of_range/],
      ['sinh nonce', /v_nonce := extensions\.gen_random_bytes\(32\)/],
      ['ghi hàng xác nhận', /INSERT INTO app_private\.copilot_write_confirmations/],
    ]);
  });

  it('hai mốc được ghi trong chú thích đầu file — người đọc không phải suy từ mã', () => {
    // Bài này CỐ Ý đọc bản CÒN bình luận: nó đo tài liệu, không đo hàng rào.
    const tho = docSql(FILE_GIU_CHO);
    expect(tho).toMatch(/TRẦN VÀ SÀN SỐ TIỀN/);
    expect(tho).toMatch(/10\.000 ₫ ≤ số tiền ≤ 500\.000\.000 ₫/);
  });
});

describe('G2-E fix#4 — readback ép GIÁ TRỊ, không chỉ danh tính', () => {
  it('chỉ số công tơ: so chỉ số (đã làm tròn 2 chữ số) và ngày chốt', () => {
    const t = than(doc(FILE_CHI_SO), 'copilot_execute_meter_reading_v1');
    expect(t).toMatch(
      /IF v_doc_lai\.current_reading IS DISTINCT FROM round\(v_chi_so, 2\)\s*\n\s*OR v_doc_lai\.reading_date IS DISTINCT FROM v_ngay THEN\s*\n\s*RAISE EXCEPTION 'copilot_draft_invariant_violation'/,
    );
    // `round(…, 2)` chứ không so thô: cột là numeric(10,2) nên 1234.567 gửi lên
    // nằm trong bảng thành 1234.57, và so thô sẽ báo động giả ở mọi chỉ số lẻ.
    expect(t).not.toMatch(/current_reading IS DISTINCT FROM v_chi_so\b/);
    // Giá trị phải được so TRƯỚC khi ghi sổ audit.
    thuTuTang(t, [
      ['readback', /SELECT \* INTO v_doc_lai/],
      ['ép giá trị', /copilot_draft_invariant_violation/],
      ['ghi ai_write_audit', /INSERT INTO public\.ai_write_audit/],
    ]);
  });

  it('phiếu giữ chỗ: so số tiền cùng lúc với bất biến CHỜ DUYỆT', () => {
    const t = than(doc(FILE_GIU_CHO), 'copilot_execute_reservation_deposit_v1');
    expect(t).toMatch(
      /IF v_doc_lai\.status IS DISTINCT FROM 'PENDING_APPROVAL'\s*\n\s*OR v_doc_lai\.amount IS DISTINCT FROM round\(v_so_tien, 2\) THEN\s*\n\s*RAISE EXCEPTION 'copilot_draft_invariant_violation'/,
    );
  });
});

describe('G2-E fix#3 — `ghi_chu_qua_dai` mang MỘT ngưỡng ở mọi chỗ raise nó', () => {
  it('mọi migration raise mã này đều chặn ở 5000', () => {
    // Mã lỗi là hợp đồng với người dùng: `dienGiaiLoiHanhDong` gắn ĐÚNG MỘT câu
    // tiếng Việt cho nó ("tối đa 5000 ký tự"). Hai chỗ raise cùng mã với hai
    // ngưỡng khác nhau thì câu đó chỉ đúng với một bên, và bên kia bảo người
    // dùng cắt bớt một đoạn văn hoàn toàn hợp lệ.
    const files = [
      'supabase/migrations/20260903072353_copilot_action_income_expense_annotate_v1.sql',
      FILE_CHI_SO,
    ];
    let soChoRaise = 0;
    for (const file of files) {
      const sql = doc(file);
      const dong = sql.split('\n');
      for (let i = 0; i < dong.length; i += 1) {
        if (!dong[i].includes("RAISE EXCEPTION 'ghi_chu_qua_dai'")) continue;
        soChoRaise += 1;
        // Điều kiện nằm ở dòng ngay trên câu RAISE.
        expect(dong[i - 1], `${file}:${i} — ngưỡng phải là 5000`).toMatch(/> 5000 THEN$/);
      }
    }
    expect(soChoRaise, 'không tìm thấy chỗ nào raise ghi_chu_qua_dai').toBe(2);
  });
});
