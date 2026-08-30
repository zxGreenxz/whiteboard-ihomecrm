// Bộ giải control an toàn — mọi nhánh không chắc chắn phải NÉM, không được đoán.
//
// Repo cố ý không cài jsdom, nên test dựng DOM giả tối thiểu: đủ hình dạng để
// chạy đúng đường thật của bộ giải (querySelectorAll, shadowRoot, iframe), và
// không cần một trình duyệt để kiểm những luật vốn không phải luật của trình duyệt.
import { describe, expect, it } from 'vitest';
import {
  LoiSafeControl,
  THUOC_TINH_AN_TOAN,
  giaiSafeControl,
  gocDom,
  hopLoai,
  thoatChuoiChon,
  taoCongCuDieuKhienAnToan,
} from '../safeControls';

describe('taoCongCuDieuKhienAnToan', () => {
  it('chi giai control co khoa trang day du va dispatch input', async () => {
    const input = el({ id: 'invoices.list.o-tim', tag: 'input' }) as unknown as HTMLInputElement & {
      value: string;
      __safeId: string | null;
    };
    input.value = '';
    const tools = taoCongCuDieuKhienAnToan(
      { key: 'invoices.list', safeControlIds: ['o-tim'] },
      root([input]) as unknown as Document,
    );
    const result = await tools.safe_input.execute({ control_id: 'o-tim', text: 'abc' }, { signal: new AbortController().signal });
    expect(result).toContain('o-tim');
    expect(input.value).toBe('abc');
  });

  it('tu choi control khong duoc gan dung namespace trang', async () => {
    const input = el({ id: 'customers.list.o-tim', tag: 'input' });
    const tools = taoCongCuDieuKhienAnToan(
      { key: 'invoices.list', safeControlIds: ['o-tim'] },
      root([input]) as unknown as Document,
    );
    await expect(
      tools.safe_input.execute({ control_id: 'o-tim', text: 'abc' }, { signal: new AbortController().signal }),
    ).rejects.toMatchObject({ ma: 'khong_thay' });
  });

  it('khong thao tac neu phan tu bi thay the sau khi giai', async () => {
    const input = el({ id: 'invoices.list.o-tim', tag: 'input' });
    const rootDoc = root([input]) as unknown as Document;
    const tools = taoCongCuDieuKhienAnToan(
      { key: 'invoices.list', safeControlIds: ['o-tim'] },
      rootDoc,
    );
    (input as unknown as { isConnected: boolean }).isConnected = false;
    await expect(
      tools.safe_input.execute({ control_id: 'o-tim', text: 'abc' }, { signal: new AbortController().signal }),
    ).rejects.toMatchObject({ ma: 'khong_thay' });
  });

  it('kiem tra lai guard trang ngay truoc khi dispatch', async () => {
    let choPhep = true;
    let daDispatch = false;
    const input = el({ id: 'invoices.list.o-tim', tag: 'input' });
    (input as unknown as { value: string }).value = '';
    (input as unknown as { dispatchEvent: () => boolean }).dispatchEvent = () => {
      daDispatch = true;
      return true;
    };
    const tools = taoCongCuDieuKhienAnToan(
      { key: 'invoices.list', safeControlIds: ['o-tim'] },
      root([input]) as unknown as Document,
      { beforeDispatch: () => { if (!choPhep) throw new Error('page_changed'); } },
    );

    choPhep = false;
    await expect(
      tools.safe_input.execute({ control_id: 'o-tim', text: 'abc' }, { signal: new AbortController().signal }),
    ).rejects.toThrow('page_changed');
    expect(daDispatch).toBe(false);
    expect((input as unknown as { value: string }).value).toBe('');
  });
});

const trang = { key: 'invoices.list', safeControlIds: ['loc-thang', 'o-tim', 'chon-trang-thai'] };

