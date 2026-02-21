$token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJjb250ZW50XzUzNjAxOTRlN2UwMzlkYjBjNmEyYjYwZTFlZTRmNmZiMmViZTE2NTMiLCJ0YXJnZXQiOiJjb250ZW50Iiwia2luZCI6InNpdGUiLCJvcmdhbml6YXRpb24iOiIyb1hNd0dZbjNlUnUwSkNna0lORCIsInNwYWNlcyI6WyJFdU1aTTFSR2tSNTBSa05EYlVrTCJdLCJzaXRlIjoic2l0ZV92SlNmQiIsInNpdGVTcGFjZSI6InNpdGVzcF82c0V3VSIsInNwYWNlIjoiRXVNWk0xUkdrUjUwUmtORGJVa0wiLCJyYXRlTGltaXRNdWx0aXBsaWVyIjoxMDAwMDAwLCJpYXQiOjE3NzE0NTkyMDAsImV4cCI6MTc3MjA2NDMwMH0.WOhLcCPam-pIjqryfepYRLvXmVKZgeOI-VmWThPxN9A"
$headers = @{"Authorization" = "Bearer $token"}

$jsonString = Get-Content "space_content_utf8.json" -Raw
$space = $jsonString | ConvertFrom-Json

$global:pageList = @()

function Get-Pages($nodeList) {
    if (-not $nodeList) { return }
    foreach ($node in $nodeList) {
        if ($node.type -eq 'document') {
            $global:pageList += [PSCustomObject]@{ Id = $node.id; Title = $node.title }
        }
        if ($node.pages) {
            Get-Pages $node.pages
        }
    }
}

Get-Pages $space.pages
Write-Host "Found $($global:pageList.Count) pages."

$outputFile = "resident-docs-offline.md"
if (Test-Path $outputFile) { Remove-Item $outputFile }

# Write a main header
"# Hướng dẫn sử dụng phần mềm Resident`n`n" | Out-File $outputFile -Encoding utf8 -Append

foreach ($page in $global:pageList) {
    Write-Host "Downloading: $($page.Title) ($($page.Id))"
    
    # Write page title
    "`n`n# $($page.Title)`n`n" | Out-File $outputFile -Encoding utf8 -Append
    
    try {
        $response = Invoke-RestMethod -Uri "https://api.gitbook.com/v1/spaces/EuMZM1RGkR50RkNDbUkL/content/page/$($page.Id)?format=markdown" -Headers $headers -ErrorAction Stop
        if ($response.markdown) {
            $response.markdown | Out-File $outputFile -Encoding utf8 -Append
        }
    } catch {
        Write-Host "Failed to download $($page.Id): $_"
    }
    Start-Sleep -Milliseconds 200
}

Write-Host "Done!"
