# OpenClaw Zalo Personal - Production Design

**Trang thai:** Chu san pham da chot **Phuong an 1 - vendored integrity-pinned ZaloUser fork** ngay 2026-07-27. Spec nay da khoa kien truc; sau written spec review, cong viec chuyen sang implementation theo plan da cap nhat.

**Muc tieu:** Xay dung mot trung tam van hanh Zalo ca nhan bang OpenClaw cho iHome CRM, su dung that cho cong ty hien tai, ho tro tra loi khach hang, gui chu dong co kiem soat va gui vao cac nhom sale noi bo. He thong moi phai tach hoan toan khoi kenh Zalo cu va san sang cho mo hinh moi organization co mot tai khoan Zalo rieng.

**Kien truc chot:** Supabase la control plane va nguon du lieu chuan; chinh VPS Vultr Seoul hien co cua cong ty chay OpenClaw 2026.7.1, mot fork noi bo `@openclaw/zalouser` giu plugin ID/channel `zalouser`, va bridge trong stack cach ly khoi 9Router; mot Cloudflare R2 private rieng luu media ben vung. Trinh duyet khong ket noi truc tiep cell control endpoint. Moi business send chi di qua outbox, policy engine, private RPC `zalouser.bridge.send` va provider-entrypoint authorization cua fork.

---

## 1. Quyet dinh da khoa

Nhung quyet dinh duoi day khong duoc mo lai trong implementation neu chu san pham khong yeu cau thay doi:

- Chon **OpenClaw**, khong chon Hermes, vi he sinh thai ket noi Zalo Personal hien tai cua OpenClaw ro rang va truong thanh hon cho bai toan nay. Day van la ket noi Zalo ca nhan khong chinh thuc, khong co bao dam tu Zalo ve do on dinh hay an toan tai khoan.
- Giu OpenClaw `2026.7.1`. Fork noi bo giu package name `@openclaw/zalouser`, package version tuong thich `2026.7.1`, plugin ID va channel `zalouser`; khong tao goi hook bo sung va khong cai song song ZaloUser tu registry.
- Upstream ZaloUser duoc khoa bang fixed tarball URL `https://registry.npmjs.org/@openclaw/zalouser/-/zalouser-2026.7.1.tgz`, byte size `2341459`, `3169` regular `package/` entries, npm SRI `sha512-klg0BOOTDv4xUykgA/pTZDsRrI9dzagq23OlPupCLrFijDOebPxGYaYdWDSPy4zBJAWjjnSrgyCB+5OuCMvZGw==`, shasum/SHA-1 `ddd42ffa571e93a881ca5c95203eb7a49713f6c6`, git head `2d2ddc43d0dcf71f31283d780f9fe9ff4cc04fe4`, npm attestation subject `pkg:npm/%40openclaw/zalouser@2026.7.1`, SLSA resolved commit bang git head, OpenClaw OCI index digest `sha256:6a31d44b2944e7adcd2b582bf6fb463111264ebca97a0201795b799135bd102c`, `linux/amd64` digest `sha256:165b4992f1b4b74ffdd7a02c887ba006f9f5dc951eca420eef573a8b233b543f` va reference `linux/arm64` digest `sha256:38b611f494cb32e15aaf456d54c6b6be55db9098c90632aed0bfad4a70009707`. Chi tarball duoc phep toi da 3 HTTPS redirects cung registry/direct subdomain; JSON provenance/trust endpoints khong duoc redirect.
- Npm publish attestation va SLSA provenance la bat buoc fail-closed trong moi baseline, release va positive fork gate. Metadata unavailable, signature/provenance mismatch hoac network failure la hard stop. Offline verification chi duoc kiem tra lai committed bytes; no khong duoc tao/cap nhat `FORK.json` hash, build/release evidence, internal artifact, hay mo Tasks 3-29.
- Signed subject SHA-512 phai bang exact SRI-decoded digest `92583404e3930efe3153292003fa53643b11ac8f5dcda82adb73a53eea422eb1628c339e6cfc4661a61d58348fcb8cc12405a38e74ab832081fb93ae08cbd91b`. Npm signature pin key ID `SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U` va SPKI `MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEY6Ya7W++7aUPzvMTrezH6Ycx3c+HOKYCcNGybJZSCJq/fd7Qa8uuAKtdIkUQtQiEKERhAmE5lMMJhP8OkDOa2g==`. Fulcio pin exact URI SAN `https://github.com/openclaw/openclaw/.github/workflows/plugin-npm-release.yml@refs/heads/release/2026.7.1`, OIDC issuer `https://token.actions.githubusercontent.com`, `workflow_dispatch`, repo/ref, environment `npm-release`, leaf SHA-256 `9049091963146e23f13feede0d1dcfdae76e353b343bb37f0d8690527a722038`, root DER `3ba7b6cc4e95469d4d334b49cb257ad8537076fa84b0ca87ff4ecfe6a54680c1`, intermediate DER `15d795348226b4649f750f5802592c393bee7cc53c3b86982175b7ad087efe47`. Rekor pin base64 key ID `wNI9atQGlz+VWfO6LRygH4QUfY/8W4RFwiT5i5WRgB0=` va SPKI SHA-256 `c0d23d6ad406973f9559f3ba2d1ca01f84147d8ffc5b8445c224f98b9591801d`; DSSE PAE/signature, SET, inclusion proof, checkpoint, integrated time va canonical-body/envelope/payload/subject/build binding deu fail closed.
- Commit `M` chua exact `87` input paths: `75` source-snapshot blobs; `.gitattributes` voi vendor-wide `-text` + tgz `binary`; `vite.config.ts` va `eslint.config.js` voi exclusion chinh xac cho immutable `upstream/package/**` + binary/generated vendor artifacts nhung khong an owned `vendor/zalouser-bridge/test/**`; `UPSTREAM.json`; `SHA512SUMS`; bon raw metadata/npm-key/attestation/Sigstore-trust blobs; hai root compliance blobs; va `licenses/manifest.json`. Moi GET unauthenticated dung `Accept: application/json`, `Accept-Encoding: identity`, status 200, JSON content type, zero redirect, stream cap+1 abort: metadata `https://registry.npmjs.org/@openclaw%2Fzalouser/2026.7.1` 64 KiB; keys `https://registry.npmjs.org/-/npm/v1/keys` 64 KiB; attestations `https://registry.npmjs.org/-/npm/v1/attestations/@openclaw%2fzalouser@2026.7.1` 256 KiB; trust root `https://tuf-repo-cdn.sigstore.dev/targets/6494e21ea73fa7ee769f85f57d5a3e6a08725eae1e38c755fc3517c9e6bc0b66.trusted_root.json` 64 KiB, size `6787`, SHA-256 `6494e21ea73fa7ee769f85f57d5a3e6a08725eae1e38c755fc3517c9e6bc0b66`. Qualifying raw hashes doc tu committed Git blobs, khong doc checkout hay reserialized JSON.
- M aggregate khong self-reference. `UPSTREAM.json.mInputAggregate` co exact schema/domain/pathCount/hash; preimage la `UTF8("ihome-openclaw-m-inputs-v1\\0") || UTF8("count\\0" + decimal(87) + "\\0") || sortedRecords`, sort raw UTF-8 path. 86 path khac dung `record("blob", path, mode, rawSize, gitBlobOid, rawSha256)`, trong do `gitBlobOid` bat buoc la Git SHA-1 blob object ID cua repository, exact 40 lowercase hex; generic hoac SHA-256 object-format value la invalid. Record cua `UPSTREAM.json` dung strict UTF-8 JSON projection: reject duplicate keys/non-finite numbers, set duy nhat `mInputAggregate.sha256=null`, RFC 8785 JCS serialize, roi `record("projection", upstreamPath, mode, projectionSize, "-", projectionSha256)`. `record(kind,path,mode,size,objectId,sha256) = UTF8(kind + "\\0" + path + "\\0" + mode + "\\0" + decimal(size) + "\\0" + objectId + "\\0" + lowercaseHexSha256 + "\\0")`. `UPSTREAM.json` khong duoc tu khai final Git SHA-1 blob OID/raw SHA cua chinh no; reviewer verify final blob rieng va van prove 87 paths. Golden projection `{"mInputAggregate":{"domain":"ihome-openclaw-m-inputs-v1","pathCount":2,"schema":1,"sha256":null}}` co size `98`, SHA-256 `5596aa901117139fdb6a574ceaa1b973f9af5d5e6d60422ca4fdec2fcf9120d3`; voi empty `.gitattributes` Git SHA-1 blob OID `e69de29bb2d1d6434b8b29ae775ad8c2e48c5391`, aggregate root la `1d37c61eb87d4e9caf320f9ab07aed1e0d4cfc11e7496493db46fe1d4f6a97fb`.
- Checkpoint bat buoc `M -> R -> E`: `R` freeze/review exact source tree; bootstrap exporter tu exact `R` blob, verify blob type/object ID/size, roi dung `git ls-tree -rz --full-tree` + `git cat-file --batch` de preserve `100644`/`100755`, reject moi type/mode khac, ghi deterministic type/mode/size/Git-object/content-hash manifest va re-hash toan bo export truoc moi install/verifier/build. Working-tree read, checkout, JSON reserialization va `git archive` deu khong qualifying; archive chi duoc xuat hien trong negative/diagnostic rejection fixture. Candidate evidence va OCI archive nam absolute duoi source `.release/`, khong reparse; detached child path canonical va contained trong canonical non-reparse temp root. Exact verifier trong child phai validate copied evidence, closed schema, exact reviewed tree va retained absolute archive truoc stage/commit. Chi commit mot `build-evidence.json`, prove `E^==R`; OCI archive van external. Cleanup dung checked `git worktree remove --force`; cleanup-only error phai fail, cleanup error dong thoi khong duoc mask primary error. Chi fast-forward sau khi directory va worktree registration deu mat. Schema-v1 evidence embed exact canonical M/R review report bytes/base64 + size/SHA-256, reviewed SHA, reviewer role/identity/run ID, `APPROVED`, findings rong; E reviewer byte-compare va revalidate. Khong commit source cung tracked evidence. Task 27 lap lai `R27 -> qualifying exact-R27 build -> evidence-only E27`. Final rollout lap lai `R29 -> qualifying -ReviewedTree R29 -> evidence-only direct child E29 -> independent E29 approval`; bundle/Edge/Worker/VPS chi consume approved E29, trong khi image evidence van bind R29 va `E29^==R29`.
- Upstream root `LICENSE` co SHA-256 `73571b25326281d369087f469842c02444fe39faaecebda4d82ed21ff3a1c29d`; root `THIRD_PARTY_NOTICES.md` co SHA-256 `c84200f7a9bb8b3abc8563520433316716a9eb83915cfe7c3063d5e6fce5e7ca`. Hai file nay lay tu exact git head; notice duoc copy verbatim thanh `upstream/THIRD_PARTY_NOTICES.openclaw.md`, con root license duoc giu exact bytes trong `upstream/LICENSE.openclaw` va internal `LICENSE`.
- Published tarball tach thanh dung `25` package-owned regular files ngoai `package/node_modules/**` va `3144` bundled regular files trong dung `38` package roots. Package-owned set khong co TypeScript, test, source map, license hay notice. Fork giu exact `38` package name/version/SPDX inventory va tat ca `39` bundled dependency license carriers; `pako@2.2.0` giu ca `LICENSE` va `lib/zlib/README`, con `spark-md5` chon SPDX `WTFPL` tu declared expression `WTFPL OR MIT`, khong fetch `LICENSE2` vang mat. Full 39-record carrier table (source path/size/SHA-256/output path) la normative committed input cua `licenses/manifest.json`, khong duoc rediscover.
- `licenses/manifest.json` la committed reviewed input doc lap, khong duoc sinh tu internal notice/tgz. No khoa exact 38 package name/version/SPDX selections va exact 39 source carrier paths/sizes/SHA-256/output paths; `UPSTREAM.json` va `FORK.json` deu bind exact manifest SHA-256 va counts. Internal notice/carrier tree duoc generate/verify tu manifest nay, va independent document/artifact review phai approve manifest + rendered outputs truoc khi pack evidence duoc chap nhan.
- Vendor source nam tai `services/openclaw-zalo-cell/vendor/zalouser-bridge/`. Repo commit exact `75` blobs duoi `extensions/zalouser`, ap dung patch/overlay va tao mot internal tgz. `FORK.json.artifactMembers` khoa exact archive tree; `runtimeReachabilityAllowlist` bang static derived closure; `installedTree` khoa exact installed tree. Mandatory runtime trace nonempty va subset allowlist, optional classified member co the untraced. Evidence ghi exact bon raw M Git-blob inputs, trust proofs, source/license/artifact/runtime/install locks, patch/tgz hashes va image digest; no khong duoc dua vao cung source commit.
- Docker chi duoc cai internal tgz da verify; build/runtime khong duoc tai hoac cai registry ZaloUser, khong duoc de upstream va fork cung ton tai, va installed package list phai co duy nhat plugin `zalouser` da khoa digest.
- Build/gate entrypoints chay dependency-free Node assertion `>=24.15.0 <25` truoc first Node/npm/npx/vendor/helper action; accept `24.15.0` va later `24.x`, reject `22.20.x`, `24.14.x`, `25.x` truoc moi work/artifact/evidence. CI pin exact Node `24.15.0`, preflight truoc `npm ci`; planned `test:openclaw:services` prefix cung assertion; `build-reproducible-image.ps1` self-preflight truoc temp/builders/output. Node `22.20` khong supported cho gate. Rieng session-crypto package/lock van giu reviewed `engines.node >=22.13.0` nhu runtime/library minimum, khong doi theo build gate. Vendor script la `vendor:prepare`, khong co lifecycle `prepare`. Task 2 dat exclusion chinh xac cua immutable `upstream/package/**` va binary/generated artifact paths vao chinh `M`, de root Vitest/ESLint khong traverse 22 upstream test files nhung van chay owned tests.
- Session-crypto duoc clean build/test hai lan truoc `R` bang `tsconfig.build.json` chi chon `src/crypto.ts` + `src/daemon.ts`, khong declaration/source map; output byte-identical va committed bang `git add -f` chi gom `dist/package.json`, `dist/crypto.js`, `dist/daemon.js`. `dist/package.json` exact bytes `{"type":"module"}\n`; stale/extra output fail. Dockerfile exact hai stage `install`/`runtime`, khong chay session `npm ci`/build. `.dockerignore` chi unignore ba dist inputs. Install `RUN --network=none` assert Node dau tien, tao mot cache moi va prove empty truoc local-tgz offline install, khong reuse/fallback. Runtime chi co installed fork + ba dist files + config, khong d.ts/test/source/lock/tsconfig/node_modules/compiler/cache. Base-image `--pull` la acquisition rieng, khong duoc mo ta nhu air-gapped.
- Deterministic image gate dung exact `-ReviewedTree` Git blobs da export/verify boi reviewed `export-reviewed-tree.mjs`, context-root v2 record algorithm/golden root `925be74a4fe381076871348887a653659ada468fa21333d5d22585be9e381f4e`, va absolute `-BuildxPath`. `image-lock`, context va evidence bind exact ba session dist Git blobs; final-rootfs evidence bind installed hashes va reject extra session paths. Buildx exact `0.13.1` binary SHA-256 Windows `6b113e84cbc3cd645646aa82f00a7f7d3737cc10375b4341e0aca0de0c997c75`/Linux `3e2bc8ed25a9125d6aeec07df4e0211edea6288e075b524160ef3fd305d3d74c`; BuildKit exact pin hien co. Hai builder phai tao byte-identical OCI archive va extracted layout/index/blob set. `build-evidence.schema.v1.json` closed moi object; PowerShell 7.3 wrapper self-contained va fail-fast. Final production build dung exact R29, E29 chi commit evidence cua build do, va final deploy identity la approved E29 direct child cua R29.
- Route moi la chinh xac `/openclaw-zalo` va co giao dien van hanh rieng.
- Khong sua, import, tai su dung, dual-write hay phu thuoc vao `worker/**`, cac bang/ham/view `zalo_*`, route `/chat-zalo`, `src/hooks/useZaloChat.ts` hoac `src/components/chat-zalo/**`.
- Tai khoan ket noi phai la **mot tai khoan Zalo moi**, khong phai tai khoan dang ket noi voi worker cu.
- Moi organization co toi da mot tai khoan Zalo Personal active va mot OpenClaw cell active. Cong ty hien tai chay nhu mot tenant binh thuong; khi co cong ty moi, quan tri vien cua organization do tu quet QR tai khoan Zalo cua ho.
- QR dang nhap duoc thuc hien ngay trong CRM. Nguoi dung khong can SSH, VPS, Docker hay CLI.
- He thong la production, khong phai demo. Organization DEMO chi duoc dung cho fixture va test tu dong; cong ty that chi duoc ghi trong smoke test cuoi co kiem soat.
- Chuc nang production gom: tra loi khi khach nhan nhan truoc; gui theo lich/gui chu dong co consent va gioi han; tim/ket ban/lien he dau tien o trang thai mac dinh tat; gui theo lich hoac su kien CRM vao nhom sale noi bo duoc allowlist.
- Khong tu dong tra loi moi tin nhan trong nhom. Tin nhan nhom co the duoc hien thi de theo doi, nhung automation chi duoc gui vao nhom da phep boi lich hoac su kien CRM da cau hinh.
- Supabase la nguon su that duy nhat cho du lieu nghiep vu `openclaw_*`. Khong chay PostgreSQL tren VPS OpenClaw.
- Dung chinh VPS Vultr Seoul hien co cua 9Router; khong tao/mua VPS moi va khong doi IP/region sau khi session Zalo da on dinh.
- 9Router va `cli-proxy-api` khong bi sua, restart, recreate, mount chung volume, dung chung secret hay dua vao Docker network noi bo cua OpenClaw. Cac stack chi chia se host OS/Vultr.
- OpenClaw khong phu thuoc 9Router/`cli-proxy-api` de chay AI. Model provider duoc cau hinh doc lap bang OpenAI-compatible runtime secret; ngung/go 9Router sau nay khong lam OpenClaw mat kenh neu provider doc lap con healthy.
- Media ben vung dat trong mot bucket Cloudflare R2 private rieng. Khong tai su dung bucket/Worker `ihome-files` hoac sale-image hien co.
- Host da duoc kiem tra read-only ngay 2026-07-26: 16 vCPU, khoang 64 GB RAM, khoang 1.2 TB disk; tai hien tai rat thap. Stack OpenClaw dau tien bi hard-cap tong cong 4 vCPU, 8 GB RAM va 20 GB local disk de khong lan tai nguyen sang dich vu cu.
- Mot cell dau tien chay production. Moi cell them vao van can soak/capacity review va cach ly rieng; quyet dinh mo rong dua tren metric, khong dua tren cam giac host dang du.
- Nguoi dung phai thay canh bao ro rang rang ket noi Zalo Personal la khong chinh thuc va co nguy co bi Zalo gioi han, day session hoac khoa tai khoan.