/** Phần tử giả — chỉ những thuộc tính bộ giải thật sự đọc. */
function el(opts: {
  id?: string;
  tag?: string;
  type?: string;
  role?: string;
  connected?: boolean;
  editable?: boolean;
  shadow?: FakeRoot | null;
  iframeDoc?: FakeRoot | null;
  throwOnFrame?: boolean;
}) {
  const e = {
    tagName: (opts.tag ?? 'input').toUpperCase(),
    type: opts.type ?? 'text',
    isConnected: opts.connected ?? true,
    isContentEditable: opts.editable ?? false,
    shadowRoot: opts.shadow ?? null,
    getAttribute: (n: string) =>
      n === THUOC_TINH_AN_TOAN ? (opts.id ?? null) : n === 'role' ? (opts.role ?? null) : null,
    __safeId: opts.id ?? null,
  } as unknown as HTMLElement & { __safeId: string | null };
  if (opts.iframeDoc !== undefined) {
    Object.defineProperty(e, 'contentDocument', {
      get() {
        if (opts.throwOnFrame) throw new Error('SecurityError');
        return opts.iframeDoc;
      },
    });
    Object.setPrototypeOf(e, { constructor: { name: 'HTMLIFrameElement' } });
  }
  return e;
}

interface FakeRoot {
  querySelectorAll: (sel: string) => unknown[];
}

/** Gốc DOM giả: trả mọi phần tử cho '*', và lọc theo id cho selector thuộc tính. */
function root(dsEl: (HTMLElement & { __safeId: string | null })[]): FakeRoot {
  return {
    querySelectorAll: (sel: string) => {
      if (sel === '*') return dsEl;
      const m = /="(.*)"\]$/.exec(sel);
      const id = m?.[1] ?? '';
      return dsEl.filter((e) => e.__safeId === id);
    },
  };
}

describe('thoatChuoiChon', () => {
  it('thoát dấu nháy kép và chéo ngược khi không có CSS.escape', () => {
    expect(thoatChuoiChon('a"b')).toBe('a\\"b');
    expect(thoatChuoiChon('a\\b')).toBe('a\\\\b');
    expect(thoatChuoiChon('loc-thang')).toBe('loc-thang');
  });
});

describe('hopLoai', () => {
  it('input: nhận text/textarea/contenteditable', () => {
    expect(hopLoai(el({ tag: 'input', type: 'text' }), 'input')).toBe(true);
    expect(hopLoai(el({ tag: 'textarea' }), 'input')).toBe(true);
    expect(hopLoai(el({ tag: 'div', editable: true }), 'input')).toBe(true);
  });

  it('input: TỪ CHỐI input kiểu nút bấm — gõ vào chúng là bấm trá hình', () => {
    for (const t of ['submit', 'button', 'reset', 'checkbox', 'radio', 'image', 'file']) {
      expect(hopLoai(el({ tag: 'input', type: t }), 'input'), `type=${t}`).toBe(false);
    }
  });

  it('click: TỪ CHỐI type=submit dù đã được đánh dấu an toàn', () => {
    // Đánh dấu nhầm một nút submit là chuyện xảy ra được. Để nó lọt thì hàng rào
    // "không bao giờ tự bấm Lưu" mất hiệu lực chỉ vì một dòng thuộc tính.
    expect(hopLoai(el({ tag: 'button', type: 'submit' }), 'click')).toBe(false);
    expect(hopLoai(el({ tag: 'input', type: 'submit' }), 'click')).toBe(false);
    expect(hopLoai(el({ tag: 'button', type: 'button' }), 'click')).toBe(true);
  });

  it('select: nhận thẻ select và role combobox/listbox', () => {
    expect(hopLoai(el({ tag: 'select' }), 'select')).toBe(true);
    expect(hopLoai(el({ tag: 'div', role: 'combobox' }), 'select')).toBe(true);
    expect(hopLoai(el({ tag: 'div' }), 'select')).toBe(false);
  });
});

