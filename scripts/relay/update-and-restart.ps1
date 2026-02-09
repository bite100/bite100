# 一键自动更新并重启中继节点（可放入 Windows 计划任务）
# 建议: 每日或每周运行一次
# 计划任务示例: 程序 powershell.exe，参数 -File "D:\P2P\scripts\relay\update-and-restart.ps1"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
& (Join-Path $ScriptDir "run-relay.ps1") -AutoUpdate
