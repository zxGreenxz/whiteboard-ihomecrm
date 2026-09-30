# SheetJS Community Edition

`xlsx-0.20.3.tgz` is the unmodified package published by SheetJS, vendored so clean installs do not depend on CDN availability. Application imports remain `import('xlsx')` and lazy loaded.

- Authoritative source: https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz
- Installation guidance: https://docs.sheetjs.com/docs/getting-started/installation/nodejs/#vendoring
- Retrieved: 2026-09-30 (HTTPS GET, redirects rejected).
- Size: 2,409,319 bytes; 26 regular file entries, all under `package/`.
- SHA256: `8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8`
- SRI: `sha512-oLDq3jw7AcLqKWH2AhCpVTZl8mf6X2YReP+Neh0SJUzV/BdZYjth94tG5toiMB1PPrYtxOCfaoUCkvtuH+3AJA==`
- License: Apache-2.0, included as `package/LICENSE` in the archive.
- Manifest: `xlsx@0.20.3`, no dependencies, no preinstall/install/postinstall scripts.

The digests above were computed from the retrieved bytes, not an independently signed vendor attestation. `package-lock.json` pins the same SHA512 integrity. Future replacements require reviewing the new bytes and lockfile, rather than overwriting this version.

This replaces the unmaintained npm release `0.18.5`. The vendor advisories document fixes in `0.19.3` for [CVE-2023-30533](https://cdn.sheetjs.com/advisories/CVE-2023-30533) and `0.20.2` for [CVE-2024-22363](https://cdn.sheetjs.com/advisories/CVE-2024-22363). The expired XLSX acknowledgment is removed only with this package update; other baseline entries retain their existing scope and expiry.

Compatibility fixtures under `src/lib/__tests__/fixtures/sheetjs-0.18.5/` were generated with the old library and contain synthetic data. Tests read both BIFF8 `.xls` and `.xlsx` through the actual application parsers, retaining Unicode, textual identifiers, signed VND amounts, contract dates/cycles, template headers and validation row numbers. Workbook export is verified by writing and reading real bytes.
