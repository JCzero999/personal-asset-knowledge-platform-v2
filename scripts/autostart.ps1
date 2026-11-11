# 一键拉起本项目的本机依赖（幂等，可重复执行）
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts\autostart.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\autostart.ps1 -Check   只检查，不启动
#   powershell -ExecutionPolicy Bypass -File scripts\autostart.ps1 -App     同时起应用（3000）
#
# 覆盖：Logto（Docker）、RAGFlow（Docker）、LightRAG + embedding（本机 Python）。
# 只负责「拉起」，不做健康等待轮询；调用方可用 -Check 复核。

param(
  [switch]$Check,
  [switch]$App
)

$ErrorActionPreference = "Continue"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$results = @()

function Test-Port([int]$port) {
  $conn = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
  return [bool]$conn
}

function Report([string]$name, [bool]$ok, [string]$detail) {
  $script:results += [pscustomobject]@{ 服务 = $name; 状态 = $(if ($ok) { "up" } else { "down" }); 说明 = $detail }
}

# 1. Docker 栈
$dockerOk = $false
try {
  docker info 2>$null | Out-Null
  $dockerOk = ($LASTEXITCODE -eq 0)
} catch { $dockerOk = $false }

if (-not $Check) {
  if ($dockerOk) {
    docker compose -f "$root\infra\logto\docker-compose.yml" up -d | Out-Null
    docker compose -f "$root\infra\ragflow\docker-compose.yml" up -d | Out-Null
  } else {
    Write-Host "Docker 未运行：请先启动 Docker Desktop，再重跑本脚本。" -ForegroundColor Yellow
  }
}

Report "Logto (3001)" (Test-Port 3001) "docker: logto + logto-postgres"
Report "RAGFlow (9380)" (Test-Port 9380) "docker: ragflow-server / es / mysql / minio / redis"

# 2. LightRAG + embedding（本机 Python）
$lightragUp = Test-Port 9621
$embeddingUp = Test-Port 9381

if (-not $Check -and ((-not $lightragUp) -or (-not $embeddingUp))) {
  & "$root\infra\lightrag\start.ps1" | Out-Null
  Start-Sleep -Seconds 3
  $lightragUp = Test-Port 9621
  $embeddingUp = Test-Port 9381
}

Report "LightRAG embedding (9381)" $embeddingUp "infra/lightrag/start.ps1"
Report "LightRAG server (9621)" $lightragUp "infra/lightrag/start.ps1"

# 3. 可选：应用本身
if ($App) {
  if (-not $Check -and -not (Test-Port 3000)) {
    Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "npm run dev > dev.log 2> dev.err.log" `
      -WorkingDirectory $root -WindowStyle Hidden
    Start-Sleep -Seconds 5
  }
  Report "应用 (3000)" (Test-Port 3000) "npm run dev"
}

$results | Format-Table -AutoSize

$down = @($results | Where-Object { $_.状态 -eq "down" })
if ($down.Count -gt 0) {
  Write-Host ("未就绪：" + (($down | ForEach-Object { $_.服务 }) -join "、")) -ForegroundColor Yellow
  exit 1
}
Write-Host "全部就绪。" -ForegroundColor Green
exit 0