### 1.1 Bang license carrier normative

Day la exact `39`-row input cua committed `licenses/manifest.json`, duoc doi chieu voi pinned tarball read-only. Moi SHA-256 la lowercase, moi output path dung chinh xac `licenses/<package>@<version>/<relative-path>`, va implementation khong duoc rediscover, regenerate, hay chon carrier khac.

```text
asynckit@0.4.0 | MIT | package/node_modules/asynckit/LICENSE | 1078 | 1953150d5d4b10c7542cee6f6e0c613b2682545233f069d75cfff1936386ce10 | licenses/asynckit@0.4.0/LICENSE
bignumber.js@9.3.1 | MIT | package/node_modules/bignumber.js/LICENCE.md | 1147 | def75ba75d6426f1c3f02addf8e175fbe6e0d8a82e541cbdffc16d2bd8fd7d6a | licenses/bignumber.js@9.3.1/LICENCE.md
call-bind-apply-helpers@1.0.2 | MIT | package/node_modules/call-bind-apply-helpers/LICENSE | 1071 | 5e325595b4ea8cfec3802f545b1def5d7b73e4a5b8e9ba63e32a320f67732292 | licenses/call-bind-apply-helpers@1.0.2/LICENSE
combined-stream@1.0.8 | MIT | package/node_modules/combined-stream/License | 1085 | 47eb8ca82c798246774946d1be0f9aa08f025fa8325ced0947aeeb4c05fe5547 | licenses/combined-stream@1.0.8/License
crypto-js@4.2.0 | MIT | package/node_modules/crypto-js/LICENSE | 1169 | f729d14b7e1bf8adca0dcc38b93b929d14d53fcd5db56c3d1c9b2daa7aa69396 | licenses/crypto-js@4.2.0/LICENSE
delayed-stream@1.0.0 | MIT | package/node_modules/delayed-stream/License | 1085 | 47eb8ca82c798246774946d1be0f9aa08f025fa8325ced0947aeeb4c05fe5547 | licenses/delayed-stream@1.0.0/License
dunder-proto@1.0.1 | MIT | package/node_modules/dunder-proto/LICENSE | 1073 | 2b770a704c15de238c3f622b01b0044ddd60b49ee30608ea6991ebf19db7a7a1 | licenses/dunder-proto@1.0.1/LICENSE
es-define-property@1.0.1 | MIT | package/node_modules/es-define-property/LICENSE | 1071 | 5e325595b4ea8cfec3802f545b1def5d7b73e4a5b8e9ba63e32a320f67732292 | licenses/es-define-property@1.0.1/LICENSE
es-errors@1.3.0 | MIT | package/node_modules/es-errors/LICENSE | 1071 | 5e325595b4ea8cfec3802f545b1def5d7b73e4a5b8e9ba63e32a320f67732292 | licenses/es-errors@1.3.0/LICENSE
es-object-atoms@1.1.2 | MIT | package/node_modules/es-object-atoms/LICENSE | 1071 | 5e325595b4ea8cfec3802f545b1def5d7b73e4a5b8e9ba63e32a320f67732292 | licenses/es-object-atoms@1.1.2/LICENSE
es-set-tostringtag@2.1.0 | MIT | package/node_modules/es-set-tostringtag/LICENSE | 1073 | 1a3aeb1f1398bd697d57c3c585faadf59d825aca6e3162cd7eeb72ff76eb2466 | licenses/es-set-tostringtag@2.1.0/LICENSE
form-data@2.5.6 | MIT | package/node_modules/form-data/License | 1118 | e5b780d4f38d1d3328e3e53186c4e62d3fa149ea6f2bacd5de5ad0c30ac85343 | licenses/form-data@2.5.6/License
function-bind@1.1.2 | MIT | package/node_modules/function-bind/LICENSE | 1052 | 773e131a7684726005a7e4688a80b4620033bc08499bc1404dd1a1eb3bca725e | licenses/function-bind@1.1.2/LICENSE
get-intrinsic@1.3.0 | MIT | package/node_modules/get-intrinsic/LICENSE | 1071 | 39c5ec504cf6bd5cd782a7c695828e09189df79f5d94840e4f08feb97b9fd416 | licenses/get-intrinsic@1.3.0/LICENSE
get-proto@1.0.1 | MIT | package/node_modules/get-proto/LICENSE | 1071 | be46ce1e3b0479af9ce82d22b465a6d7d2ff084fca0aaf3d54172da2b5eb5781 | licenses/get-proto@1.0.1/LICENSE
gopd@1.2.0 | MIT | package/node_modules/gopd/LICENSE | 1071 | d90bf0a089da4cf43d644ed240a0b3825dcdb705e64e38371d56995a4cc9e4c5 | licenses/gopd@1.2.0/LICENSE
hasown@2.0.4 | MIT | package/node_modules/hasown/LICENSE | 1083 | bf9b0d665be2a689851eea667ca9f42066ea1d903b38349c51e6a44b2577680a | licenses/hasown@2.0.4/LICENSE
has-symbols@1.1.0 | MIT | package/node_modules/has-symbols/LICENSE | 1071 | 206c1adcf206dc0031b11232f5b054ec5f1662407ab1ca415247921cab2068ab | licenses/has-symbols@1.1.0/LICENSE
has-tostringtag@1.0.2 | MIT | package/node_modules/has-tostringtag/LICENSE | 1067 | e2560e002e13281578c75c850061d9255c33d16d732939e8c2db64c2506642fa | licenses/has-tostringtag@1.0.2/LICENSE
json-bigint@1.0.0 | MIT | package/node_modules/json-bigint/LICENSE | 1081 | def82c085d05e795fe6a9cb5b70c48e022212355afc0e91d4de047cade28df06 | licenses/json-bigint@1.0.0/LICENSE
math-intrinsics@1.1.0 | MIT | package/node_modules/math-intrinsics/LICENSE | 1073 | 2b770a704c15de238c3f622b01b0044ddd60b49ee30608ea6991ebf19db7a7a1 | licenses/math-intrinsics@1.1.0/LICENSE
mime-db@1.52.0 | MIT | package/node_modules/mime-db/LICENSE | 1172 | cc1dfd4dafa27271e8212cd3b274eeb3f262e40a6fdab36ddc3f9696f706f58b | licenses/mime-db@1.52.0/LICENSE
mime-types@2.1.35 | MIT | package/node_modules/mime-types/LICENSE | 1167 | 71f83c4c0621102a56d9853812777b85751bce7e9726f686f5b056c1f8a4b0e6 | licenses/mime-types@2.1.35/LICENSE
pako@2.2.0 | MIT AND Zlib | package/node_modules/pako/LICENSE | 1104 | a04665b3b2de56c66730c1f720f528175739e4104f79073614aa611da1e85539 | licenses/pako@2.2.0/LICENSE
pako@2.2.0 | MIT AND Zlib | package/node_modules/pako/lib/zlib/README | 2180 | 20356aece8f36fda34645e97af3b163da0a88e253b78ffba298590d5b9121ebb | licenses/pako@2.2.0/lib/zlib/README
psl@1.15.0 | MIT | package/node_modules/psl/LICENSE | 1101 | ae8c4a3b09681bc30ecbc984d58c4dc2c21b56d320fc02f558d12e86995c26c8 | licenses/psl@1.15.0/LICENSE
punycode@2.3.1 | MIT | package/node_modules/punycode/LICENSE-MIT.txt | 1077 | 483acb265f182907d1caf6cff9c16c96f31325ed23792832cc5d8b12d5f88c8a | licenses/punycode@2.3.1/LICENSE-MIT.txt
querystringify@2.2.0 | MIT | package/node_modules/querystringify/LICENSE | 1115 | 3b2a6a268aa815dec121d614245e03b5c68db1f044d5b525e36db7d5dc7fb9c3 | licenses/querystringify@2.2.0/LICENSE
requires-port@1.0.0 | MIT | package/node_modules/requires-port/LICENSE | 1115 | 3b2a6a268aa815dec121d614245e03b5c68db1f044d5b525e36db7d5dc7fb9c3 | licenses/requires-port@1.0.0/LICENSE
safe-buffer@5.2.1 | MIT | package/node_modules/safe-buffer/LICENSE | 1081 | c7cc929b57080f4b9d0c6cf57669f0463fc5b39906344dfc8d3bc43426b30eac | licenses/safe-buffer@5.2.1/LICENSE
semver@7.8.5 | ISC | package/node_modules/semver/LICENSE | 765 | 4ec3d4c66cd87f5c8d8ad911b10f99bf27cb00cdfcff82621956e379186b016b | licenses/semver@7.8.5/LICENSE
spark-md5@3.0.2 | WTFPL | package/node_modules/spark-md5/LICENSE | 486 | 9c4214d48030b7e877ed2fd76044ea079a987c9b3f01f9b6964ba4a475a5a13d | licenses/spark-md5@3.0.2/LICENSE
tough-cookie@4.1.3 | BSD-3-Clause | package/node_modules/tough-cookie/LICENSE | 1485 | 22ec6791c91ba42c0516a05f4cbdde019aae4687f8a38c5ca7e8a69ee68f851d | licenses/tough-cookie@4.1.3/LICENSE
typebox@1.3.3 | MIT | package/node_modules/typebox/license | 1094 | e8a7cc256941a26ba8234f04390165243a4d42f74fd6491934140605bf7eae2d | licenses/typebox@1.3.3/license
universalify@0.2.0 | MIT | package/node_modules/universalify/LICENSE | 1100 | 3fda5977c0904e226190b4e21d64340c1731e2142d6fe5f3dee0090a216b8b63 | licenses/universalify@0.2.0/LICENSE
url-parse@1.5.10 | MIT | package/node_modules/url-parse/LICENSE | 1115 | 3b2a6a268aa815dec121d614245e03b5c68db1f044d5b525e36db7d5dc7fb9c3 | licenses/url-parse@1.5.10/LICENSE
ws@8.21.0 | MIT | package/node_modules/ws/LICENSE | 1183 | 2b29dcfe0d6471f7e8c92c5fb38c9f93edee10330937055440192f1832b1ecef | licenses/ws@8.21.0/LICENSE
zca-js@2.1.2 | MIT | package/node_modules/zca-js/LICENSE | 1124 | 517f4df002c16fc050acc6391dfe31670f4927e58fd281eeea2101f581da75a9 | licenses/zca-js@2.1.2/LICENSE
zod@4.4.3 | MIT | package/node_modules/zod/LICENSE | 1072 | 3f1189b28e3866e0d979968d466b78f813f76827cfdca1fbb124cc0a5c8841f8 | licenses/zod@4.4.3/LICENSE
```

## 2. Pham vi va ngoai pham vi

### 2.1 Trong pham vi ban dau

