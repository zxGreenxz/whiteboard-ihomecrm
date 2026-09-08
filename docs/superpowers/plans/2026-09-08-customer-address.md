# Customer address consistency and administrative conversion

**Goal:** Restore full cascading address data in the contract customer dialog, add searchable dropdowns in both customer forms, and show a separate current administrative address derived from the old address.

**Architecture:** Reuse AddressCascadingDropdowns and SearchableSelect; retain legacy province/district/ward codes. A separate read-only panel requests Goong V2 through an authenticated server endpoint. The converted address never replaces saved customer fields. No schema migration or customer backfill.

**Source:** User screenshots and local `n2store/docs/web2/WEB2-ADDRESS-CONVERSION.md`, read 2026-09-08. Goong V2 official documentation confirms new `compound` and optional `deprecated_compound`. Do not fall back to V1 and label it new.

## Constraints
- Worktree: `customer-address-20260908`, base 657ada8e.
- Existing QR/OCR lifecycle and review/apply behavior remain covered by regression tests.
- Search handles Vietnamese with/without accents; keyboard operation and nested dialog scrolling must work.
- Address data requests expose retryable errors; HTTP failure must not become an infinitely cached empty list.
- Conversion displays source address, province, ward and formatted address; supports multiple candidates, no guessed exact match.
- Source edits invalidate prior result immediately. Cancel obsolete requests, enforce bounded timeouts.
- Goong key stays server-side. No names, CCCD numbers, photos or credentials in conversion request/logs. Only address string is sent.
- User authorized copying n2store's Goong key. Retrieved from that project's web2-api service, saved to canonical local vault, and configured as a sensitive Vercel server variable for preview/production. No key in source.
- Headless browser verification; synthetic addresses, DEMO only; no customer writes required.

## Tasks
- [ ] 1. Restore/search legacy dropdowns. Replace hardcoded contract selectors with shared cascade; gender, group and vehicle selectors use SearchableSelect preserving their enum values. Test real search/cascade/error retry and both form integration. Files: AddressCascadingDropdowns, useAddressData, CreateCustomerDialog, CustomerIndividualFields, CustomerVehiclesSection; tests beside components/hooks.
- [ ] 2. Add conversion service and panel. POST `/api/customer-address-conversion`, validate authenticated Supabase user and bounded input, Goong V2 only with deprecated reference, fixed upstream host, no-store, bounded response candidates, explicit errors. Panel chooses permanent address if present, otherwise resolved legacy labels plus detailed address; converts on explicit button, displays separately, clears on edit. Add focused endpoint and component tests including unauthorized, missing key, V2 empty/error, stale response and multiple candidates.
- [ ] 3. Integrate panel below address in CustomerForm and CreateCustomerDialog. Typecheck, relevant existing/new tests, headless both forms and nested dialog, build and inspect assets. Update user docs. Review final diff; gates, main preview CI, official promotion and production smoke per Project Contract.

## Review / measurements
- Root cause confirmed: contract popup hardcodes HN/HCM/DN, district1/district2, ward1/ward2; full form uses useAddressData.
- Reference markdown explicitly does not prove real Goong production behavior. Real validation will be reported separately from mocked API tests.
- Initial GitNexus refresh: 25,217 nodes / 51,571 edges, base 657ada8e; freshness passed medium-risk (UA warning only). `impact AddressCascadingDropdowns`: LOW, zero graph callers; source tracing still required because React JSX consumers exist.
- Live Goong V2 probe with public documentation example: HTTP 200 / OK, one result in 315 ms; old Trung Hòa/Cầu Giấy/Hà Nội -> Yên Hòa/Hà Nội. This is a provider smoke, not a measurement of all customer addresses.
- Conversion focused tests: 20 passed (API 9, client 4, preview lifecycle 7). API and preview observed red before implementation. Auth mutation: source digest 1421a9edf8ae -> 8bd91ca82916, forged-session assertion failed, helper restored 1421a9edf8ae.
