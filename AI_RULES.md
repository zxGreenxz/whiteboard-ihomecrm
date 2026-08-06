# AI Rules — đã chuyển vào Project Contract

> **Luật hiện hành: [`docs/engineering/PROJECT_CONTRACT.md`](docs/engineering/PROJECT_CONTRACT.md)**

File này từng chứa quy ước code cho dự án. Bốn rule trong đó đã **sai** với hệ thống hiện tại, và
người đọc không có cách nào biết là sai:

| Rule cũ | Vì sao sai |
|---|---|
| "ALWAYS write TypeScript with strict mode enabled" | `tsconfig.app.json` đang `strict: false`; ratchet thật là `ts-baseline.json` |
| "STORE files in Supabase Storage buckets" | Hệ thống dùng **Cloudflare R2** (`src/lib/storage/r2Config.ts`) |
| "KEEP all route definitions in src/App.tsx" | Đi ngược kế hoạch tách route + Capability Registry |
| "NEVER write custom CSS files" | Có page CSS cô lập có chủ đích (`networkCenter.css`) |

Phần còn đúng — shadcn/ui làm nền, React Hook Form + Zod, data qua hook `use*`, Sonner cho toast,
lazy load route nặng, Lucide icons, cấu trúc thư mục — đã chuyển nguyên vẹn sang
**Project Contract §14**, nơi nó nằm cạnh các invariant khác thay vì trong một file riêng có thể
lệch đi lần nữa.

Đó chính là lý do rút file này: cùng một luật viết ở ba nơi thì sớm muộn ba nơi sẽ nói ba điều khác
nhau, và không ai biết nơi nào đúng.
