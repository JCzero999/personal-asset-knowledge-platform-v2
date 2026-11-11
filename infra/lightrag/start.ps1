# 启动 LightRAG 链路：embedding 服务 + lightrag-server（Windows PowerShell）
# 用法：cd infra\lightrag; .\start.ps1
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

Start-Process -FilePath "$here\.venv\Scripts\python.exe" `
  -ArgumentList "-m", "uvicorn", "embedding_server:app", "--host", "127.0.0.1", "--port", "9381" `
  -WorkingDirectory $here -WindowStyle Hidden

Start-Sleep -Seconds 2

Start-Process -FilePath "$here\.venv\Scripts\lightrag-server.exe" `
  -WorkingDirectory $here -WindowStyle Hidden

Write-Host "embedding: http://127.0.0.1:9381/health"
Write-Host "lightrag:  http://127.0.0.1:9621/health"