1. Ket noi/ngat/ket noi lai tai khoan Zalo moi bang QR trong CRM.
2. Hop thu den theo conversation, tin nhan van ban va media, danh dau chua doc, tim kiem va phan cong nguoi xu ly.
3. AI phan loai y dinh va tao ban nhap tra loi theo tri thuc da phe duyet.
4. Che do human handoff/takeover, draft-only va auto-reply duoc quan ly rieng.
5. Automation tra loi inbound khi khach hang nhan truoc.
6. Gui chu dong cho nguoi nhan co consent theo lich va gio yen lang.
7. Workflow tim/ket ban/lien he dau tien co UI, nhung mac dinh bi khoa boi feature flag va policy gate.
8. Quan ly nhom sale: dong bo danh sach nhom tu tai khoan, allowlist nhom, gui theo lich va gui tu su kien CRM da cho phep.
9. Tri thuc noi bo theo organization, co draft/published va lich su phien ban.
10. Outbox, delivery attempt, audit, canh bao, dead letter, UNKNOWN va nut dung khan cap.
11. Trang Operations de theo doi cell, session, queue, media, egress va loi.
12. Desktop va mobile production, phan quyen day du, empty/loading/error/offline states.

### 2.2 Mac dinh tat cho den khi hoan thanh huong dan

- Auto-reply tu AI.
- Gui chu dong.
- Gui vao nhom sale.
- Tim/ket ban/lien he dau tien.
- Moi automation moi tao.

Khi nguoi dung vao tung tinh nang, wizard phai giai thich rui ro va huong dan cau hinh gio hoat dong, doi tuong, tan suat, consent, nhom dich, nguoi co quyen dung, mau tin va cach xu ly loi. Automation chi co the bat sau khi tat ca buoc bat buoc hop le va nguoi co quyen xac nhan.

### 2.3 Ngoai pham vi

- Khong mo browser terminal, shell, filesystem, SQL editor, arbitrary HTTP tool hoac arbitrary OpenClaw tool cho AI.
- Khong broadcast khong consent, quet hang loat Zalo ID, spam ket ban hoac tim nguoi dung khong co nguon hop le.
- Khong auto-reply theo moi chatter cua nhom sale.
- Khong cho phep nhap raw Zalo command, raw Gateway request hay script tu giao dien.
- Khong dong bo du lieu voi Zalo cu, khong migrate lich su `zalo_*`, khong fallback sang worker cu.
- Khong host database chinh, object storage ben vung hay dashboard quan tri cong khai tren VPS.
- Khong cam ket rang tai khoan Zalo se khong bi gioi han/khoa va khong tu dong vuot captcha, xac minh hoac co che phong chong abuse cua Zalo.
- Khong provisioning tai nguyen co tinh phi truoc khi design spec va implementation plan da qua cong duyet bat buoc.

## 3. Kien truc tong the

```text
React/Vercel: /openclaw-zalo
  | Supabase session; RLS read; guarded RPC/Edge mutation
  v
Supabase control plane - canonical openclaw_* data
  - Auth, organization membership, permissions, RLS
  - accounts, QR commands, policies, consent, groups
  - conversations, messages, knowledge, schedules
  - outbox, delivery attempts, runtime leases, audit
  - narrow runtime API; short-lived object tickets
  |                                  \
  | per-cell workload credential      \ object-scoped ticket
  v                                    v
Existing Vultr Seoul           Dedicated media gateway
  - shared host, isolated stack  - Cloudflare Worker/R2 binding
  - one isolated cell/org        - private R2 bucket
  - OpenClaw + vendored zalouser  - no public bucket/domain
  - fork-owned listener/send RPC
  - policy-aware bridge           - exact-key authorization
  - encrypted session volume
  - bounded SQLite/event spool
  - outbound-only/private Gateway
  - no 9Router network/volume/secret
```

### 3.1 Trust boundaries

- Browser chi duoc doc du lieu ma RLS cho phep va goi RPC/Edge API co schema xac dinh. Browser khong nhan Gateway token, workload token, model API key, R2 credential hay session Zalo.
- Supabase Edge control plane giu quyen server can thiet va chi mo cac operation nghiep vu hep. Khong dua `service_role` hoac generic database credential vao OpenClaw cell.
- Moi cell su dung mot workload credential rieng, anh xa co dinh toi `organization_id`, `account_id`, `cell_id` va tap operation duoc phep. Credential co the rotate/revoke ma khong anh huong tenant khac.
- Workload credential chi dung de doi short-lived token toi Edge (TTL toi da 5 phut). Moi request runtime co audience, operation, timestamp, nonce, body hash, `organization_id/account_id/cell_id`, runtime fencing token va signature; Edge reject clock skew >60 giay, nonce da dung, replay, sai audience/operation hay stale lease.
- Gateway cua OpenClaw khong mo port public. Bridge va cell giao tiep tren Docker network noi bo; giao tiep ra ngoai la outbound HTTPS.
- Fork so huu hai seam local hep: inbound listener awaited va private RPC `zalouser.bridge.send`. Stock generic `send` RPC, message tool, pairing notification, direct adapter/tool/business-send path bi deny neu khong co authorized fork context; khong seam nao duoc fail open thanh provider business frame.
- Bridge mang complete canonical payload, `OutboundAuthorizationMarker` va private claim token toi fork. Fork chi goi `/authorize-send` sau khi da dong bang exact ordered provider batch va ngay truoc provider I/O dau tien; authorization failure khong duoc phat frame.
- Media gateway giu R2 binding. Cell va browser chi nhan ticket ngan han, gan voi exact object key, operation, content length/type va organization.
- Model AI chi nhan context da loc va tra ve structured draft/classification. Model khong co quyen giao tin truc tiep toi channel.

### 3.2 Cach ly tenant va cell

- Moi bang moi co `organization_id NOT NULL`.
- Moi parent co `UNIQUE (organization_id, id)`; child reference bang composite foreign key co `organization_id`.
- Moi query, lease, idempotency key, object key, log va metric deu co tenant/account scope.
- Moi organization co container, Docker network, encrypted volume, workload secret, session, spool va cell lease rieng.
- Khong mount Docker socket vao cell; khong mount source repo; filesystem root read-only neu OpenClaw runtime cho phep; chi session/spool/temp media la writable.
- Runtime lease co fencing token tang dan. Cell cu khong the gui sau khi cell moi da nhan lease.

## 4. Thanh phan va ranh gioi module

### 4.1 CRM operations cockpit

Route `/openclaw-zalo` co sau khu vuc:

1. **Tong quan** - tinh trang ket noi, volume tin nhan, queue lag, automation, consent, nhom sale va canh bao.
2. **Hop thu** - conversation list, thread, draft AI, send, takeover, assignment, media va recipient status.
3. **Tu dong hoa** - inbound reply, proactive sequence, friend/first-contact gates, policy wizard, test preview va versioning.
4. **Tri thuc** - nguon noi dung, ban nhap/published, preview retrieval, phien ban va audit.
5. **Lich & Nhom sale** - lich gui, calendar, danh sach nhom duoc dong bo, allowlist, CRM event trigger va template.
6. **Van hanh** - account/session/cell, queue, UNKNOWN/dead-letter, media, retention, health, logs da redact va emergency controls.

Thanh command bar ton tai tren desktop va mobile, luon hien:

- Organization/tai khoan hien tai.
- Connection health va lan heartbeat cuoi.
- Configured mode va effective mode.
- Trang thai outbound pause.
- Nut `DUNG TOAN BO GUI` co xac nhan, ly do va audit.

Desktop dung `MainLayout fullBleed`. Mobile dung shell full-screen rieng qua `usePhoneViewport()`; khong nen desktop co lai va khong bat scroll ngang trang.

### 4.2 Supabase control plane

Control plane co bon vai tro rieng:

- **Canonical storage:** luu toan bo text, metadata, policy, queue, audit va reference media.
- **Authorization:** Auth, organization membership, permission, RLS va operation-specific RPC/Edge API.
- **Coordination:** command, lease, fencing, idempotency, control version va Realtime invalidation.
- **Policy enforcement:** consent, quiet hours, suppressions, campaign status, takeover, mode, rate/cap va kill switches.

### 4.3 OpenClaw cell

Moi cell chi lam bon viec:

1. Duy tri session Zalo Personal cua mot account.
2. Provider callback la void/non-awaited; fork-owned internal listener chuyen full raw + normalized inbound envelope/media manifest toi bridge va doi durable SQLite acknowledgement truoc khi danh dau internal listener success hoac cho phep OpenClaw dispatch/queue.
3. Nhan business-send duy nhat qua private RPC `zalouser.bridge.send`; fork dong bang exact ordered text/media/chunk batch, authorize ngay truoc provider I/O va bao cao provider handoff evidence.
4. Chay AI draft/classification trong sandbox khong co quyen send truc tiep.

Built-in ZaloUser/OpenClaw reply, pairing notification co noi dung, stock generic `send` RPC, message tool va direct business adapters/tools deu tat. Cell khong tu quyet dinh consent, quiet hours, campaign enable, takeover, group allowlist hay retry UNKNOWN. Provider typing, seen va delivery receipt duoc phan loai ro la control traffic, khong phai business content send, va khong duoc tai su dung de mang text/media.

### 4.4 Policy-aware bridge

Bridge la boundary bat buoc giua OpenClaw va Supabase/channel adapter:

- Xac thuc workload credential va runtime lease.
- Nhan full raw + normalized inbound envelope va media manifest tu fork listener; commit SQLite WAL + `synchronous=FULL` truoc internal listener success. Day khong phai provider-level acknowledgement.
- Normalize/dedupe inbound theo stable provider ID chinh xac; neu provider ID thieu thi dung heuristic fingerprint voi at-least-once semantics va collision telemetry, khong im lang gop collision.
- Claim outbox theo lease ngan, kiem tra lai policy ngay truoc dispatch.
- Goi duy nhat `zalouser.bridge.send` voi complete canonical payload + marker; khong goi stock generic `send` RPC cho business traffic.
- Ghi delivery attempt va audit.
- Phan loai loi thanh retryable, terminal hoac ambiguous.
- Tam dung outbound neu session/cell/queue/policy khong an toan.
- Khong co generic SQL, generic HTTP proxy hoac admin endpoint.

### 4.5 Private media gateway

- Bucket rieng, private, khong public custom domain va khong public listing.
- Upload ticket rang buoc `organization_id`, exact key, max size, MIME allowlist, checksum va TTL.
- Download/stream ticket rang buoc user/session, exact key, disposition va TTL.
- Gateway xac minh magic bytes, size va checksum; khong tin file extension/Content-Type tu client.
- Anh inbound toi da 5 MB co the auto-cache. Video/file lon chi luu khi policy cho phep hoac user chon giu.
- Temp media tren VPS bi xoa sau khi upload/processing; khong xem VPS disk la backup.

## 5. Mo hinh du lieu `openclaw_*`

### 5.1 Danh muc logic

| Nhom | Bang chinh | Muc dich |
|---|---|---|
| Account/runtime | `openclaw_accounts`, `openclaw_account_connections`, `openclaw_runtime_cells`, `openclaw_runtime_leases`, `openclaw_qr_challenges` | Account, QR, session generation, health va fencing |
| Inbox | `openclaw_contacts`, `openclaw_sales_groups`, `openclaw_targets`, `openclaw_conversations`, `openclaw_conversation_members`, `openclaw_messages`, `openclaw_message_media`, `openclaw_inbound_events`, `openclaw_inbound_provider_identities` | Peer/group targets, text/metadata, stable-ID mapping va dedupe inbound |
| Safety | `openclaw_consents`, `openclaw_suppressions`, `openclaw_policies`, `openclaw_policy_versions`, `openclaw_control_states`, `openclaw_takeovers` | Consent, quiet hours, limit, stop, effective mode va handoff |
| Automation | `openclaw_automations`, `openclaw_automation_versions`, `openclaw_campaigns`, `openclaw_campaign_runs`, `openclaw_schedules`, `openclaw_crm_event_subscriptions` | Rules, versions, campaigns, schedule va event triggers |
| Sales groups | `openclaw_sales_group_allowlists` | Exact group allowlist va freshness policy; target group dung FK toi `openclaw_targets` |
| Knowledge | `openclaw_knowledge_sources`, `openclaw_knowledge_versions`, `openclaw_knowledge_chunks` | Nguon tri thuc va retrieval theo tenant |
| Delivery | `openclaw_outbox`, `openclaw_delivery_attempts`, `openclaw_dead_letters` | Send state machine, retry va operator resolution |
| Operations | `openclaw_audit_events`, `openclaw_health_events`, `openclaw_retention_holds` | Audit, incident va legal hold |

Danh muc tren la contract logic bat buoc. Implementation plan co the tach mot bang thanh bang con chi khi ghi ro mapping va invariant tuong duong truoc migration; moi bang van phai giu prefix `openclaw_`, tenant key va khong co quan he voi `zalo_*`.

### 5.2 Invariant bat buoc

- `organization_id` khong lay tu body do browser/workload tu khai; server suy ra tu membership hoac workload identity.
- Account chi co mot connection generation effective tai mot thoi diem.
- QR challenge mot lan, TTL chinh xac 120 giay tu `issued_at`. Payload duoc ma hoa o application layer trong row server-only, khong nam trong RLS read/Realtime; Edge endpoint giai ma va tra mot lan qua HTTPS. Browser chi giu trong memory. Payload bi xoa khi used/expired.
- Inbound event co idempotency key theo account va provider event identity/fingerprint. Duplicate khong tao message/automation lan hai.
- Message giu ca `source_timestamp` va `received_at`; UI sap xep hop ly nhung audit khong mat thu tu den.
- Conversation, recipient, group, automation, schedule, outbox va attempt deu dung composite FK de ngan cross-tenant reference.
- Outbox co unique business idempotency key; mot CRM event/schedule occurrence chi tao toi da mot send intent cho mot target.
- Schedule luu timezone ro rang; cong ty hien tai mac dinh `Asia/Ho_Chi_Minh`, khong suy dien theo timezone cua browser.
- Policy version va content/template version duoc dong bang tren outbox item de audit dung quyet dinh luc enqueue.
- Truoc khi dispatch phai doc lai `session_generation`, `control_version`, `takeover_version`, effective mode, suppression va runtime fencing token.
- Media row chi chua object key/metadata/checksum, khong chua blob hoac base64.
- Audit append-only: moi organization co sequence va `previous_hash/event_hash`; browser/runtime khong co update/delete. Daily hash root duoc ky boi key ngoai database va anchor vao object R2 key bat bien/no-overwrite de phat hien sua/xoa evidence, gom ca UNKNOWN resolution va control changes.

### 5.3 Uniqueness, target va idempotency contract

