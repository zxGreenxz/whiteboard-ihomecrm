// Bản build này được dựng từ commit nào — hằng số nhúng lúc build.
//
// VÌ SAO CẦN
//   Đánh giá live 13/08/2026 ca C38 hỏng vì một lý do không nằm trong mã: source
//   CÓ tính năng đọc ảnh, unit test CÓ, nhưng deployment production KHÔNG có nút
//   upload. Tức bản đang chạy không phải bản vừa được review. Cả một buổi thử
//   nghiệm 40 ca chạy trên một thứ mà không ai biết chính xác là gì.
//
//   Không có cách nào phát hiện chuyện đó từ bên trong test: mọi khẳng định đều
//   đúng với source, và source thì không phải thứ người dùng chạm vào. Chỉ có
//   một cách — bản build tự khai nó là ai, và E2E đối chiếu với commit đang được
//   review trước khi tin bất cứ kết quả nào.
//
// VÌ SAO LÀ SHA ĐẦY ĐỦ, KHÔNG PHẢI SHA NGẮN
//   SHA ngắn (7 ký tự) đủ cho người đọc log, nhưng phép so ở đây là so máy với
//   máy và nó phải là bằng-hay-không-bằng. Một tiền tố trùng nhau là chuyện hiếm
//   nhưng không phải không thể, và "hiếm" là loại lỗi tệ nhất để đi tìm.
//
// KHI KHÔNG BIẾT THÌ NÓI KHÔNG BIẾT
//   Build local không qua CI có thể không có biến môi trường. Giá trị lúc đó là
//   chuỗi rỗng, và E2E coi chuỗi rỗng là THẤT BẠI chứ không phải "bỏ qua" — một
//   phép kiểm tự tắt khi thiếu dữ liệu là một phép kiểm không tồn tại.

/**
 * SHA 40 ký tự hex của commit dựng ra bản này, hoặc chuỗi rỗng khi không biết.
 *
 * Vite thay `import.meta.env.VITE_BUILD_SHA` lúc build. Vercel cấp
 * `VERCEL_GIT_COMMIT_SHA`; script build cục bộ có thể truyền
 * `VITE_BUILD_SHA=$(git rev-parse HEAD)`.
 */
export const BUILD_SHA: string = (import.meta.env?.VITE_BUILD_SHA as string | undefined) ?? '';

/** SHA có đúng hình dạng một commit git đầy đủ không. */
export function shaHopLe(sha: string): boolean {
  return /^[0-9a-f]{40}$/.test(sha);
}

/**
 * Gắn SHA vào một thẻ meta cùng nguồn để E2E đọc được.
 *
 * Dùng thẻ meta chứ không dùng biến global: `window.__BUILD_SHA` có thể bị mã
 * khác ghi đè sau khi tải, còn thẻ meta nằm trong DOM ngay từ lúc dựng và
 * Playwright đọc được mà không phải chờ script nào chạy xong.
 *
 * Không ghi gì khi SHA rỗng — một thẻ `content=""` trông như "đã khai" và làm
 * người đọc tưởng phép kiểm đang chạy.
 */
export function ganMetaBuildSha(sha: string = BUILD_SHA, doc: DomToiThieu | null = layDoc()): void {
  if (!shaHopLe(sha)) return;
  if (!doc) return;
  let el = doc.querySelector('meta[name="build-sha"]');
  if (!el) {
    el = doc.createElement('meta');
    el.name = 'build-sha';
    doc.head.appendChild(el);
  }
  el.content = sha;
}

/**
 * Phần DOM mà hàm trên thật sự cần.
 *
 * Khai hẹp như vậy để test được ở môi trường node — repo cố ý không cài jsdom
 * (nhiều test khai `@vitest-environment node`), nên một hàm chỉ chạy được khi có
 * `document` toàn cục là một hàm không có test. Và thứ đáng test ở đây không
 * phải trình duyệt, mà là luật: SHA sai hình dạng thì KHÔNG ghi gì.
 */
export interface TheMetaToiThieu {
  name: string;
  content: string;
}
export interface DomToiThieu {
  querySelector(sel: string): TheMetaToiThieu | null;
  createElement(tag: string): TheMetaToiThieu;
  head: { appendChild(el: TheMetaToiThieu): void };
}

function layDoc(): DomToiThieu | null {
  return typeof document === 'undefined' ? null : (document as unknown as DomToiThieu);
}