describe('giaiSafeControl', () => {
  const giai = (dsEl: Parameters<typeof root>[0], id: string, loai: 'click' | 'input' | 'select' = 'input') =>
    giaiSafeControl(trang, id, loai, root(dsEl) as unknown as Document);

  it('trả đúng phần tử khi có duy nhất một', () => {
    const a = el({ id: 'loc-thang', tag: 'input' });
    expect(giai([a, el({ id: 'khac' })], 'loc-thang')).toBe(a);
  });

  it('ID KHÔNG khai trong hợp đồng trang ⇒ ném, không cần biết DOM có gì', () => {
    // Đây là hàng rào đầu tiên và rẻ nhất: danh sách ID hợp lệ nằm trong hợp
    // đồng trang, không nằm trong tay mô hình.
    const a = el({ id: 'nut-xoa' });
    expect(() => giai([a], 'nut-xoa')).toThrow(LoiSafeControl);
    try {
      giai([a], 'nut-xoa');
    } catch (e) {
      expect((e as LoiSafeControl).ma).toBe('khong_khai_bao');
    }
  });

  it('không thấy phần tử ⇒ ném, KHÔNG im lặng bỏ qua', () => {
    try {
      giai([], 'loc-thang');
      throw new Error('phải ném');
    } catch (e) {
      expect((e as LoiSafeControl).ma).toBe('khong_thay');
    }
  });

  it('HAI phần tử cùng ID ⇒ ném, không đoán lấy cái đầu', () => {
    // Hai phần tử cùng ID nghĩa là trang đánh dấu sai. Bấm bừa một trong hai là
    // bấm vào thứ không ai chọn.
    try {
      giai([el({ id: 'loc-thang' }), el({ id: 'loc-thang' })], 'loc-thang');
      throw new Error('phải ném');
    } catch (e) {
      expect((e as LoiSafeControl).ma).toBe('nhieu_hon_mot');
    }
  });

  it('phần tử đã rời khỏi DOM không được tính', () => {
    // Giữa lúc mô hình "nhìn" và lúc nó bấm, React có thể đã render lại. Một
    // tham chiếu cũ vẫn tồn tại trong bộ nhớ nhưng không còn trên màn hình.
    try {
      giai([el({ id: 'loc-thang', connected: false })], 'loc-thang');
      throw new Error('phải ném');
    } catch (e) {
      expect((e as LoiSafeControl).ma).toBe('khong_thay');
    }
  });

  it('sai loại thao tác ⇒ ném', () => {
    try {
      giai([el({ id: 'loc-thang', tag: 'button', type: 'submit' })], 'loc-thang', 'click');
      throw new Error('phải ném');
    } catch (e) {
      expect((e as LoiSafeControl).ma).toBe('sai_loai');
    }
  });
});

describe('gocDom — quét đủ shadow root và iframe', () => {
  it('đi vào open shadow root', () => {
    // Bộ duyệt của page-agent đi vào đây; bộ giải của ta phải đi theo, nếu không
    // control trong shadow root sẽ "không thấy" và người viết trang tưởng mình
    // đánh dấu sai.
    const trongShadow = el({ id: 'o-tim' });
    const shadow = root([trongShadow]);
    const chu = el({ tag: 'div', shadow });
    const ds = gocDom(root([chu]) as unknown as Document);
    expect(ds).toHaveLength(2);
  });

  it('đi vào same-origin iframe', () => {
    const trongFrame = el({ id: 'o-tim' });
    const frameDoc = root([trongFrame]);
    const frame = el({ tag: 'iframe', iframeDoc: frameDoc });
    const ds = gocDom(root([frame]) as unknown as Document);
    expect(ds.length).toBeGreaterThanOrEqual(1);
  });

  it('iframe KHÁC nguồn bị bỏ qua trong im lặng, không làm vỡ phép quét', () => {
    // Truy cập contentDocument của nó ném SecurityError — và đó là đúng:
    // Copilot không có việc gì bên trong trang của bên thứ ba.
    const frame = el({ tag: 'iframe', iframeDoc: null, throwOnFrame: true });
    expect(() => gocDom(root([frame]) as unknown as Document)).not.toThrow();
  });
});