- Partial unique index bao dam moi organization chi co mot `openclaw_accounts` active; moi account chi co mot runtime lease effective, mot connection generation effective va mot QR challenge `PENDING` chua het han. TTL dung DB clock, khong dung clock browser/cell.
- Stable provider identity co unique key `(organization_id, account_id, provider_contact_id)`, `(organization_id, account_id, provider_group_id)` va `(organization_id, account_id, provider_conversation_id)`; rename khong tao target moi.
- `openclaw_targets` co `kind IN ('PEER','SALES_GROUP')`, `account_id`, provider target ID va FK toi dung contact/group; CHECK XOR cam row vua peer vua group. Outbox chi reference target nay bang composite FK gom organization va account.
- `organization_id` va `account_id` cua row canonical la immutable. Root mutation nhan selected organization tu UI context, server xac minh active membership/quyen; child mutation suy ra tenant/account tu trusted parent lookup, khong tin ID/body rieng le.
- Typed CRM event mang `(organization_id, event_type, source_table, source_id, source_version, occurred_at)`; source lookup phai xac minh cung organization truoc khi tao occurrence.
- Canonical stable identity la `(organization_id, account_id, event_kind, stable_id_kind, stable_id_value)`, voi `stable_id_kind IN ('PROVIDER_EVENT_ID','PROVIDER_MESSAGE_ID')`. `provider_event_id` la primary identity khi co; neu no null va `provider_message_id` co tren message-bearing event thi message ID la primary. `provider_message_id` dong thoi la secondary uniqueness cho moi message-bearing event.
- Khi ca hai ID co mat, he thong atomically persist mapping hai chieu event-ID/message-ID toi cung mot inbound event, `event_kind` va canonical payload hash. Replay chi dedupe khi tat ca mapping + kind + payload hash trung khop. Reuse mot ID trong cung organization/account cho kind khac, pair khac hoac payload khac fail closed, quarantine va append collision audit; khong bao gio merge. Cung gia tri ID o account/organization khac la identity doc lap va khong duoc cross-dedupe.
- Fallback fingerprint chi duoc dung khi **ca `provider_event_id` va `provider_message_id` deu null**. Key scope `(organization_id, account_id, event_kind, fallback_fingerprint)`; fingerprint gom provider conversation/sender/source timestamp/type/content/media checksum va giu payload hash de phat hien same-fingerprint/different-payload collision.
- Manual send key scope `(organization_id, actor_id, client_operation_id)`; schedule/CRM key scope `(organization_id, campaign_or_schedule_id, occurrence_id, target_id)`. Same key/same hash tra lai ket qua cu; same key/khac hash reject va audit.
- Transaction ingest phai atomically insert inbound event/message, update conversation va tao automation work/outbox intent, hoac de lai durable recovery marker; khong co crash window tao message ma mat trigger hay trigger hai lan.
- Runtime ingest nhan batch toi da 100 events hoac 256 KiB/call; khong mot network round-trip moi event trong history/reconnect.
- Queue claim la atomic SQL transaction ngan dung `FOR UPDATE SKIP LOCKED`/`UPDATE ... RETURNING`, batch bounded; external Zalo/model/R2 call luon nam ngoai transaction va completion dung CAS moi.
- State/status dung CHECK/enum va transition RPC CAS; direct update trang thai bi revoke. Delete parent dung `RESTRICT` hoac soft-delete cho evidence-bearing row, khong cascade lam mat audit/delivery.

### 5.4 Cursor va Realtime contract

- Conversation cursor la `(last_message_received_at, id)`; message/history cursor canonical la `(received_at, id)`. `source_timestamp` chi dung display/grouping, khong lam cursor duy nhat.
- Index hot path bat dau bang `(organization_id, account_id, ...)`, sau do cursor/filter columns. Target/consent/suppression lookup co index phu hop pre-dispatch.
- Moi composite FK va moi column dung trong RLS/policy lookup phai co index; active/queued/non-deleted hot paths dung partial index. Column equality dat truoc range/cursor column trong composite index.
- Supabase Realtime publication la allowlist ro rang cho safe account-health, conversation va message tables/columns. QR challenge, session/runtime secret metadata, policy evidence nhay cam, delivery raw attempt, audit raw va retention hold khong nam trong publication.
- Khi doi organization/account, logout hoac membership/quyen bi revoke, frontend dong channel, huy query, xoa cache OpenClaw va refetch voi session moi. RLS van la enforcement cuoi; Realtime khong duoc xem la authorization.

### 5.5 RLS va quyen ghi

- Bat RLS tren tat ca bang `openclaw_*`.
- Dung `FORCE ROW LEVEL SECURITY` tren tenant tables tru cac truong hop migration/owner duoc ghi ro. `anon` khong co privilege; `authenticated` chi co `SELECT` tren safe read tables theo RLS va khong co direct INSERT/UPDATE/DELETE tren canonical/sensitive tables.
- Browser direct DML bi revoke tren account connection, QR, canonical inbound/message, policy version, consent evidence, suppressions, outbox, delivery attempt, runtime lease, audit va retention hold. Moi browser mutation di qua exact RPC/Edge endpoint.
- Mutation nhay cam chi qua versioned RPC/Edge API co Zod/SQL validation, membership recheck va audit.
- Runtime cell khong co database role; no chi goi Edge runtime API. `service_role` chi o Supabase Edge secret, endpoint van bat buoc derive workload/tenant, validate operation va khong tin bypass RLS.
- Moi `SECURITY DEFINER` function do non-login owner chuyen dung so huu, schema-qualify object, `SET search_path = pg_catalog, public`, `REVOKE ALL ... FROM PUBLIC` va `GRANT EXECUTE` chinh xac. Khong cap generic execute/maintenance role cho browser.
- SQL test bat buoc co it nhat hai organization va chung minh user/workload tenant A khong doc, ghi, reference, claim lease hoac download object tenant B.
- RLS helper/hot policy dung `(select auth.uid())` hoac indexed security-definer helper de tranh per-row recomputation; query plan/`EXPLAIN` bat buoc cho inbox cursor, outbox claim va pre-dispatch policy lookup.
- Test them anon, membership inactive/revoked, mot user active o hai org, forged health/message/cell, wrong account trong cung org va definer-function cross-tenant.
- Khong tao view neu khong can. Moi migration dung VIEW phai chay `node scripts/check-view-invoker.mjs` va view phai co `security_invoker=true`.

## 6. Phan quyen

Module quyen moi tach khoi `chat_zalo`:

- `openclaw_zalo.view`
- `openclaw_zalo.send`
- `openclaw_zalo.manage_connections`
- `openclaw_zalo.manage_automation`
- `openclaw_zalo.manage_knowledge`
- `openclaw_zalo.manage_handoff`
- `openclaw_zalo.manage_operations`
- `openclaw_zalo.audit`

Quy tac:

- `view` khong ham y `send`.
- `send` chi cho phep gui thu cong khi policy/effective mode cho phep.
- `manage_connections` moi duoc tao QR, disconnect, rotate/relogin va chap nhan canh bao rui ro account.
- `manage_automation` moi duoc publish/bat/tat automation, schedule va sales-group trigger.
- `manage_knowledge` moi duoc create/edit/publish/archive source/version; user chi co `view` duoc doc list, published content va retrieval preview da redact.
- `manage_handoff` moi duoc takeover/release conversation cua nguoi khac; nguoi dang duoc assign co the takeover conversation cua minh neu policy cho phep.
- `manage_operations` moi duoc resolve UNKNOWN, replay item hop le, pause mode/account va dung toan bo gui.
- `audit` moi duoc xem actor, policy decision va delivery evidence day du; noi dung nhay cam van bi redact theo truong.
- Moi quyen duoc recheck tai server tai thoi diem mutation, khong tin cache frontend.
- Thieu `view`: route redirect ve `/` ma khong render noi dung OpenClaw truoc. Co `view` nhung thieu quyen manage: khu vuc van hien read-only; action bi disable voi ly do/quyen can thiet, khong goi mutation.
- Tat ca user co `view` deu thay trang thai `GLOBAL_STOP`; chi user co `manage_operations` thay nut action enabled. Nhan nut la `DUNG TOAN BO GUI CUA CONG TY`, chi tac dong organization hien tai.
- Gui thu cong vao group can dong thoi `send`, exact group ID con trong allowlist va policy effective cho phep. `manage_automation` moi duoc thay doi allowlist; `send` khong the tu them group.

## 7. Luong nghiep vu

### 7.1 Ket noi QR

1. User co `manage_connections` chon ket noi tai khoan moi va chap nhan disclosure version `UNOFFICIAL_ZALO_PERSONAL_V1`: connector khong chinh thuc; nguy co session bi day/tai khoan bi gioi han hoac khoa; can consent/chong spam; session va noi dung nhay cam can duoc bao ve; nut dung khan cap va fallback Zalo native.
2. Control plane tao QR command ngan han cho cell dung organization/account.
3. Cell tao QR va post payload toi Edge endpoint server-only; Edge ma hoa application-layer trong challenge row khong RLS/Realtime. Browser short-poll Edge endpoint va chi render payload trong memory.
4. QR het han chinh xac sau 120 giay tu `issued_at`; refresh tao challenge moi, xoa payload va vo hieu challenge cu.
5. Khi dang nhap thanh cong, cell ma hoa session vao volume rieng, tang `session_generation`, cap nhat health va xoa QR material.
6. Account vao `CONNECTED_DRAFT_ONLY`. Khong auto/proactive/group send cho den khi wizard lien quan duoc hoan tat.
7. Neu Zalo day session hoac can xac minh, effective mode tu chuyen pause, queue khong dispatch va UI yeu cau reconnect.

Quy tac QR/disclosure:

- Acknowledgement luu theo organization/account, actor, disclosure version, thoi gian va IP/device metadata da redact. Huy dialog thi account van disconnected va khong tao challenge.
- Disclosure lai bat buoc khi version thay doi hoac reconnect sau trang thai `LIMITED`/nghi session theft. Banner rui ro gon van hien trong command bar; acknowledgement khong an no vinh vien.
- Challenge bind voi initiating user ID, Supabase auth session hash, organization/account, browser nonce va permission `manage_connections`; moi short-poll recheck session/quyen, rate-limit va atomic compare-and-consume.
- Tren man hinh <=767 px, UI noi ro QR phai duoc quet boi Zalo tren mot thiet bi khac. Khong cam ket scan cung dien thoai; UI cung cap huong dan mo CRM tren desktop/tablet va khong tao deep link co the bo qua QR.
- Disconnect/reconnect vo hieu moi challenge/command/ticket dang ton tai, tang `session_generation`, revoke workload/session references cu, xoa session material cu an toan va thu Zalo logout neu adapter ho tro. Neu khong the xac nhan logout, audit residual session risk va bat buoc QR moi.

### 7.2 Inbound va auto-reply

```text
Zalo provider callback (void/non-awaited) -> fork-owned internal listener
  -> full raw + normalized envelope + media manifest
  -> local bridge SQLite WAL/FULL commit
  -> listener success -> any OpenClaw dispatch/queue
  -> runtime API -> canonical write/dedupe
  -> automation eligibility -> AI draft/classification
  -> policy decision -> outbox or human draft
```

- Bridge phai commit event bytes, normalized envelope, media manifest, checksum va local sequence truoc internal listener success. Fork khong dispatch/queue cho OpenClaw va built-in reply khong chay truoc durable commit nay; provider callback khong cho provider-level ack.
- Stable-ID precedence va conflict xu ly dung Section 5.3: event ID primary, message ID secondary cho message-bearing event, both-present mapping bat bien; cross-kind/pair/payload reuse fail closed. Fingerprint chi chay khi ca hai stable ID null va van la heuristic at-least-once.
- Customer message luon duoc ghi canonical truoc khi automation chay. Media manifest la mot phan cua durable event; media bytes co the con `PENDING` sau manifest commit va duoc fetch/upload theo bounded workflow.
- Khong cam ket zero loss cho event ma provider chua callback hoac callback bi mat truoc khi fork nhan. Sau khi callback da vao listener, durability guarantee bat dau tai SQLite commit; incident/recovery van doi chieu provider history neu co gap.
- Built-in ZaloUser/OpenClaw replies bi tat vinh vien trong bridge mode, khong chi trong pre-commit window. Sau WAL/FULL success, sau canonical ingest, va sau automation tao no-send/draft/outbox, fork van khong emit built-in reply hay pairing notification/business content; chi mot outbox dispatch rieng qua `zalouser.bridge.send` moi co the bat dau business delivery.
- Prompt/content tu customer la du lieu khong tin cay, khong phai instruction he thong.
- Retrieval chi lay knowledge `published` cung organization va dung scope duoc phep.
- AI output phai khop schema; invalid output thanh draft loi, khong gui.
- Auto-reply chi enqueue neu automation published, account healthy, conversation khong takeover, recipient khong suppressed va limit hop le.
- Khi human takeover active, AI co the tao draft neu nguoi dung muon nhung khong auto-send.

### 7.3 Gui thu cong va gui chu dong

- Gui thu cong van di qua outbox va policy engine; khong co bypass truc tiep tu browser toi cell/Gateway.
- Bridge chi goi private RPC `zalouser.bridge.send` voi complete `CanonicalSendPayloadV1` + `OutboundAuthorizationMarker`. Fork tao exact ordered provider batch cho text, media va chunks truoc khi bat dau authorization.
- Fork goi `/authorize-send` ngay truoc provider I/O dau tien. Marker thieu, deny, error, timeout, stale, replay hoac payload-hash mismatch phai tao **zero provider frames**.
- Stock generic `send` RPC, message tool, pairing notification, direct adapter/tool va moi business-send path khac bi deny neu khong nam trong authorized fork context. Cac path `send.ts` gom text/media/link/reaction, channel adapters va tools deu phai co negative coverage.
- Neu da co kha nang provider handoff, timeout/disconnect/ack loss tao `UNKNOWN`; khong auto retry. Typing, seen va delivery receipt la control traffic co schema/rate/audit rieng, khong duoc chua business payload va khong thay the authorize-send.
- Gui chu dong can consent/evidence hop le, schedule window va limit da hoan tat trong wizard.
- Quiet hours va frequency cap duoc tinh server-side theo recipient, account, automation va organization.
- Neu chua cau hinh limit, gia tri effective la `0` va automation khong gui; wizard de xuat muc bao thu nhung owner phai xac nhan.
- Unsubscribe/stop request tao suppression ngay va co do uu tien cao hon schedule/campaign.
- First-contact/friend workflow chi co the bat khi server feature flag, adapter capability, risk acknowledgement, recipient source/evidence va limit gate deu hop le. Mac dinh deployment dau tien tat.

### 7.4 Gui vao nhom sale

1. Cell dong bo danh sach nhom tai khoan co tham gia, gom stable group ID, ten snapshot, thanh vien count/freshness neu adapter cung cap.
2. User co `manage_automation` chon tung nhom sale cua cong ty va them vao allowlist. Khong allowlist theo ten pattern.
3. User cau hinh mot trong hai nguon:
   - Lich gui co timezone, template version va occurrence id.
   - CRM event trong catalog allowlisted v1: `lead_created_or_assigned`, `room_became_available` va `sales_task_due`. Implementation plan phai map tung event toi source canonical hien co hoac tao typed domain-event emission idempotent; khong duoc thay bang generic database trigger/webhook.
4. Preview hien nhom dich, su kien/lich, mau tin, data duoc chen, gioi han va effective mode.
5. Khi trigger xay ra, control plane dedupe occurrence, render template tu field allowlist, chay policy va tao outbox target type `SALES_GROUP`.
6. Ngay truoc dispatch, bridge kiem tra lai group con trong allowlist, snapshot/freshness hop le, campaign chua cancel va global/account/group pause khong active.
7. Inbound chatter trong nhom khong tu kich hoat reply. Neu hien thi trong Inbox, no duoc danh dau `GROUP_READ_ONLY` tru khi user gui thu cong co `send`.

