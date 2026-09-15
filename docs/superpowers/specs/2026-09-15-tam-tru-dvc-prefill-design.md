# Điền sẵn hồ sơ Đăng ký tạm trú trên Cổng DVC Bộ Công an — thiết kế

Ngày: 15/09/2026. Trạng thái: đã duyệt miệng bởi chủ (cách 1, kèm tuỳ chọn chụp ảnh trực tiếp).

## 1. Bài toán

Chủ nhà đăng ký tạm trú cho khách thuê trên `dichvucong.dancuquocgia.gov.vn`
(form `dang-ky-tam-tru.html?ma_thu_tuc=1.004194&TT=TAMTRU_01`). Đo thật 15/09/2026:
mọi ô chữ đều chép tay từ trang Khách hàng của CRM; ba loại tệp đính kèm là ảnh chụp
tờ khai CT01 đã ký, hợp đồng thuê đã ký, và giấy tờ chứng minh chỗ ở hợp pháp (cố định
theo toà). Mục tiêu: sau khi bấm một nút trên CRM, form được điền và gắn đủ tệp; người
dùng chỉ xem lại, tick "chịu trách nhiệm" và bấm Nộp hồ sơ.

Phạm vi lần này: thủ tục **Đăng ký tạm trú, lập hộ mới, mỗi khách một hộ, khách là chủ
hộ** (đúng cách chủ đang làm; một phòng nhiều người vẫn mỗi người một hồ sơ). Không điền
bảng "người cần xin ý kiến" VNeID và bảng "thành viên cùng thay đổi".

## 2. Kiến trúc

Ba phần, ranh giới rõ:

1. **CRM (React/Supabase)** sở hữu dữ liệu và quyền: bảng tệp hồ sơ tạm trú, giao diện
   tải ảnh (chụp trực tiếp hoặc chọn tệp), và bộ dựng gói dữ liệu `TamTruPayload`.
2. **Extension Chrome (MV3, thư mục `extensions/tam-tru/`, không bước build)** là bộ
   điền "câm": nhận gói từ trang CRM, mở cổng DVC, đổ dữ liệu bằng chính hàm của cổng,
   gắn tệp. Không giữ credential, không gọi Supabase; chỉ tải tệp qua signed URL nằm sẵn
   trong gói.
3. **Cổng DVC** giữ nguyên; người dùng đăng nhập VNeID, xem lại, nộp.

Luồng: Chi tiết khách → nút "Đăng ký tạm trú trên DVC" → CRM kiểm đủ dữ liệu, dựng gói,
gọi `chrome.runtime.sendMessage(<id extension>, …)` → background kiểm origin gửi và host của
mọi URL ảnh, lưu gói vào `chrome.storage.session`, mở tab form → content script trên form
thấy gói, hiện bảng nổi "Điền hồ sơ cho <tên>" → bấm Điền → script chạy ở MAIN world.

Không dùng `window.postMessage` cho gói dữ liệu: tin trên window đến mọi listener cùng cửa
sổ, kể cả content script của extension khác, và `MessageChannel` cũng không cứu được vì cổng
nằm trong chính sự kiện đó. Gói có CCCD, ngày sinh và signed URL tới ảnh giấy tờ nên đi
đường riêng qua `externally_connectable`; id extension cố định nhờ khoá `key` trong manifest.

Nhận diện extension: content script cầu nối đặt `data-ihome-tamtru-ext="<version>"` và
`data-ihome-tamtru-id` lên `<html>` lúc `document_start`; CRM đọc thuộc tính này để bật nút
hoặc hiện hướng dẫn cài.

## 3. Dữ liệu

### 3.1 Bảng `public.residence_dossier_files`

| Cột | Kiểu | Ghi chú |
|---|---|---|
| id | uuid pk | gen_random_uuid() |
| organization_id | uuid not null | FK organizations |
| building_id | uuid not null | FK buildings; mọi loại đều neo theo toà để kiểm quyền |
| customer_id | uuid null | FK customers; bắt buộc với CT01/LEASE |
| contract_id | uuid null | FK contracts; hợp đồng lúc tải |
| kind | text | `CT01` \| `LEASE` \| `OWNERSHIP` |
| bucket_id, object_name | text | định danh object Storage, bucket `residence-docs` |
| storage_ref | text | URL kiểu `/object/public/residence-docs/<object_name>` (giống các bảng khác, ký lúc đọc) |
| file_name, content_type, size_bytes | | metadata |
| sort_order | int | thứ tự ảnh |
| created_by, created_at, deleted_at | | xoá mềm |

Ràng buộc: `kind='OWNERSHIP'` ⇒ `customer_id IS NULL`; `kind IN ('CT01','LEASE')` ⇒
`customer_id IS NOT NULL`. Object name bắt đầu bằng `auth.uid()/`.

