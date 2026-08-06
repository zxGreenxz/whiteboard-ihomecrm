# AGENTS.md — phần dành riêng cho Codex

> **Luật chung nằm ở [`docs/engineering/PROJECT_CONTRACT.md`](docs/engineering/PROJECT_CONTRACT.md).**
> Đọc file đó trước. Ở đây chỉ còn phần đặc thù Codex.

File này từng dài 146 dòng và chép lại gần như toàn bộ Contract. Nó cũng là bằng chứng rõ nhất cho
việc **vì sao chép luật ra nhiều nơi là sai**:

- Nó dạy chạy `npm run gen:types` kèm dấu redirect `>` đổ vào `types.ts` — suốt nhiều tháng. Shell
  cắt trắng file đích **trước khi** generator kịp chạy, nên generator lỗi là `types.ts` chỉ còn một
  dòng banner. CI ghi đúng cách làm ngay cạnh đó, nhưng file rule thì không ai sửa.
  (Cố ý KHÔNG chép nguyên văn lệnh đó ở đây: một file hướng dẫn chứa sẵn lệnh phá file thì chỉ cách
  một cú copy-paste là gây hại, bất kể câu chữ xung quanh đang chê nó. Gate `check-agent-contract`
  cũng chặn đúng như vậy.)
- Ngay trước khi rút, nó vẫn ghi ratchet TypeScript là "hiện 30" trong khi con số thật đã là **26**.

Cả hai lỗi đều không thể phát hiện bằng test — chúng là văn bản. Cách chữa duy nhất có hiệu lực là
**chỉ có một bản**. Bảng ánh xạ từng rule cũ về vị trí mới: **Contract §13**.

---

## Trailer commit

Thay đổi do Codex thực hiện dùng trailer:

```text
Co-Authored-By: Codex <noreply@openai.com>
```

Phần còn lại của quy ước commit ở Contract §3 và §11.3.

---

## Công cụ trình duyệt

Contract §8 quy định E2E chạy headless, chỉ ghi org DEMO, mật khẩu qua `FLEET_PASS_*`.

```bash
cd .e2e-fleet && FLEET_WORKERS=8 npx playwright test specs/<file>.spec.ts
```

Nếu session Codex không có công cụ browser, **ghi rõ khoảng trống xác minh trong báo cáo cuối** —
không tuyên bố đã test.
