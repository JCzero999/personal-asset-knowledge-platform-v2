# 在「启动」文件夹里创建/移除本项目的开机自启快捷方式（无需管理员）
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1 -Remove

param([switch]$Remove)

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$startup = [Environment]::GetFolderPath("Startup")
$link = Join-Path $startup "PAKP Autostart.lnk"

if ($Remove) {
  if (Test-Path $link) { Remove-Item $link -Force; Write-Host "已移除：$link" }
  else { Write-Host "没有找到自启快捷方式。" }
  exit 0
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($link)
$shortcut.TargetPath = "powershell.exe"
$shortcut.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$root\scripts\autostart.ps1`""
$shortcut.WorkingDirectory = $root
$shortcut.WindowStyle = 7
$shortcut.Description = "拉起 Logto / RAGFlow / LightRAG"
$shortcut.Save()
Write-Host "已创建：$link"