Khong co generic database trigger, arbitrary webhook payload, raw SQL condition hay template expression co the thuc thi code.

### 7.5 Knowledge

- Nguon v1: noi dung nhap tay, FAQ/chinh sach duoc phe duyet va du lieu CRM co connector field allowlist ro rang.
- Khong crawl web tuy y; khong ingest secret, auth token, ghi chu noi bo cam chia se hoac toan bo record khach hang vao prompt.
- Moi knowledge version co sensitivity `CUSTOMER_SAFE`, `INTERNAL_REVIEW_ONLY` hoac `RESTRICTED`. Auto-reply chi retrieve `CUSTOMER_SAFE`; `INTERNAL_REVIEW_ONLY` chi tao draft can human approval; `RESTRICTED` khong duoc dua vao model context.
- Source co `DRAFT`, `PUBLISHED`, `ARCHIVED`; automation chi doc published version.
- Preview retrieval hien doan nao se vao context; publish tao version bat bien va audit.
- Xoa source ngan retrieval moi; retention/audit cu van theo policy va legal hold.
- Sau generation, outbound content policy/DLP quet secret canary, cross-customer PII, internal-only phrases, system-prompt leakage, URL va field khong duoc phep. Match thi block auto-send va chuyen human review; target/policy khong bao gio lay tu output model.

## 8. Outbox, retry va nut dung

### 8.1 State machine

```text
QUEUED -> LEASED -> DISPATCHING -> SENT
                                 -> FAILED
                                 -> UNKNOWN
                                 -> DEAD_LETTER
```

- `LEASED` het han truoc khi dispatch co the duoc claim lai neu fencing token van hop le.
- Moi claim sinh `claim_token` UUID va `claim_generation`, dung DB clock cho `lease_expires_at`. Moi transition la compare-and-swap tren item state, claim token/generation, runtime fencing token, session/control/takeover version va DB-time lease.
- Khi adapter chua duoc goi va loi duoc phan loai retryable, item quay lai `QUEUED` voi exponential backoff va jitter.
- Khi adapter tra terminal rejection, item thanh `FAILED` hoac `DEAD_LETTER` theo attempt policy.
- Neu mat ket noi/timeout sau khi co kha nang Zalo da nhan lenh gui, item thanh `UNKNOWN`.
- `DISPATCHING` chi bat dau khi `/authorize-send` CAS thanh cong ngay truoc provider I/O dau tien cua exact ordered batch. Marker missing/deny/error/timeout/stale/replay/hash mismatch giu item pre-handoff va phai chung minh zero provider frames; chi loi da xac nhan truoc handoff moi duoc safe retry.
- `DISPATCHING` khong bao gio duoc worker khac reclaim de gui lai. Neu process chet hoac lease het han o trang thai nay, DB sweeper CAS item sang `UNKNOWN`; late completion chi duoc chap nhan neu claim/session/fencing/control versions van khop, nguoc lai dua vao quarantine audit.
- `UNKNOWN` **khong bao gio tu retry**. Operator co `manage_operations` xem evidence, doi chieu conversation va chon mark sent, mark failed hoac tao mot send intent moi co xac nhan.
- Resolution UNKNOWN la mot CAS mot lan voi `resolution_version`; hai operator/concurrent retry chi co mot nguoi thanh cong.
- Moi attempt co request hash, adapter result da redact, start/end time, cell/session generation va fencing token.

### 8.2 Thu tu kill switch

```text
GLOBAL_STOP (organization-wide)
> ORG / ACCOUNT / MODE_PAUSE
> CAMPAIGN_CANCEL
> HUMAN_TAKEOVER
> RECIPIENT / GROUP_SUPPRESSION
> policy allow
```

- Stop/pause co hieu luc voi item chua dispatch, ke ca item da lease.
- `GLOBAL_STOP` la stop toan bo outbound trong **organization hien tai**, luu trong `openclaw_control_states` co `organization_id` va monotonic `control_version`; no khong phai platform-wide va khong bao gio tac dong tenant khac.
- Platform operator co the stop bridge/cell o tang ha tang trong su co toan host, nhung khong co tenant UI/RPC nao dieu khien platform-wide stop.
- UI phan biet configured mode va effective mode; effective mode co the bi ha xuong do health/policy ma khong sua cau hinh nguoi dung.
- Release stop can nguoi co quyen, ly do, confirmation va audit; khong tu release sau restart.

## 9. Bao mat va an toan AI

### 9.1 Secret/session

- QR plaintext chi duoc ton tai trong challenge row application-encrypted va live browser memory. QR/session/workload/model/object secret khong vao Git, frontend bundle, localStorage, analytics, automated screenshot/video artifact hay log; E2E mask/skip QR capture. Manual user thay QR tren man hinh la hanh vi bat buoc cua login.
- Secret runtime duoc inject bang Docker secret/root-owned file, permission toi thieu va co rotation runbook.
- Session volume ma hoa at rest. Khong backup session bang snapshot khong ma hoa; khi mat volume, recovery chinh la re-login QR.
- Session file ma hoa AES-256-GCM voi per-cell key tu root-only/rootless-service secret nam ngoai session volume; atomic temp-write+fsync+rename, unique nonce, auth tag va fail-closed khi decrypt loi. Khong bao gio fallback plaintext.
- Reboot unlock dung secret source duoc provision lai boi runbook; rotation tao key moi va re-encrypt atomic hoac buoc QR re-login. Ma hoa chi giam rui ro offline disk theft/backup leakage, khong bao ve khi root/kernel host da bi compromise.
- Log mac dinh redact token, cookie, QR, phone/UID day du, signed URL, prompt content nhay cam va raw adapter payload.

### 9.2 AI boundary

- OpenClaw agent khong co shell, browser, filesystem, SQL, arbitrary HTTP, package install hay direct channel-delivery tool.
- Message tool, stock generic delivery RPC, pairing notification va direct ZaloUser adapter/tool send bi deny; AI khong co authorized fork context de goi `zalouser.bridge.send`.
- Model chi co structured input/output cho classification, knowledge query va draft generation.
- System/developer policy nam ngoai customer content; quote, HTML, file va metadata cua customer luon duoc danh dau untrusted.
- AI output khong the sua target, organization, group ID, consent, limit, schedule, policy version hay kill-switch state.
- Send recipient va target lay tu server-side intent, khong lay tu text do model sinh.
- Prompt injection test phai bao gom yeu cau tiet lo system prompt, secrets, goi URL noi bo, doi group/recipient va bo qua human takeover.

### 9.3 Media/SSRF

- Khong cho adapter/model fetch arbitrary URL do message content chi dinh.
- Media fetch chi toi hostname/protocol duoc adapter allowlist; resolve va pin IP tai connect-time, revalidate moi redirect, strip credential/cookie/header nhay cam va gioi han redirect. Reject moi dia chi IPv4/IPv6 khong globally routable, gom loopback, link-local, RFC1918, CGNAT, multicast, unspecified, documentation/reserved, ULA va cloud metadata.
- Co byte cap, timeout, content sniffing, decompression cap va quarantine cho type khong hop le.
- V1 chi render inline anh raster da decode/transcode an toan voi `nosniff`. SVG/HTML khong render inline; PDF/file hoat dong chi download attachment sau malware scan/quarantine verdict va browser sandbox policy.
- Browser download qua object-scoped authorization; cross-org, changed-key, expired va anonymous request bi 401/403.

### 9.4 Consent va chong spam

- Moi proactive recipient phai co consent/evidence hoac business relationship rule duoc owner xac nhan theo policy cong ty.
- Recipient/group suppression co hieu luc ngay.
- Limit server-side khong the bi frontend hoac AI tang vuot platform ceiling.
- Guardrail khoi tao cho mot account: toi da 1 outbound moi 3 giay, burst 2, 30 outbound/gio, 200 outbound/ngay, 10 auto-reply/peer/gio va 100 recipients cho mot approved batch.
- Proactive mac dinh toi da 1 tin/peer/ngay va 4 tin/peer/thang; quiet hours 20:00-08:00 theo timezone organization. Support reply inbound co the hoat dong ngoai quiet hours neu policy owner cho phep.
- Trong 72 gio dau sau connect/reconnect moi hoac sau LIMITED, account o warm-up: cac account-wide cap giam con mot phan ba, lam tron xuong; auto-reply co random floor delay 3-8 giay.
- Cac so tren la guardrail noi bo bao thu, khong phai quota Zalo duoc bao dam. UI chi cho giam; tang ceiling can code/config review, test va rollout gate moi.
- Wizard giai thich rui ro; platform ceiling duoc version hoa va chi co the thay doi qua code/review, khong qua form thong thuong.
- Risk acknowledgement theo account duoc audit; canh bao khong bi an vinh vien.

## 10. Retention, luu tru va egress

### 10.1 Retention

- Message, conversation content, AI draft/output da luu: 180 ngay tu `received_at/sent_at/created_at`; active conversation metadata khong bi xoa neu van can cho inbox, nhung noi dung het han bi tombstone.
- Published knowledge/template/automation version: giu khi active va 365 ngay sau archive/unpublish. `RESTRICTED` source khong duoc luu trong prompt log.
- Consent evidence, suppression va risk acknowledgement: giu suot khi account/organization active va toi thieu 365 ngay sau lan send/account removal; suppression khong bi xoa theo message retention de tranh tai lien he.
- Audit, policy/control version, delivery/UNKNOWN evidence va security event: 365 ngay; daily hash anchors giu cung thoi han hoac lau hon.
- QR payload xoa ngay khi used/expired; challenge metadata da redact 7 ngay. Connection/runtime health 90 ngay. Local operational logs toi da 14 ngay/1 GiB; spool toi da 24 gio/1 GiB va xoa ngay sau canonical acknowledgement.
- Media R2: 90 ngay mac dinh. Delete dung tombstone/grace period 7 ngay de phuc hoi accidental delete truoc physical object deletion.
- Legal hold la typed target theo organization va descendants (conversation/messages/media/outbox/evidence), do active owner co `audit` + `manage_operations` tao/release voi reason, optional expiry va audit. Hold ghi de retention theo tung table/object.
- Job retention chay theo batch nho, idempotent; R2 delete `404` duoc coi la success, object deletion/DB failure de lai tombstone retry. Audit purge chi qua maintenance role/RPC, ghi purge evidence va daily anchor, khong qua user DML.

### 10.2 Egress va query discipline

- Supabase chi luu text/metadata; khong blob/base64 trong Postgres, Realtime hay JSON response.
- Khong dung `select('*')` trong UI hot path. Dung selected columns, cursor pagination va lazy-load thread/media.
- Realtime chi subscribe organization/account/active-thread can thiet; invalidation batched/debounced, khong refetch O(N^2).
- Media stream truc tiep qua gateway/R2, khong proxy blob qua Supabase.
- Incoming image toi da 5 MB co the cache tu dong; video/file lon can policy/hanh dong ro rang.
- Dashboard Operations hien Supabase egress trend, R2 storage/request trend, VPS outbound va queue/media backlog.

### 10.3 Baseline tai thoi diem thiet ke

Snapshot da kiem tra ngay 2026-07-26:

- Supabase Pro egress `6.472 / 250 GB` (khoang 2.589%).
- Cached egress `0.166 / 250 GB`.
- Storage `1.085 / 100 GB`.
- PostgreSQL database khoang 136 MB.
- Legacy `zalo_messages` khoang 2.4 MB va `zalo_conversations` khoang 1.8 MB; chi la bang chung capacity, khong duoc tai su dung.
- Supabase overage tham khao: 0.09 USD/GB uncached, 0.03 USD/GB cached.
- Vultr tinh outbound, inbound mien phi theo tai lieu tham khao. Quota transfer cua goi host da nang cap khong the xac minh chi bang SSH; implementation preflight phai ghi quota tu Vultr portal/API vao runbook va alert o 60%/80%.
- R2 Standard co free tier 10 GB, storage tham khao 0.015 USD/GB-thang va khong tinh Internet egress theo tai lieu hien tai.

Gia va quota co the thay doi; Operations can hien usage thuc te thay vi dua vao hard-coded commercial assumptions.

## 11. VPS va van hanh

### 11.1 Topology dau tien

- Dung host Vultr Seoul hien co. Baseline read-only ngay 2026-07-26: Ubuntu 26.04 LTS, 16 vCPU, 64,996,679,680 bytes RAM (khoang 64 GB), root disk 1,288,032,935,936 bytes (khoang 1.2 TB), load average `0.35/0.14/0.10` tai thoi diem do.
- Dich vu dang chay gom container `9router` va `cli-proxy-api`. Baseline luc do: 9Router khoang 263 MiB RAM, CLI proxy khoang 58 MiB RAM; ca hai gan nhu 0% CPU. So lieu la baseline van hanh, khong phai cam ket tai luon thap.
- Chay mot **rootless Docker daemon/Compose stack rieng** duoi service user `openclaw-runner`, socket/data-root rieng; khong dung rootful Docker daemon/socket dang chay 9Router. Project name, network, volume, secret, label va log path deu prefix rieng. Khong public Gateway port.
- Dat rootless data-root tren fixed-size 20 GiB filesystem/mount rieng `/srv/openclaw-runtime`; image layers, writable layers, volumes, spool, temp va logs deu nam trong mount nay. Systemd slice enforce tong `CPUQuota=400%`, `MemoryMax=8G`, `TasksMax` va service-specific sublimits.
- Disk budget: engine images/writable layers toi da 10 GiB va GC co kiem soat; temp media 5 GiB; spool 1 GiB; session/config 1 GiB; logs 1 GiB; 2 GiB headroom. ENOSPC trong mount chi lam OpenClaw fail/pause, khong duoc fill root filesystem.
- Khong sua compose/command/image/volume/network/resource setting cua `9router` va `cli-proxy-api`; deployment OpenClaw **khong restart rootful Docker daemon**. Neu mot thay doi host/daemon/firewall toan cuc bat buoc, no nam ngoai rollout nay va can owner duyet maintenance task rieng.
- Khong thay doi host-wide UFW/Docker firewall trong rollout OpenClaw. Preflight phai inventory port bindings, Docker networks, systemd units, health endpoints va current 9Router/CLI reachability; OpenClaw chi them rule egress/namespace rieng va khong expose inbound port.
- Egress cell/bridge default deny toi host va RFC1918/link-local/metadata/loopback/multicast/ULA, cong 9Router/CLI, Docker socket va management ports. Allowlist chi DNS/NTP, Zalo endpoints, Supabase Edge, private media gateway va model endpoint; connect-time IP pinning + DNS revalidation.
- Negative connectivity test tu moi container phai fail toi host gateway, 9Router/CLI published ports, Docker API, cloud metadata va private subnets khong nam allowlist. Neu test fail thi block rollout.
- Network/volume/secret theo cell. Mot cell production dau tien; khong pre-provision nhieu tenant chua ton tai.
- Local encrypted SQLite/event spool chi la buffer, hard cap `1 GiB` hoac `24 gio` du lieu, cham nguong nao truoc.
- Temp media hard cap 5 GiB, xoa sau durable upload/processing; logs rotate o 1 GiB/14 ngay. Cap-attempt/ENOSPC test phai chung minh 9Router/CLI van healthy.

