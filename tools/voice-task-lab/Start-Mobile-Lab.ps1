param([switch]$CaptureOnly)
$ErrorActionPreference = 'Stop'

# A user-invoked launcher. No existing server is stopped or replaced.
$labRepo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$labDist = Join-Path $PSScriptRoot 'dist/index.html'
if (-not (Test-Path -LiteralPath $labDist)) { throw 'Cần chạy npm run voice-lab:build trong worktree trước.' }
if (Get-NetTCPConnection -LocalPort 4179 -State Listen -ErrorAction SilentlyContinue) { throw 'Cổng 4179 đang được dùng. Không tự dừng tiến trình khác.' }
$labRoot = Join-Path $env:LOCALAPPDATA 'iHomeCRM/voice-task-lab'
$labRun = Join-Path $labRoot ('runtime-' + [DateTime]::Now.ToString('yyyyMMdd-HHmmss'))
$labBin = Join-Path $labRoot 'bin'
New-Item -ItemType Directory -Force -Path $labRun, $labBin | Out-Null
$labTunnelExe = Join-Path $labBin 'cloudflared-2026.9.3.exe'
if (-not (Test-Path -LiteralPath $labTunnelExe)) {
  Invoke-WebRequest -Uri 'https://github.com/cloudflare/cloudflared/releases/download/2026.9.3/cloudflared-windows-amd64.exe' -OutFile $labTunnelExe
}
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $labTunnelExe).Hash.ToLowerInvariant() -ne 'f096265ec2fcbe9bb6e2d64268db167ced3fcbb83d894bdb9e2fcdb26f2ea7e2') { throw 'Checksum cloudflared không khớp; dừng.' }
$labNode = (Get-Command node -ErrorAction Stop).Source
$labLog = Join-Path $labRun 'tunnel.log'
$labTunnelProcess = Start-Process -FilePath $labTunnelExe -ArgumentList @('tunnel','--no-autoupdate','--url','http://127.0.0.1:4179','--protocol','http2') -WindowStyle Hidden -PassThru -RedirectStandardError $labLog -RedirectStandardOutput (Join-Path $labRun 'tunnel.out.log')
try {
  $labOrigin = $null
  for ($labAttempt = 0; $labAttempt -lt 60; $labAttempt++) {
    Start-Sleep -Milliseconds 500
    if (Test-Path -LiteralPath $labLog) {
      $labMatch = [regex]::Match((Get-Content -Raw -LiteralPath $labLog), 'https://[a-z0-9-]+\.trycloudflare\.com')
      if ($labMatch.Success) { $labOrigin = $labMatch.Value; break }
    }
    if ($labTunnelProcess.HasExited) { throw 'Tunnel chưa khởi động được; xem log cục bộ.' }
  }
  if (-not $labOrigin) { throw 'Không nhận được địa chỉ HTTPS của tunnel.' }
  $env:VOICE_LAB_PUBLIC_ORIGIN = $labOrigin
  $labRandom = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $labCodeBytes = New-Object byte[] 4
    do {
      $labRandom.GetBytes($labCodeBytes)
      $labCodeNumber = [BitConverter]::ToUInt32($labCodeBytes, 0)
    } while ($labCodeNumber -ge 4230000000)
    $env:VOICE_LAB_ACCESS_CODE = [string](10000000 + ($labCodeNumber % 90000000))
  } finally { $labRandom.Dispose() }
  $env:VOICE_LAB_DATA_DIR = Join-Path $labRoot 'results-20260926'
  $env:VOICE_LAB_CAPTURE_ONLY = if ($CaptureOnly) { '1' } else { '0' }
  $labServerProcess = Start-Process -FilePath $labNode -ArgumentList @('tools/voice-task-lab/run-local.mjs') -WorkingDirectory $labRepo -WindowStyle Hidden -PassThru -RedirectStandardError (Join-Path $labRun 'server.err.log') -RedirectStandardOutput (Join-Path $labRun 'server.out.log')
  Start-Sleep -Seconds 2
  if ($labServerProcess.HasExited) { throw 'Máy chủ chưa khởi động được; xem server.err.log (không chứa khóa API).' }
  Write-Host ('Mở trên điện thoại: ' + $labOrigin)
  Write-Host ('Mã truy cập: ' + $env:VOICE_LAB_ACCESS_CODE)
  Write-Host ('Máy chủ PID: ' + $labServerProcess.Id + ' | Tunnel PID: ' + $labTunnelProcess.Id)
  Write-Host ('Dữ liệu đánh giá: ' + $env:VOICE_LAB_DATA_DIR)
  Write-Host 'Giữ máy tính hoạt động trong lúc thử. Đường dẫn tạm sẽ đổi khi chạy lại.'
} catch {
  if (-not $labTunnelProcess.HasExited) { Stop-Process -Id $labTunnelProcess.Id }
  throw
} finally {
  Remove-Item Env:VOICE_LAB_ACCESS_CODE -ErrorAction SilentlyContinue
}
