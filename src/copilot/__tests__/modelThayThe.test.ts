// Model thay thế khi lựa chọn đã lưu không còn khả dụng.
//
// BỐI CẢNH ĐO ĐƯỢC, không phải giả thuyết: 01–03/09/2026 endpoint tự dựng
// `9router` — chính là `DEFAULT_MODEL` — chết hai ngày. Sổ của llm-proxy trong
// khoảng đó có 6 lượt `upstream_error` từ 9router và đúng 1 lượt `ok` từ
// nemotron. Bản cũ của `useCopilotModel` rơi về `DEFAULT_MODEL` KỂ CẢ khi
// provider đó đã bị tắt trong `ai_providers`, nên người dùng mặc định bấm gửi
// rồi ngồi hết 60 giây timeout, lượt này qua lượt khác.
//
// Hàm dưới đây là phần THUẦN của quyết định đó, tách ra để test được mà không
// cần React, không cần mạng và không cần Supabase.
import { describe, expect, it } from 'vitest';

import { DEFAULT_MODEL } from '../copilotConfig';
import { modelConDungDuoc, modelThayThe, nhanModel, type ModelOption } from '../useAiProviders';

const openrouter: ModelOption = {
  value: 'openrouter:nvidia/nemotron-nano-9b-v2',
  label: 'Nemotron Nano 9B — OpenRouter',
  provider: 'openrouter',
  localOnly: false,
};
const groq: ModelOption = {
  value: 'groq:llama-3.3-70b',
  label: 'Llama 3.3 70B — Groq',
  provider: 'groq',
  localOnly: false,
};
const cucBo: ModelOption = {
  value: '9router:cx/gpt-5.6-sol(max)',
  label: 'GPT-5.6 Sol — 9Router',
  provider: '9router',
  localOnly: true,
};

describe('modelThayThe', () => {
  it('chỉ còn openrouter thì chọn đúng model của openrouter', () => {
    expect(modelThayThe([openrouter])).toBe('openrouter:nvidia/nemotron-nano-9b-v2');
  });

  it('ưu tiên openrouter kể cả khi nó KHÔNG đứng đầu danh sách', () => {
    // Thứ tự server trả về là thứ tự của bảng `ai_providers`, không phải một
    // xếp hạng độ tin cậy. Ưu tiên phải là luật ở đây, không phải may mắn.
    expect(modelThayThe([groq, openrouter])).toBe('openrouter:nvidia/nemotron-nano-9b-v2');
  });

  it('không có openrouter thì lấy model đám mây đầu tiên', () => {
    expect(modelThayThe([groq])).toBe('groq:llama-3.3-70b');
  });

  it('KHÔNG bao giờ rơi vào model localOnly', () => {
    // Ollama/9Router chạy trên MÁY người dùng. Một người đang ở ngoài văn phòng
    // rơi vào đó thì không có gì để gọi cả — và model cục bộ là lựa chọn có chủ
    // ý, không phải chỗ để rớt xuống.
    expect(modelThayThe([cucBo])).toBeNull();
    expect(modelThayThe([cucBo, groq])).toBe('groq:llama-3.3-70b');
  });

  it('danh sách rỗng hoặc chưa tải xong thì KHÔNG bịa ra model nào', () => {
    expect(modelThayThe([])).toBeNull();
    expect(modelThayThe(undefined)).toBeNull();
  });
});

describe('modelConDungDuoc — hàng rào phía trước', () => {
  it('chưa tải xong (undefined) thì GIỮ NGUYÊN lựa chọn đã lưu', () => {
    // Coi "chưa biết" là "không hợp lệ" sẽ đá mọi người khỏi lựa chọn thật của
    // họ trong chớp mắt đầu tiên của mỗi lần mở panel.
    expect(modelConDungDuoc(DEFAULT_MODEL, undefined)).toBe(true);
  });

  it('model đã bị gỡ khỏi ai_providers thì không còn dùng được', () => {
    expect(modelConDungDuoc(DEFAULT_MODEL, [openrouter])).toBe(false);
    expect(modelConDungDuoc(openrouter.value, [openrouter])).toBe(true);
  });
});

describe('nhãn cho banner', () => {
  it('lấy nhãn người đọc được, không phải khoá kỹ thuật', () => {
    expect(nhanModel(openrouter.value, [openrouter])).toBe('Nemotron Nano 9B — OpenRouter');
  });

  it('model lạ thì hiện chính khoá, không hiện "undefined"', () => {
    expect(nhanModel('khong:co', [openrouter])).toBe('khong:co');
    expect(nhanModel('khong:co', undefined)).toBe('khong:co');
  });
});

describe('phép hợp — đúng kịch bản của brief', () => {
  const quyetDinh = (daLuu: string, options: ModelOption[] | undefined) => {
    const conDung = modelConDungDuoc(daLuu, options);
    const thayThe = conDung ? null : modelThayThe(options);
    return {
      model: conDung ? daLuu : (thayThe ?? DEFAULT_MODEL),
      modelLoiThoi: !conDung,
      modelThayThe: thayThe === null ? null : nhanModel(thayThe, options),
    };
  };

  it('options chỉ có openrouter → dùng nemotron, báo lỗi thời, có nhãn thay thế', () => {
    const ra = quyetDinh(DEFAULT_MODEL, [openrouter]);
    expect(ra.model).toBe('openrouter:nvidia/nemotron-nano-9b-v2');
    expect(ra.modelLoiThoi).toBe(true);
    expect(ra.modelThayThe).toBe('Nemotron Nano 9B — OpenRouter');
  });

  it('options rỗng → giữ DEFAULT_MODEL và vẫn báo lỗi thời', () => {
    // Không có gì để thay thì bịa ra một cái tên khác chỉ đổi thông báo lỗi.
    // Nhưng cờ vẫn phải bật: người dùng cần biết vì sao hôm nay khác hôm qua.
    const ra = quyetDinh(DEFAULT_MODEL, []);
    expect(ra.model).toBe(DEFAULT_MODEL);
    expect(ra.modelLoiThoi).toBe(true);
    expect(ra.modelThayThe).toBeNull();
  });

  it('model đã lưu vẫn còn → không đổi gì, không banner', () => {
    const ra = quyetDinh(openrouter.value, [openrouter, groq]);
    expect(ra.model).toBe(openrouter.value);
    expect(ra.modelLoiThoi).toBe(false);
    expect(ra.modelThayThe).toBeNull();
  });
});