### 11.2 Spool durability va RPO

- SQLite spool dung WAL, `synchronous=FULL`, monotonic local sequence, per-record checksum va atomic transaction. Fork listener gui full raw + normalized envelope/media manifest; bridge commit durable truoc internal listener success va truoc OpenClaw dispatch/queue. Provider callback van void/non-awaited. Row chi xoa sau canonical acknowledgement tu Supabase.
- Khong drop oldest text/event de giu cap. O 80% cap: pause outbound, history sync va media prefetch; o 95%: chi nhan minimal inbound envelope; o 100%: stop intake neu adapter cho phep, ghi `INBOUND_GAP_STARTED` va alert P1. Khong ghi vuot fixed filesystem.
- Sau recovery, sync lai toi da 48 gio recent history hoac tu canonical watermark cuoi, dedupe va danh dau `HISTORY_SYNC`; history sync khong kich hoat AI/automation/push.
- Normal-operation target: inbound canonical p95 <=60 giay. Sau listener acknowledgement, local RPO cho accepted event envelope/manifest la 0 doi voi process crash trong durability model da test; sau canonical ack, RPO message text/metadata la 0 doi voi mat VPS. Guarantee khong bao phu event truoc provider callback; trong Supabase outage, unflushed events chi durable tren local spool toi da 24 gio/1 GiB.
- Simultaneous Supabase outage + mat/corrupt shared VPS truoc flush co the mat unflushed inbound neu Zalo khong replay/history du. Day la residual risk duoc chap nhan cua unofficial connector; incident phai hien exact gap window va yeu cau doi chieu Zalo native.

### 11.3 Health va circuit breaker

- Cell/bridge heartbeat toi control plane moi 30 giay; sau 90 giay khong heartbeat thi account `STALE` va outbound effective pause.
- Pause outbound khi session invalid, runtime lease/fencing khong hop le, spool/runtime mount vuot 80%, clock drift >2 giay trong 2 phut, policy API unavailable >60 giay, queue lag p95 >30 giay trong 5 phut, hoac UNKNOWN >3 item/10 phut hay >2% voi minimum 20 attempts.
- Inbound co the buffer khi Supabase/R2 loi trong quota; outbound khong dispatch neu khong the recheck policy va ghi attempt evidence.
- Queue lag, UNKNOWN rate, adapter error, reconnect count, CPU/RAM/disk, spool age/bytes va media failure co alert.
- Preflight do baseline 9Router/CLI health latency va error trong it nhat 30 phut. Co-tenant guard kich hoat neu p95 latency tang >20% trong 5 phut hoac error >1% trong 5 phut; cung kich hoat neu tong RAM host >75%/15 phut, swap >10%, one-minute load >12/15 phut, root disk free <max(200 GiB,20%).
- Khi co-tenant/host guard kich hoat: pause outbound, AI va media processing ngay; giu minimal inbound spool. Neu con vi pham sau 10 phut, stop OpenClaw cell/bridge process trong rootless stack, giu session volume va alert P1. Khong stop/restart 9Router/CLI.
- Clear condition phai dat lien tuc 15 phut; health-generated pause khong auto-resume outbound. User co `manage_operations` review incident va resume; manual/global stop khong bao gio bi health logic release.
- External Cloudflare watchdog probe health endpoint moi 60 giay, timeout 10 giay; sau ba lan fail phai ghi incident va gui CRM push/email toi owner/admin trong 3 phut, ngay ca khi ca host/rootless engine down.
- Transfer quota phai biet truoc khi mo production proactive/group media; unknown quota block gate. 60% billing-cycle warning, 80% tat auto-cache video/file, 90% pause noncritical proactive/group media, 100% pause moi outbound co media. Supabase/R2 usage co forecast 7/30 ngay va canh bao 60/80/90% quota/budget.
- Khong log raw message o metric/logging pipeline.

### 11.4 Nguong capacity va nang cap

- Soak mot cell it nhat bay ngay voi traffic that co gioi han truoc khi cho phep cell thu hai.
- Workload envelope cell dau tien: 100 active conversations, burst inbound 30 message/phut trong 15 phut, AI concurrency 4, media image <=5 MB o 10 image/phut va guardrail outbound toi da 200/ngay. Pass neu queue lag p95 <30 giay, heartbeat fresh, CPU/RAM OpenClaw <70% cap va 9Router/CLI p95 latency regression <=20%, error <=1%.
- Baseline tai nguyen cho thay host du de **pilot mot cell trong envelope tren**, khong phai cam ket moi traffic deu du. Tang cap OpenClaw hoac them cell chi khi metric chung minh can thiet va van giu it nhat 50% RAM host, 50% CPU capacity va max(200 GiB,20%) disk headroom cho host/dich vu khac.
- Truoc moi cell moi, do lai `docker stats`, CPU/RAM/disk/load, queue lag va latency 9Router/CLI proxy; khong suy dien tu baseline cu.
- Neu OpenClaw memory >75% hard cap, CPU >70% cap lien tuc 15 phut, queue lag p95 >30 giay do tai nguyen hoac OOM/restart lap lai, toi uu/tang cap rieng stack trong headroom host truoc khi them tenant.
- Neu media/temp disk tang nhanh, sua retention/streaming truoc khi tang disk; VPS khong tro thanh kho media.
- Moi tenant moi can capacity review, workload credential, volume/network rieng va RLS/E2E tenant test.
- Giu IP va region Seoul on dinh cho session Zalo. Chuyen host/region chi la runbook co chu y, can pause outbound, backup canonical state, fencing va QR re-login neu can.

### 11.5 Backup va recovery

- Truoc khi mo auto/proactive/group send production, Supabase backup/PITR phai duoc xac minh dat canonical DB RPO <=15 phut va RTO <=4 gio. Neu goi hien tai khong dat, he thong chi o draft/manual limited mode cho den khi owner duyet PITR/backup tuong duong.
- R2 dung immutable UUID object keys/no-overwrite va tombstone 7 ngay; durable object RPO 0 sau upload verify, restore RTO <=4 gio cho accidental delete trong grace window.
- OpenClaw stack duoc xem la replaceable runtime tren shared host. Cau hinh deploy va runbook nam trong repo, secret nam ngoai repo; replacement cua OpenClaw khong dong nghia replacement cua 9Router.
- Secret inventory/rotation runbook luu chi reference/owner, khong secret value. Mat session volume co account recovery RTO <=60 phut khi owner san sang quet QR; khong cam ket restore cookie/session backup.
- Khong backup SQLite spool nhu canonical database. Sau mat VPS: provision lai, restore config/secrets an toan, re-login Zalo, acquire fencing lease moi, sync history 48 gio va doi chieu outbox/UNKNOWN/gap.
- Truoc production va moi quy, restore drill phai phuc hoi mot backup test, rotate workload/session key, simulate accidental R2 delete va ghi actual RPO/RTO.
- Pre/post deployment/rollback capture container ID, image digest, `StartedAt`, `RestartCount`, port/network/volume mounts va authenticated health/latency cua 9Router/CLI. `StartedAt`/restart count/config cua co-tenant phai khong doi va SLO van dat.
- Legacy drill con chung minh `/chat-zalo`, worker cu va `zalo_*` co zero DML/dual-write tu OpenClaw trong toan bo rollout/rollback.

### 11.6 Chuyen sang Vultr moi sau nay

- Host portability la requirement: Compose/config/runbook khong hard-code host IP, database/media nam ngoai VPS, object keys va canonical IDs khong doi khi chuyen host.
- Planned migration target RTO <=60 phut: `GLOBAL_STOP` organization, drain/freeze QUEUED/LEASED, chuyen `DISPATCHING` qua UNKNOWN neu can, deploy rootless stack tren VPS moi, cap workload credential moi, acquire fencing lease moi, revoke credential/lease may cu, QR re-login, history sync 48 gio, controlled smoke va resume.
- Mac dinh khong copy raw Zalo session sang IP/host moi; owner quet QR lai de giam nguy co session theft/device anomaly. Session migration chi duoc dung neu adapter co contract va test ro rang sau nay.
- Supabase/R2 khong can copy. Chi config artifact va secret duoc provision lai qua runbook; local spool cu phai flush/doi chieu truoc cutover hoac gap duoc ghi ro.
- Quy tac giu IP/region on dinh ap dung cho planned steady state. Disaster recovery/migration duoc phep doi IP/region voi pause, fencing, credential revoke, QR re-login va audit.

## 12. UI/UX va trang thai bat buoc

### 12.1 Huong thiet ke

- Bao toan ngon ngu thiet ke iHome CRM nhung tao operations cockpit ro rang, dam va de doc; khong sao chep UI `/chat-zalo`.
- Trang thai luon co icon + text, khong chi mau.
- Risk, effective pause, UNKNOWN va global stop la visual priority cao.
- Controls tren mobile toi thieu 44 px, khong scroll ngang toan trang, composer an toan voi keyboard/viewport.

### 12.2 Trang thai can co

- Chua co account; QR dang tao; QR het han; dang cho quet; dang xac minh; connected draft-only; reconnect required; session kicked.
- Cell healthy/degraded/stale/offline; Supabase/R2 partial outage; spool pressure; queue delayed.
- Inbox empty, no permission, loading, paginated loading, out-of-order/duplicate safely handled, media unavailable.
- Automation draft/incomplete/published/paused/blocked by policy; preview test va explanation cho ly do khong gui.
- Sales group not synced, stale, not allowlisted, removed/renamed, paused, invalid target.
- Outbox queued/leased/dispatching/sent/failed/unknown/dead-letter.
- Permission-denied co thong diep ro va khong nhay noi dung nhay cam truoc khi auth load xong.
- Emergency stop thanh cong/that bai, co retry va khong optimistic release.

### 12.3 Wizard gioi han theo tung tinh nang

Moi wizard bat buoc co:

1. Giai thich tinh nang va rui ro Zalo ca nhan.
2. Chon doi tuong/nhom dich tu nguon da xac minh.
3. Khai bao consent/business basis va suppression behavior.
4. Chon gio hoat dong, timezone, tan suat va hard stop.
5. Soan template/knowledge, preview voi du lieu mau da redact.
6. Chon draft-only, can human approval hay auto theo policy.
7. Chay validation/dry-run khong gui.
8. Xac nhan boi user co quyen; publish version bat bien va audit.

Required fields theo mode:

| Mode | Truong bat buoc rieng |
|---|---|
| Inbound reply | conversation/recipient scope, published knowledge, delay, draft/human/auto mode, per-peer cap |
| Proactive existing-thread | recipient set, consent evidence, schedule/quiet hours, template, per-peer/account cap |
| Sales-group schedule | exact allowlisted group, schedule/timezone, template version, account/group cap |
| CRM-event to sales group | typed event, exact group, field allowlist/mapping, dedupe key, template version |
| First-contact/friend | server feature flag, adapter capability, recipient source/evidence, enhanced disclosure va risk cap; mac dinh blocked |

- Wizard auto-save draft sau moi buoc, cho phep resume; validation loi gan dung field/buoc va khong mat data.
- Dry-run hien target count, sample render da redact, policy decision va ly do block; khong tao outbox.
- Publish dung optimistic version. Neu draft/policy/group/knowledge da doi, server tra stale-version conflict va bat review lai, khong silent overwrite.

### 12.4 Observable UI acceptance

- **Inbox:** search tra dung conversation theo safe normalized text/identity; unread count tang/giam idempotent; assignment concurrent dung optimistic version; master/detail pagination giu stable order; media loading/failure co retry va khong lam mat text; delivery status chi theo canonical outbox; empty/error retry co the phuc hoi.
- **Knowledge:** user `view` xem list/published/retrieval preview; `manage_knowledge` create/edit/validate/publish/archive. Empty content/invalid source bi chan; publish tao immutable version; stale edit tra conflict; retrieval preview thanh cong, khong co ket qua va loi deu co state rieng.
- **Risk:** QR/automation publish bi chan neu disclosure version chua acknowledged; cancel khong mutation. Banner luon hien; version change va LIMITED reconnect bat acknowledge lai.
- **Groups/schedule:** group snapshot fresh toi da 24 gio de automation dispatch. Qua nguong thi target `STALE`, pause va yeu cau sync; rename cung provider ID chi cap nhat label; removed/inaccessible disable target. Missed occurrence mac dinh `SKIPPED_MISSED`, khong catch-up tu dong. Edit recurring series tao version cho future occurrences; pause/cancel khong thay doi past evidence.
- **Operations:** `DEGRADED`, `STALE`, queue delayed va quota pressure hien threshold, window, last-fresh timestamp va action dang ap dung. Filter/drilldown khong hien raw secret/content; resume chi enabled khi clear condition dat va user co quyen. Dead-letter replay chay validation/policy moi va tao intent moi, khong sua attempt cu.
- **Permissions:** thieu route `view` redirect `/` khong content flash; action manage bi disabled co explanation. Global-stop state visible cho `view`, button enabled chi cho `manage_operations`.
- **Responsive:** breakpoint chinh xac <=767 px dung `usePhoneViewport()`. Mobile bottom nav co `Tong quan`, `Hop thu`, `Tu dong`, `Them`; `Them` mo `Tri thuc`, `Lich & Nhom sale`, `Van hanh`. Inbox la master/detail co nut back; operations tables thanh cards; calendar thanh agenda; wizard thanh stepper full-screen. Desktop >=768 px hien day du sau khu vuc va multi-column cockpit.

## 13. Error handling va tinh nhat quan

- UI khong bao `SENT` dua tren optimistic response; chi hien sent khi canonical outbox duoc bridge xac nhan.
- Network retry cua browser chi retry operation idempotent; mutation tao intent dung client operation id.
- Realtime chi la invalidation/latency optimization, khong la nguon su that. Reconnect phai refetch cursor/current state.
- Supabase unavailable: cell buffer inbound trong quota, pause outbound; UI hien degraded.
- R2 unavailable: text co the tiep tuc neu khong can media; media duoc spool trong quota; khong gui message tham chieu object chua durable neu policy yeu cau durable media.
- Model provider unavailable/quota/invalid schema: auto-send AI pause, draft hien loi/retry va manual non-AI send van hoat dong qua policy. Khong fallback sang 9Router/CLI proxy; chi resume khi provider/model health, quota va output-schema test dat.
- Session kick: effective pause, huy QR cu, khong auto-relogin bang credential khac.
- Two-cell race: chi fencing token hien tai co the claim/dispatch/complete; late completion tu cell cu bi quarantine va audit.
- Group ID/recipient mismatch: fail closed, khong fallback theo ten/so dien thoai gan giong.
- Retention delete failure: retry co trang thai, khong xoa metadata truoc khi object deletion outcome duoc ghi.

