@echo off
REM Backup production hằng tuần — chạy bởi Windows Task Scheduler.
REM Đăng ký một lần bằng: npm run backup:lap-lich
REM
REM Vì sao cần: ngày 07/08/2026 cơ chế backup hỏng mà không ai biết, chỉ lộ ra
REM khi có người tình cờ chạy thử. Với PITR đã chốt là KHÔNG bật, bản dump này là
REM đường lùi duy nhất cho thao tác đổi schema — nó phải được chạy đều, và phải
REM được KIỂM sau mỗi lần chạy.
cd /d "%~dp0.."
node scripts\backup-before-schema.mjs --reason "backup dinh ky hang tuan" >> "%USERPROFILE%\ihomecrm-backups\nhat-ky.log" 2>&1
node scripts\check-backup-freshness.mjs >> "%USERPROFILE%\ihomecrm-backups\nhat-ky.log" 2>&1