RLS (theo mẫu `building_legal_owners`):
- SELECT: `can_access_building(building_id)` và `can_do_on_building('customers','print',building_id)`.
- INSERT: `created_by = auth.uid()`, org khớp toà, khách (nếu có) cùng org; CT01/LEASE cần
  `customers.print`, OWNERSHIP cần `buildings.edit`.
- UPDATE chỉ để đặt `deleted_at` với cùng điều kiện INSERT. Không DELETE cứng từ client.
- `residence_dossier_files_hide_sandbox_admin` RESTRICTIVE với `COALESCE(...,false)`.

### 3.2 Bucket Storage `residence-docs` (private)

- INSERT authenticated khi `bucket_id='residence-docs'` và thư mục đầu = `auth.uid()`.
- SELECT authenticated qua hàm `app_private.residence_doc_can_read_v1(bucket,name)`
  SECURITY DEFINER: tồn tại dòng chưa xoá trong bảng trên mà người gọi đọc được
  (`can_access_building` + `customers.print`, không lộ sandbox cho super admin).
- DELETE authenticated khi thư mục đầu = `auth.uid()` (dọn ảnh mình vừa tải nhầm).
- Upload qua `uploadFile('residence-docs', path, file)` của lớp storage hiện có; đọc qua
  `createSignedUrlFromStored` / `StorageImage`.

### 3.3 Gói `TamTruPayload` (CRM dựng, extension tiêu thụ)

```ts
interface TamTruPayload {
  version: 1;
  createdAt: string;               // ISO
  customerId: string; buildingName: string; roomNumber: string;
  receive: { provinceName: string; wardName: string };      // "Thành phố Hồ Chí Minh", "Phường Hạnh Thông"
  person: { fullName: string; dob: string /* dd/mm/yyyy */; genderCode: '2'|'3'|'4';
            idNumber: string /* 12 số */; phone: string; email: string };
  address: string;                  // "950/65 Nguyễn Kiệm, Khu Phố 14"
  household: { relationshipCode: 'CH01' };   // khách là chủ hộ
  tempResidentTo: string;           // dd/mm/yyyy = hôm nay + 12/24 tháng
  attachments: { kind: 'CT01'|'LEASE'|'OWNERSHIP'; fileName: string; contentType: string; url: string }[];
}
```