## 14. Ke hoach kiem thu da duyet

### 14.1 Unit va property-based

- Policy: consent, quiet hours, frequency cap, group allowlist, feature gate va kill-switch precedence.
- State machines: account connection, QR TTL, automation version, outbox, UNKNOWN/dead-letter, takeover va retention.
- Idempotency/dedupe voi duplicate, out-of-order, delayed event va concurrent claim.
- Redaction: QR, token, cookie, phone/UID, signed object ticket, adapter payload va prompt content.
- Template/CRM field allowlist va timezone/DST behavior.
- Dung Vitest va fast-check cho invariant, khong chi example test.

### 14.2 SQL/RLS

- Migration apply/rollback trong moi truong test.
- Hai organization, nhieu role, negative test cho read/write/FK/RPC/lease/audit/media authorization.
- Anon, inactive/revoked membership, one-user-two-org, wrong account same org, forged parent/health/message/cell va definer-function cross-tenant.
- Partial unique race cho account/cell/QR; DB-clock TTL boundary; organization/account immutability va typed target XOR/FK.
- Claim token/generation CAS races, same key/different payload, crash-window transaction, concurrent UNKNOWN resolution.
- Realtime publication allowlist, equal cursor timestamps, delayed insert, membership revoke va organization/account cache switch.
- Browser direct DML revoke tren bang nhay cam.
- Composite FK ngan reference cheo organization.
- `node scripts/check-view-invoker.mjs` sau moi migration cham VIEW.
- Regenerate Supabase types sau migration va khong lan `as any`.

### 14.3 Fake Zalo adapter va service integration

- Vendored fork integrity: exact fixed tarball URL, toi da 3 HTTPS redirects chi trong `registry.npmjs.org`/direct subdomains, `2341459` bytes, `3169` regular `package/` entries, npm SRI/SHA-1, mandatory attestation subject + SLSA resolved commit, exact committed `75`-blob source snapshot, patch-series SHA-256, built-tgz SHA-256, internal-only install va deterministic `linux/amd64` image digest. Missing metadata/network hoac offline-only run khong duoc tao/cap nhat artifact/evidence/hash hay mo Tasks 3-29. Session-crypto test clean-build hai lan va compare exact ba committed dist blobs. Image test dung deny-by-default clean context chi co ba session dist inputs, exact two-stage Docker/no in-image session build, Node-first network-none local install voi one fresh empty cache, fixed build arg, pinned BuildKit/buildx, two fresh builders, no cache, separate pinned base pull, two isolated OCI outputs voi `rewrite-timestamp=true`, va promote mot exact verified archive.
- Provenance test bat buoc `M` co exact 87 paths, `.gitattributes`, raw metadata/npm keys/attestation/Sigstore target, va non-self-referential `mInputAggregate`. Test recompute 86 raw blob records + exact RFC 8785 null projection record, golden root, va separately verify final `UPSTREAM.json` Git blob; self-referential final-blob claim fail. `UPSTREAM.json` bind path/endpoint/cap/size/SHA-256 cua bon raw trust inputs. Verifier dung Git blob bytes de validate npm/Fulcio/Rekor/DSSE/SLSA va trust pins; refetch chi byte-compare, khong thay input. Evidence `E` recheck ca bon va embedded M/R review reports.
- Tarball inventory test khoa dung `25` package-owned files, `3144` bundled files va `38` dependency roots; package-owned set phai khong co TypeScript/test/source map/license/notice. Source van la exact Git snapshot, khong duoc tai tao tu tarball.
- Compliance test byte-compare upstream root `LICENSE`/`THIRD_PARTY_NOTICES.md` theo SHA-256 da khoa, bat buoc verbatim `upstream/THIRD_PARTY_NOTICES.openclaw.md`, va verify committed reviewed `licenses/manifest.json` chua exact 38-package name/version/SPDX selections + tat ca 39 source carrier path/size/SHA-256/output-path records. `UPSTREAM.json`/`FORK.json` bind manifest hash/counts; pako `LICENSE` + `lib/zlib/README` deu bat buoc; Spark-md5 chon included WTFPL branch va cam fetch `LICENSE2`.
- Vendor verifiers fail closed tren carrier/member/path/type/mode/hash va inventory moi dynamic resolution/file-read site. Static analyzer phai exhaustively classify finite expansions va bat buoc `derivedRuntimeSet == runtimeReachabilityAllowlist`; moi runtime-classified artifact member nam trong allowlist. Mandatory scenario matrix discovery/config/setup/doctor, QR/session restore, inbound text/media, outbound text/media/link/reaction, control traffic, authorization denial/UNKNOWN, offline restart tao `resolvedRuntimeSet` nonempty va subset allowlist; resolved-unlisted fail, nhung optional statically classified member co the chua duoc trace. Unclassified/incomplete dynamic site van fail closed. `FORK.json.installedTree`, list/inspect/package.json/all discovery roots reject duplicate/shadow. Differential fixtures phai stock-fail/fork-pass cho private seams va parity cho behavior khong doi.
- Command-contract tests reject pre-review qualifying runs, working-tree/reserialized bytes, `git archive`/checkout source paths, wrong Git type/mode, exporter thieu `git ls-tree -rz --full-tree`/`git cat-file --batch` hoac skip complete manifest/output re-hash, wrong M aggregate/projection/golden vector, wrong context-root v2/golden vector, helper khong dung `-ReviewedTree` + absolute pinned `-BuildxPath`, source/evidence mixing, Docker khong dung exact two stages, in-image session `npm ci`/build, extra/missing dist input, Node assertion late/missing, reused/nonempty cache, missing `RUN --network=none`, minimal-rootfs violation, hay air-gap claim cho base pull. Version fixtures accept `24.15.0` va later `24.x`, reject `22.20.x`, `24.14.x`, `25.x`, prove zero work/artifact/evidence after failure, va require exact CI pin/preflight + service-script prefix + helper self-preflight; failing Task 19/27 RED blocks cung phai Node-first. Evidence-child fixtures require exact reviewed `verify-image-lock.mjs` before stage/commit, closed schema, reviewed tree va retained absolute OCI archive. Detached Task 2/E27/E29 cleanup fixtures dirty worktree, inject primary/cleanup errors, require canonical temp containment, checked `git worktree remove --force`, primary-error preservation, cleanup-only failure propagation, va no remaining path/registration. Cac test khac reject mutable install state, wrong buildx/BuildKit, non-byte-identical OCI archive/layout/index/blob, open evidence schema, tampered review reports, ignored-only final evidence, OCI archive trong E29, bundle/deploy truoc E29 approval, hoac native failure ma van chay sentinel. Task 27 source-only preflight non-qualifying; exact `R27` review precedes qualifying `-ReviewedTree $R27` build, va downstream chi consume independently reviewed evidence-only `E27`. Task 29 bat buoc exact `R29 -> qualifying -ReviewedTree R29 -> evidence-only E29 -> independent E29 approval`; bundle va moi Edge/Worker/VPS action bind E29, con cell evidence bind R29. Task 30 giu main worktree clean exact E29; no khong duoc goi helper tai HEAD E29. Final helper chay trong fresh canonical detached exact R29, verify exact helper blob, output absolute vao E29-workspace `.release`, force-clean/error-preserve, roi E29 context compare candidate voi closed schema, committed E29 evidence, bundle va remote digest.
- Inbound listener ordering tai `extensions/zalouser/src/monitor.ts` va `extensions/zalouser/src/zalo-js.ts`: provider callback void/non-awaited, full raw/normalized envelope + media manifest, WAL/FULL commit before internal success/dispatch, exact event-ID-primary/message-ID-secondary mapping, fallback only khi ca hai ID null, media `PENDING`, crash/ENOSPC/corrupt spool.
- Stable-ID tests: event ID only, message ID only, both present, exact replay, mismatched pair, same stable ID/different payload, reuse across event kinds in one account, va same textual ID across two accounts/organizations without cross-dedupe.
- Success-path reply-disable tests: after WAL/FULL commit and after each canonical no-send/draft/outbox outcome, built-in reply, pairing notification and other business-content emit counters remain zero; an outbox row alone emits nothing until authorized `zalouser.bridge.send` is explicitly invoked.
- Outbound choke-point coverage tai `extensions/zalouser/src/send.ts` (gom text/media/link/reaction), `extensions/zalouser/src/channel.adapters.ts` va `extensions/zalouser/src/tool.ts`: chi `zalouser.bridge.send`, exact ordered batch, authorize immediately before provider I/O, zero frames cho missing/deny/error/timeout/stale/replay/hash mismatch, UNKNOWN sau possible handoff.
- Negative tests cho stock generic `send` RPC, message tool, pairing notification va direct adapter/tool/business-send; positive/negative tests phan loai typing/seen/delivery receipts la control traffic.
- Duplicate/out-of-order inbound.
- Restart voi spool con du lieu.
- Supabase outage, R2 outage va recovery.
- Session kick/QR expiry/reconnect.
- Hai cell tranh lease va fencing.
- Same-cell concurrent workers, lease expiry before adapter call, stop/control bump sau preflight, crash o DISPATCHING va stale late completion.
- Timeout sau adapter handoff tao UNKNOWN va khong auto retry.
- Group removed/renamed/not allowlisted.
- Policy thay doi sau enqueue nhung truoc dispatch.
- Prompt injection va media SSRF/decompression/size cases.
- QR initiating-session/replay/rate-limit, workload token audience/nonce/replay/clock-skew va disconnect credential/session revocation.
- R2 expired/replayed ticket, wrong tenant/exact key, content-length/checksum mismatch, MIME/magic-byte mismatch, active content quarantine, partial upload va object-delete/DB-failure recovery.
- Spool checksum/WAL restart, 80/95/100% behavior, fixed-filesystem ENOSPC va simultaneous Supabase outage + host-loss gap reporting/history reconciliation.

Khong dung tai khoan Zalo that trong test tu dong.

### 14.4 Headless E2E

Playwright fleet phai test desktop va mobile cho:

- Permission route/sidebar/launcher va no-content-flash.
- QR happy path/fake adapter, expiry va reconnect.
- QR risk disclosure/acknowledgement, same-phone guidance, permission bind va no-QR test artifact leakage.
- Inbox search, unread, assignment race, pagination/order, media retry, draft, manual send intent, takeover/release va delivery status.
- Automation wizard, dry-run, publish, pause va blocked explanations.
- Knowledge create/edit/validate/publish/archive, retrieval preview, stale conflict va permission denied.
- Schedule, CRM event dedupe, sales group allowlist va emergency stop.
- UNKNOWN/dead-letter resolution va partial outage states.
- Cursor pagination, selected columns, debounced Realtime va clean console.

Moi automated suite (Vitest service, SQL, R2 va E2E) phai co hard guard chi ghi organization DEMO `dddd0000-0000-4000-8000-000000000001`, test runtime/bucket prefix rieng va tu cleanup fixture. Organization that `aaaa0000-0000-4000-8000-000000000001` chi doc; moi attempt ghi production ID phai fail fast truoc network/database mutation.

Playwright bat buoc dung `trackConsoleErrors` tu `.e2e-fleet/specs/auth.ts` va assert danh sach loi console sau loc bang rong; production smoke cung ghi/kiem tra console ma khong luu QR/message content.

### 14.5 Load/egress

- Kiem tra 10k conversation metadata va thread dai bang cursor pagination.
- Luu/kiem tra `EXPLAIN (ANALYZE, BUFFERS)` tren test dataset cho inbox cursor, target/consent/suppression pre-dispatch va `SKIP LOCKED` outbox claim; khong seq scan ngoai bang nho co chu y.
- Chung minh khong `select('*')` hot path, khong blob/base64 va khong O(N^2) refetch.
- Batch/debounce Realtime invalidation, active-thread subscription va bounded query size.
- Queue throughput/lag voi mot cell; spool cap 1 GB/24 gio; media size/lifecycle.
- Chay workload envelope Section 11.4 va assert queue p95 <30 giay, OpenClaw <70% resource cap, 9Router/CLI latency regression <=20% va error <=1%.
- Fill fixed 20 GiB runtime filesystem den ENOSPC trong test co kiem soat; OpenClaw pause/fail trong boundary, host root disk va co-tenant van healthy.
- Theo doi Supabase egress, Vultr outbound va R2 request/storage trong soak.

### 14.6 Lenh verification bat buoc

```bash
node -e "const [major,minor]=process.versions.node.split('.').map(Number);if(major!==24||minor<15){console.error('Node >=24.15.0 <25 is required');process.exit(1)}"
npx vitest run src/lib/openclaw-zalo src/hooks/openclaw-zalo src/components/openclaw-zalo src/pages/openclaw-zalo
npm --prefix services/openclaw-zalo-cell/vendor/zalouser-bridge ci
npm --prefix services/openclaw-zalo-cell/vendor/zalouser-bridge run verify
npm --prefix services/openclaw-zalo-cell/session-crypto run verify:dist
npm run test:openclaw:services
npm run test:openclaw:sql
npm run test:openclaw:r2
npm run typecheck:baseline
npx tsc --noEmit -p tsconfig.app.json
npm run gen:types > src/integrations/supabase/types.ts
# Re-add/verify the generated-file comment header required by this repo.
node scripts/check-view-invoker.mjs          # neu migration cham VIEW
cd .e2e-fleet && FLEET_WORKERS=8 npx playwright test specs/openclaw-zalo.spec.ts
```

Implementation plan phai tao ba npm scripts `test:openclaw:services`, `test:openclaw:sql`, `test:openclaw:r2` truoc khi dung checklist nay. Node assertion phai la first Node action in this checklist and in the service-script prefix; CI pins `24.15.0` before `npm ci`. Session-crypto `verify:dist` must compare two clean builds against exactly three committed dist blobs while preserving package/lock engine `>=22.13.0`. Browser mac dinh headless; khong tu mo headed browser.

### 14.7 Smoke test production co kiem soat

Chi sau khi automated tests, reviewer va rollout gates xanh:

1. Dung cong ty that, tai khoan Zalo moi va mot nhom sale do owner kiem soat.
2. Ket noi QR; draft-only; gui mot tin thu cong toi recipient/nhom duoc owner chon.
3. Bat mot inbound auto-reply pham vi hep, mot proactive schedule toi recipient existing-thread co consent va mot group schedule/su kien co gioi han.
4. Xac minh audit, outbox, media, stop switch, disconnect/reconnect va khong co tac dong toi Zalo cu.
5. Sau smoke, mac dinh pause/tat moi automation/schedule/group trigger vua tao va cleanup target test. Chi de live neu owner xac nhan ro trong rollout gate sau khi review metric/evidence.
6. Dung ngay neu co session warning, UNKNOWN bat thuong, Zalo limitation, console error hoac co-tenant SLO regression.

## 15. Trinh tu rollout

