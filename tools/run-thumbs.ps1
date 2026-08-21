# 대시보드 썸네일 자동 갱신 런너 (작업 스케줄러용)
# 서비스롤 키는 mustit-orders\.env 에서 읽어 주입(스크립트엔 비밀 없음)
$ErrorActionPreference = 'Stop'
$envFile = 'C:\Users\ceo\projects\mustit-orders\.env'
$line = Select-String -Path $envFile -Pattern '^SUPABASE_SERVICE_ROLE_KEY=' | Select-Object -First 1
if (-not $line) { Write-Error 'SUPABASE_SERVICE_ROLE_KEY not found in .env'; exit 1 }
$env:SUPABASE_SERVICE_ROLE_KEY = ($line.Line -replace '^SUPABASE_SERVICE_ROLE_KEY=', '').Trim().Trim('"')
$here = 'C:\Users\ceo\projects\mustit-data-portal-dashboards\tools'
Set-Location $here
$stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
"[$stamp] start" | Out-File -FilePath "$here\thumbs.log" -Append -Encoding utf8
node gen-thumbs.mjs *>> "$here\thumbs.log"
"[$stamp] done (exit $LASTEXITCODE)" | Out-File -FilePath "$here\thumbs.log" -Append -Encoding utf8