Quy tắc dựng (thuần, có test):
- Tỉnh: chuẩn hoá `buildings.province` ("Hồ Chí Minh", "TP Hồ Chí Minh", "Thành phố Hồ
  Chí Minh") về tên đầy đủ để khớp option của cổng; so khớp bỏ dấu, bỏ tiền tố
  "Thành phố/TP/Tỉnh".
- Phường mới: tách từ `buildings.street_address` phần bắt đầu bằng Phường/Xã/Thị trấn/Đặc
  khu (cùng luật với `buildCT01Data`); không có ⇒ lỗi "toà chưa có phường trong địa chỉ
  chi tiết". Không dùng cột `ward` (đơn vị cũ trước sáp nhập).
- Địa chỉ đăng ký: các phần của `street_address` đứng trước phần phường.
- Giới tính: `MALE|Nam→2`, `FEMALE|Nữ→3`, `OTHER|Khác→4`; trống ⇒ lỗi.
- CCCD phải đúng 12 số; ngày sinh bắt buộc.
- Thời hạn: 12/24 tháng từ hôm nay (Asia/Ho_Chi_Minh), kẹp 29/02.
- Tệp: ít nhất 1 CT01, 1 LEASE của khách (ưu tiên đúng contract_id), và ≥1 OWNERSHIP của
  toà; thiếu loại nào báo đúng loại đó. Signed URL 1 giờ.

## 4. Giao diện CRM

- **Chi tiết khách** (`CustomerDetailModal`): khối "Hồ sơ tạm trú" dưới nút CT01: hai
  hàng ảnh CT01 đã ký / Hợp đồng đã ký, mỗi hàng có nút **Chụp ảnh** (`<input type=file
  accept=image/* capture=environment>`, chỉ hiện trên thiết bị có camera) và **Chọn tệp**,
  danh sách ảnh (thumbnail + xoá). Nút **Đăng ký tạm trú trên DVC** với chọn thời hạn
  12/24 tháng; nếu khách ở nhiều phòng thì chọn phòng (giống CT01). Thiếu dữ liệu ⇒ toast
  nêu đúng thứ thiếu. Không thấy extension ⇒ hộp thoại hướng dẫn cài (đường dẫn thư mục,
  chrome://extensions, Developer mode, Load unpacked).
- **Sửa toà nhà** (`BuildingFormDialog`, chỉ khi đã có `building.id`): khối "Giấy tờ chứng
  minh chỗ ở hợp pháp (dùng cho tạm trú)" tải nhiều ảnh, cùng component.
- Quyền: đọc/ghi CT01, LEASE theo `customers.print`; OWNERSHIP theo `buildings.edit`.
  Không thêm quyền mới.

Component chung `DossierImageUploader` (kind, customerId?, contractId?, buildingId):
dùng `uploadFile` với nén ảnh mặc định, ghi dòng bảng sau khi upload xong, xoá mềm.

## 5. Extension `extensions/tam-tru/`

- `manifest.json` (MV3): `content_scripts` cầu nối trên `https://ptcrm.vercel.app/*` và
  `http://localhost:*/*`; content script UI trên
  `https://dichvucong.dancuquocgia.gov.vn/portal/p/home/dang-ky-tam-tru.html*`; script
  MAIN world `fill-engine.js` cùng match; `permissions: ["storage","tabs"]`;
  `host_permissions` cho `https://tryymsxyyckgbrmmvozx.supabase.co/*` để service worker
  tải tệp khi content script bị CORS chặn.
- `bridge.js`: đặt marker, nhận `postMessage {source:'ihome-crm', type:'TAM_TRU_PAYLOAD'}`
  đúng origin, chuyển cho background.
- `background.js`: lưu gói vào `chrome.storage.session`, mở/focus tab form; tải tệp về
  dạng data URL theo yêu cầu (`FETCH_FILE`).
- `panel.js` (isolated): hiện bảng nổi, nút Điền / Bỏ; tải tệp; gửi
  `window.postMessage({type:'IHOME_TAMTRU_RUN', payload, files})` cho MAIN world.
- `fill-engine.js` (MAIN): các bước tuần tự có chờ:
  1. chờ `#cboRECEIVE_ADDR_CITY_CODE` có option; chọn tỉnh theo tên, `trigger('change')`
     (select2 chỉ nghe jQuery); chờ phường nạp; chọn phường theo tên; chờ
     `#txtRECEIVE_ORG_ADDRESS` có giá trị.
  2. radio `#chkNEW_REGISTRATION`, `#chkIS_NOT_CHANGED_PERSON`; chờ `#cboBPROC_CASE_CODE`.
  3. `FormUtil.setObjectToFormV2('Modal_New_DKTT','', {...})` với khoá FULLNAME, DATE_FORMAT,
     DOB, GENDER_CODE, IDENTIFIER_NUMBER, PHONE_NUMBER, EMAIL, SUGGEST_ADDRESS,
     HH_PERSON_FULLNAME, HH_PERSON_RELATIONSHIP_CODE, HH_PERSON_IDENTIFIER_NUMBER,
     TEMP_RESIDENT_TO; kiểm `#txtCHANGED_NOTE` đã tự cập nhật.
  4. Đính kèm: bấm link "do thuê, mượn, ở nhờ" (`load_table_tphs_new(2)`), chờ
     `#tblGiayToDinhKem`; dòng 0 CT01, dòng 1 LEASE: tick `#chkIS_COMPULSORY{i}`, giữ
     `#cboFILE_TYPE{i}`=1, gán tệp qua `DataTransfer` vào `#fileUpload{i}` rồi
     `dispatchEvent(new Event('change',{bubbles:true}))` (trang đọc `event.target.files`
     trong `changeFileNew`). Bấm "Thêm mới" ⇒ dòng 2: `#lblFILE_TYPE_NAME2`
     = "Giấy tờ, tài liệu chứng minh chỗ ở hợp pháp", tick, gán ảnh OWNERSHIP.
  5. Cuộn lên đầu, báo "Đã điền, kiểm tra lại rồi tick chịu trách nhiệm và bấm Nộp hồ sơ"
     kèm cảnh báo (vd email trống). Không đụng `#chkCHECK_LIABILITY`, không bấm Nộp/Lưu.
  Mỗi bước có timeout; lỗi ở bước nào báo bước đó, giữ nguyên phần đã điền.
- Nếu trang mở lại bằng `?id=` (sửa nháp) thì không tự điền.

## 6. Kiểm thử

- Vitest: `tamTruPayload` (chuẩn hoá tỉnh/phường/địa chỉ/giới tính/ngày, lỗi thiếu dữ
  liệu), `residenceDossierFiles` service (lọc theo kind/contract), component uploader
  (nút chụp/chọn, gọi upload, ghi dòng).
- Extension: `extensions/tam-tru/test/fill-engine.test.mjs` (node --test) chạy engine trên
  bản HTML tĩnh rút gọn của form với jQuery + FormUtil giả lập; và script kiểm sống
  `extensions/tam-tru/test/live-fill.mjs` dùng profile Chrome đã đăng nhập ở
  `~/tamtru-recorder/profile` với `--load-extension`, chỉ điền và chụp ảnh, không lưu.
- Migration: dry-run `migrate:forward`, kiểm RLS bằng harness JWT: đúng quyền đọc được,
  org khác/không quyền bị chặn, super admin không thấy sandbox.
- E2E `.e2e-fleet`: luồng tải ảnh trên DEMO nếu DEMO có khách/toà phù hợp.

## 7. Ngoài phạm vi

Vào hộ đã có; thành viên cùng thay đổi; xin ý kiến VNeID; ghi mã hồ sơ DVC ngược về CRM;
phát hành extension lên Chrome Web Store (cài unpacked từ thư mục repo).
