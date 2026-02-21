$ErrorActionPreference = "Stop"
$token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJjb250ZW50XzUzNjAxOTRlN2UwMzlkYjBjNmEyYjYwZTFlZTRmNmZiMmViZTE2NTMiLCJ0YXJnZXQiOiJjb250ZW50Iiwia2luZCI6InNpdGUiLCJvcmdhbml6YXRpb24iOiIyb1hNd0dZbjNlUnUwSkNna0lORCIsInNwYWNlcyI6WyJFdU1aTTFSR2tSNTBSa05EYlVrTCJdLCJzaXRlIjoic2l0ZV92SlNmQiIsInNpdGVTcGFjZSI6InNpdGVzcF82c0V3VSIsInNwYWNlIjoiRXVNWk0xUkdrUjUwUmtORGJVa0wiLCJyYXRlTGltaXRNdWx0aXBsaWVyIjoxMDAwMDAwLCJpYXQiOjE3NzE0NTkyMDAsImV4cCI6MTc3MjA2NDMwMH0.WOhLcCPam-pIjqryfepYRLvXmVKZgeOI-VmWThPxN9A"
$headers = @{"Authorization" = "Bearer $token"}

$jsonString = Get-Content "space_content_utf8.json" -Raw
$space = $jsonString | ConvertFrom-Json

$outputDir = "resident-docs"
if (Test-Path $outputDir) { Remove-Item -Force -Recurse $outputDir }
New-Item -ItemType Directory -Force -Path $outputDir | Out-Null

$global:summaryContent = "# Bảng Mục Lục (Table of Contents)`n`n"

function Process-Nodes($nodes, $indent) {
    if (-not $nodes) { return }
    foreach ($node in $nodes) {
        $filePath = $node.path
        if ([string]::IsNullOrEmpty($filePath) -or $filePath -eq "/") {
            $filePath = "README.md"
        } else {
            $filePath = "$filePath.md"
        }
        
        $global:summaryContent += "$indent- [$($node.title)]($filePath)`n"
        
        if ($node.type -eq 'document') {
            $fullPath = Join-Path $outputDir $filePath
            $parentDir = Split-Path $fullPath
            if (-not (Test-Path $parentDir)) {
                New-Item -ItemType Directory -Force -Path $parentDir | Out-Null
            }
            
            Write-Host "Downloading: $($node.title) -> $filePath"
            try {
                $response = Invoke-RestMethod -Uri "https://api.gitbook.com/v1/spaces/EuMZM1RGkR50RkNDbUkL/content/page/$($node.id)?format=markdown" -Headers $headers
                if ($response.markdown) {
                    $response.markdown | Out-File $fullPath -Encoding utf8
                } else {
                    "" | Out-File $fullPath -Encoding utf8
                }
            } catch {
                Write-Host "Failed to download $($node.title). Error: $_"
                "" | Out-File $fullPath -Encoding utf8
            }
            Start-Sleep -Milliseconds 200
        }
        
        if ($node.pages) {
            Process-Nodes $node.pages "$indent  "
        }
    }
}

Write-Host "Starting extraction..."
Process-Nodes $space.pages ""

$summaryPath = Join-Path $outputDir "SUMMARY.md"
$global:summaryContent | Out-File $summaryPath -Encoding utf8
Write-Host "Written SUMMARY.md. Entire process complete!"