1. **Fork gate:** verify upstream source/tarball locks, patch-series hash, exact internal tgz hash, inbound listener ordering, outbound choke points va deterministic `linux/amd64` image; chi khi gate duong tinh xanh moi mo foundation.
2. **Foundation:** migrations/RLS/RPC, permissions, fake adapter, frontend shell sau feature flag.
3. **Infrastructure:** private R2/gateway, shared Vultr stack isolation, bridge/cell hardening, observability.
4. **Connection:** QR va account health voi tai khoan moi; effective mode draft-only.
5. **Shadow:** ingest inbound, AI draft va human send; khong auto-send.
6. **Limited inbound automation:** mot tap conversation duoc owner chon, gioi han thap, theo doi UNKNOWN/session.
7. **Proactive:** chi recipient consent va wizard da hoan tat.
8. **Sales groups:** mot nhom owner-controlled, sau do allowlist them nhom neu soak on dinh.
9. **Multi-organization:** chi onboarding organization thu hai sau tenant isolation E2E va capacity review.

Exit gate toi thieu:

| Gate | Dieu kien de di tiep |
|---|---|
| Fork | Bounded same-registry HTTPS redirect + fixed URL/size/3169-entry/SRI/SHA-1 locks, mandatory online attestation/SLSA, exact 75-blob source snapshot, root license/notice hashes, reviewed `licenses/manifest.json` cho exact 38 dependency roots + 39 carriers, approved rendered notice/carriers, exact `FORK.json.artifactMembers` + runtime reachability allowlist, patch-series SHA-256, built-tgz SHA-256 va image digest khop; offline/network/metadata failure khong mo gate; verifier reject carrier/root/notice/member/path/case/traversal/symlink drift; install/load/upstream-compatible/differential tests xanh; deny-by-default clean context; pinned BuildKit/buildx/exporter; two fresh no-cache/pull builds voi fixed epoch + rewritten timestamps tao OCI archives co manifest/config/layers giong nhau; exact promoted archive ton tai va hash/digest khop handoff manifest; listener/outbound choke-point tests xanh; image chi co internal fork `zalouser` |
| Foundation | SQL/RLS/grant/claim tests xanh; migration additive; generated types sach; zero reference/DML `zalo_*` |
| Infrastructure | Egress negative, ENOSPC, watchdog, co-tenant pre/post invariants va restore drill xanh; transfer quota da biet |
| Connection | Disclosure + QR + revoke/reconnect xanh; session secret khong ro ri; account draft-only |
| Shadow | 48 gio inbound/draft; no auto-send; queue p95 <30s; zero unexpected UNKNOWN |
| Limited inbound | 72 gio warm-up, policy/DLP dung, session healthy, UNKNOWN <= threshold, co-tenant SLO dat |
| Proactive | Consent/suppression/quiet hours/caps xanh; owner-controlled smoke cleanup hoan tat |
| Sales groups | Exact allowlist, freshness, schedule/event dedupe, no wrong-target send va owner group smoke xanh |
| Multi-org | Full 2-org negative fleet, workload/cell isolation va seven-day capacity soak xanh |

Rollback contract:

1. Set organization `GLOBAL_STOP`, stop claim moi; item `LEASED` hop le quay queue/freeze, item `DISPATCHING` khong co ack sang UNKNOWN.
2. Disable frontend/runtime feature flags, revoke workload/object tickets va stop chi rootless OpenClaw stack.
3. Migrations production la additive/forward-compatible; rollback khong drop bang/evidence. New tables giu inert cho forensics/retention; corrective migration dung forward fix.
4. R2 gateway deny new OpenClaw tickets; giu objects theo retention. Khong xoa session/queue/evidence trong rollback khan cap.
5. Verify pre/post 9Router/CLI container ID, image, StartedAt, RestartCount, network/volume/ports va health; verify `/chat-zalo`, worker cu, `zalo_*` zero DML/dual-write.
6. Reconcile QUEUED/UNKNOWN va audit truoc moi resume. Rollback drill phai hoan thanh trong 30 phut khong restart co-tenant.

## 16. Tich hop repo va pham vi file

Code moi uu tien nam trong:

- `src/pages/openclaw-zalo/`
- `src/components/openclaw-zalo/`
- `src/hooks/openclaw-zalo/`
- `src/lib/openclaw-zalo/`
- `supabase/migrations/` voi chi `openclaw_*` va permission moi
- `services/openclaw-zalo-cell/vendor/zalouser-bridge/` cho fixed npm tarball/mandatory attestation lock, exact 75-blob source acquisition, committed patches, bridge overlay, tests, root `LICENSE`/verbatim upstream notice, reviewed `licenses/manifest.json`, `licenses/<package>@<version>/<original-path>` cho 39 carrier bytes, `FORK.json.artifactMembers`/runtime reachability allowlist, va built internal tgz
- `services/openclaw-zalo-cell/` cho immutable image/install verification/session crypto; khong co thu muc hook package rieng
- `services/openclaw-zalo-bridge/`, `services/openclaw-zalo-maintenance/`, `services/openclaw-egress-broker/` va `infra/openclaw-*` theo implementation plan
- `.e2e-fleet/specs/openclaw-zalo.spec.ts`

Integration additive co the can sua:

- `src/App.tsx`
- `src/components/layout/Sidebar.tsx`
- `src/components/layout/Breadcrumbs.tsx`
- `src/pages/home/launcherTiles.ts`
- `src/lib/permissions.ts` de mo rong `ActionKey` va module catalog
- `src/lib/permissionPages.ts` de hien thi trang/feature permission moi

Nhung file tren dang co the co thay doi khong lien quan cua user; implementation phai doc current state, patch toi thieu, khong revert va stage exact files.

## 17. Tieu chi nghiem thu

Feature chi duoc coi la production-ready khi tat ca dieu sau dung:

- `/openclaw-zalo` hoat dong desktop/mobile voi permissions, loading/error/empty/degraded states va clean console.
- Co the ket noi tai khoan Zalo moi bang QR trong CRM ma khong dung CLI.
- Zalo cu `/chat-zalo`, worker cu va bang `zalo_*` khong bi sua, goi, dual-write hay anh huong khi rollout/rollback.
- Supabase la canonical; moi row tenant-scoped; SQL/RLS 2-org negative tests xanh.
- Browser/cell khong chua `service_role`, generic DB/R2/Gateway admin credential.
- AI chi tao classification/draft; moi send di qua outbox/policy relay.
- Image production chi cai internal verified `@openclaw/zalouser` tgz giu ID/channel `zalouser`; bounded same-registry redirects, fixed tarball URL/size/entry count/SRI/SHA-1, mandatory online attestation/SLSA, exact 75-blob source, root license/notice hashes, approved `licenses/manifest.json`, 38 dependency roots, 39 exact carrier bytes, internal notice inventory, exact artifact-member/runtime-reachability manifests, patch-series SHA-256, built-tgz SHA-256 va architecture-specific image digest khop immutable evidence, khong co registry ZaloUser song song. Offline/network/metadata failure khong duoc tao evidence/artifact hay mo rollout.
- Internal tgz co dung archive entries `package/LICENSE`, `package/THIRD_PARTY_NOTICES.md`, `package/licenses/**` cho compliance files; notice chua verbatim upstream notice + exact 38 package name/version/SPDX inventory + carrier paths + pako exception + Spark-md5 WTFPL selection. Moi member khop exact sorted `FORK.json.artifactMembers` path/type/mode/size/SHA-256; moi runtime-reachable path co trong artifact va khong bi category pruning xoa; khong co unlisted member. Runtime JS/JSON bat buoc duoc giu; dependency source/test/fixture/snapshot/docs/example, moi source map va inline `sourceMappingURL` bi prune/reject. Missing/extra/changed carrier, dependency-root mismatch, notice moi, path/case collision, traversal hoac symlink deu fail gate; clean install/load, upstream-compatible va differential runtime tests deu xanh.
- Reproducible image evidence den tu reviewed helper co Node self-preflight, deny-by-default context chi unignore exact ba committed session dist blobs, exact two-stage Docker/no session build, Node-first network-none local install voi one fresh empty cache, exact fixed epoch, pinned BuildKit/buildx/exporter, `rewrite-timestamp=true`, separate fresh builders, separate pinned base `--pull`, va distinct OCI archives. Verifier so manifest/config/layers, exact input/final-rootfs session hashes, package metadata, promotes exact archive cho checked bundle/load, va reject dirty context, cached/tag-only builds, extra session path, hay artifact missing/tamper. Final rollout phai co reviewed `R29`, qualifying image evidence bind `R29`, evidence-only direct child `E29` chi doi `build-evidence.json`, independent E29 approval, va bundle/deploy identity exact E29; external OCI archive vao bundle bang exact hash, khong vao commit E29. Task 30 reproduce lai image tu detached exact R29 trong khi main context van clean E29, xoa forced worktree an toan, roi tu E29 prove candidate archive/image/installed/session/provenance fields khop committed evidence, final bundle va remote loaded image ma khong tao tracked evidence moi.
- Fork listener commit full inbound envelope/media manifest vao SQLite WAL/FULL truoc internal success/dispatch; provider callback la void/non-awaited, stable provider ID exact dedupe, missing ID at-least-once + collision telemetry, media bytes co the `PENDING`, va khong co zero-loss/provider-ack claim truoc callback.
- Stable-ID precedence/mapping duoc persisted va tenant-scoped; both-present mismatch, cross-kind reuse hoac same-ID/different-payload fail closed + collision audit, trong khi fallback fingerprint chi ap dung khi ca hai stable ID null.
- Built-in replies va pairing/business notifications van tat sau successful commit va sau canonical automation/draft/outbox processing; outbox creation khong tu emit provider frame.
- Moi business send chi qua `zalouser.bridge.send`; exact ordered provider batch authorize ngay truoc first provider I/O. Pre-handoff authorization failure tao zero frames; possible handoff ambiguity tao UNKNOWN va khong auto retry. Stock generic RPC/message/tool/adapter business sends bi deny.
- Model provider doc lap co health/quota/schema gate; ngung 9Router khong lam OpenClaw route AI bi hong va khi model loi auto-send fail closed.
- Inbound reply, manual send, proactive schedule va sales-group schedule/CRM trigger chay trong controlled smoke test.
- Nhom sale chi gui khi exact group ID o allowlist; khong auto-reply chatter.
- UNKNOWN khong auto retry; kill switches co dung precedence va recheck truoc dispatch.
- QR/session/secrets khong xuat hien trong log, Realtime, analytics, local storage, Git hoac automated screenshot/video artifact; live QR chi hien trong authenticated connect view dung TTL.
- Media private, exact-object authorized, SSRF-protected va retention hoat dong.
- Spool/resource caps, health pause, session kick, outage va two-cell fencing da duoc test.
- Vitest/property, type checks, service tests, SQL tests, R2 tests va headless Playwright lien quan xanh.
- Co independent reviewer, rollback drill, runbook provisioning/recovery/rotation va audit evidence.
- Commit chi gom file lien quan va duoc push `origin/main` sau moi gate theo quy uoc repo.

## 18. Rui ro con lai va cach chap nhan

| Rui ro | Xu ly |
|---|---|
| Zalo Personal connector khong chinh thuc, co the thay doi/bi khoa | Canh bao va acknowledgement, tai khoan moi, rollout nho, effective pause, reconnect runbook; khong cam ket zero-risk |
| Send outcome mo ho sau timeout | Trang thai UNKNOWN, khong auto retry, operator reconciliation |
| Prompt injection/noi dung doc hai | AI khong co direct send/tool, structured schema, untrusted-content boundary, tests |
| Cross-tenant leakage | Organization key moi row, composite FK, RLS, scoped workload, 2-org negative tests |
| Spam/gui nham | Consent, suppressions, wizard, hard ceiling, exact target, preview, kill switches |
| VPS/supabase/R2 outage | Fail closed outbound, bounded spool inbound/media, health alert, replaceable runtime |
| Chi phi egress/media tang | Metadata-only Supabase, private R2, cursor/query discipline, retention va usage dashboard |
| Shared-host resource contention voi 9Router | Hard cap OpenClaw 4 vCPU/8 GiB/20 GiB, host guard, baseline latency va rollback rieng; khong sua/restart container cu |
| Root/kernel/VPS compromise anh huong ca OpenClaw va 9Router | Non-root, drop capabilities, no Docker socket, network/secret/volume tach va hardening giam rui ro nhung khong tao trust boundary tuyet doi; day la residual risk duoc chap nhan khi dung chung host |
| Provider event mat truoc callback hoac provider khong replay day du | Khong tuyen bo zero loss truoc callback; sau accepted callback fork doi WAL/FULL commit, incident hien gap window va doi chieu Zalo native/history neu co |
| Ca hai provider stable ID deu thieu gay fingerprint collision | At-least-once semantics, luu payload hash/collision telemetry, quarantine conflict va khong im lang hop nhat hai event khac nhau |
| Fork lech upstream hoac supply-chain drift | Pin fixed tarball URL/size/count/SRI/SHA-1/attestation/SLSA, exact 75-blob git source, root license/notice hashes, 38 dependency roots, 39 exact carriers, committed patch series, reproducible tgz/image hashes, full choke-point tests va independent review moi lan rebase |

## 19. Tai lieu tham khao da kiem tra

- OpenClaw Docker: <https://docs.openclaw.ai/install/docker>
- OpenClaw Zalo Personal channel: <https://docs.openclaw.ai/channels/zalouser>
- Supabase egress: <https://supabase.com/docs/guides/platform/manage-your-usage/egress>
- Supabase database/storage size: <https://supabase.com/docs/guides/platform/manage-your-usage/storage-size>
- Cloudflare R2 pricing: <https://developers.cloudflare.com/r2/pricing/>
- Vultr FAQ/transfer: <https://www.vultr.com/resources/faq/>
- Trang Hermes/VPS do chu san pham cung cap de tham khao: <https://tino.vn/vps-hermes>

Tai lieu tham khao duoc kiem tra ngay 2026-07-26. Ket noi Zalo Personal la unofficial; tai lieu ky thuat khong thay the dieu khoan su dung hien hanh cua Zalo.

---

## 20. Owner approval va chuyen sang implementation

1. Chu san pham da tra loi `Chot phuong an 1` ngay 2026-07-27: vendored integrity-pinned ZaloUser fork giu `@openclaw/zalouser` va ID/channel `zalouser`.
2. Written spec review phai xac nhan lai trust boundaries, exact raw registry/attestation/Sigstore/DSSE/SLSA inputs va hash bindings trong `M`, upstream tarball/75-blob source locks, root notice/license hashes, 38-package/39-carrier compliance inventory, exhaustive dynamic-site reachability, clean exact-`R` export/run gate, vendor file ownership, inbound durability ordering, outbound choke-point coverage va artifact evidence.
3. Sau review xanh, chuyen sang implementation plan 30 task; Task 2 la positive fork gate theo exact checkpoint `M -> R -> E`, va Tasks 3-29 chi mo sau independent review xanh cua evidence-only child `E`.
4. Moi task implementation di theo test-first, verification, independent review va exact-file commit; khong tao VPS moi, khong cham legacy Zalo/9Router/CLI.
