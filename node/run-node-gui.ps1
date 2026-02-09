# P2P 节点图形化启动器（Windows）
# 双击或 PowerShell 运行: .\run-node-gui.ps1
# 在窗口输入领奖钱包地址后点击「启动节点」

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$nodeDir = $PSScriptRoot
$savedAddrPath = Join-Path $nodeDir ".last-reward-wallet.txt"

function Test-RewardWallet {
    param([string]$addr)
    $a = $addr.Trim()
    if ($a -eq "") { return $false }
    if (-not $a.StartsWith("0x") -or $a.Length -ne 42) { return $false }
    $hex = $a.Substring(2)
    return $hex -match '^[0-9a-fA-F]{40}$'
}

$form = New-Object System.Windows.Forms.Form
$form.Text = "P2P 节点启动"
$form.Size = New-Object System.Drawing.Size(440, 220)
$form.StartPosition = "CenterScreen"
$form.FormBorderStyle = "FixedDialog"
$form.MaximizeBox = $false
$form.MinimizeBox = $true

$lbl = New-Object System.Windows.Forms.Label
$lbl.Location = New-Object System.Drawing.Point(20, 22)
$lbl.Size = New-Object System.Drawing.Size(360, 20)
$lbl.Text = "领奖钱包地址（必填，0x 开头 42 字符）："
$form.Controls.Add($lbl)

$txt = New-Object System.Windows.Forms.TextBox
$txt.Location = New-Object System.Drawing.Point(20, 46)
$txt.Size = New-Object System.Drawing.Size(360, 24)
$txt.Font = New-Object System.Drawing.Font("Consolas", 10)
# 若曾保存过则预填
if (Test-Path $savedAddrPath) {
    try {
        $last = (Get-Content $savedAddrPath -Raw -ErrorAction SilentlyContinue).Trim()
        if (Test-RewardWallet $last) { $txt.Text = $last }
    } catch {}
}
$form.Controls.Add($txt)

$chk = New-Object System.Windows.Forms.CheckBox
$chk.Location = New-Object System.Drawing.Point(20, 78)
$chk.Size = New-Object System.Drawing.Size(260, 22)
$chk.Text = "记住地址（下次自动填充）"
$chk.Checked = $true
$form.Controls.Add($chk)

$btn = New-Object System.Windows.Forms.Button
$btn.Location = New-Object System.Drawing.Point(20, 108)
$btn.Size = New-Object System.Drawing.Size(120, 32)
$btn.Text = "启动节点"
$btn.Font = New-Object System.Drawing.Font($null, 10)
$form.Controls.Add($btn)

$btnCancel = New-Object System.Windows.Forms.Button
$btnCancel.Location = New-Object System.Drawing.Point(150, 108)
$btnCancel.Size = New-Object System.Drawing.Size(100, 32)
$btnCancel.Text = "取消"
$form.Controls.Add($btnCancel)

$btnUpdate = New-Object System.Windows.Forms.Button
$btnUpdate.Location = New-Object System.Drawing.Point(260, 108)
$btnUpdate.Size = New-Object System.Drawing.Size(120, 32)
$btnUpdate.Text = "检查更新"
$form.Controls.Add($btnUpdate)

$btn.Click += {
    $addr = $txt.Text.Trim()
    if (-not (Test-RewardWallet $addr)) {
        [System.Windows.Forms.MessageBox]::Show(
            "请输入有效的领奖钱包地址（0x 开头、共 42 字符的十六进制）。",
            "地址无效",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Warning
        )
        return
    }
    if ($chk.Checked) {
        try { Set-Content -Path $savedAddrPath -Value $addr -Encoding UTF8 -ErrorAction Stop } catch {}
    } else {
        try { if (Test-Path $savedAddrPath) { Remove-Item $savedAddrPath -Force } } catch {}
    }
    $form.Close()
    $cmd = "Set-Location '$nodeDir'; .\run.ps1 -rewardWallet '$addr'"
    Start-Process powershell -ArgumentList "-NoExit", "-Command", $cmd
}

$btnUpdate.Click += {
    $updateScript = Join-Path $nodeDir "update-and-restart.ps1"
    if (-not (Test-Path $updateScript)) {
        [System.Windows.Forms.MessageBox]::Show("未找到 update-and-restart.ps1。", "检查更新", [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Warning)
        return
    }
    try {
        $out = & powershell -NoProfile -ExecutionPolicy Bypass -File $updateScript 2>&1 | Out-String
        [System.Windows.Forms.MessageBox]::Show("$out", "自动更新", [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Information)
    } catch {
        [System.Windows.Forms.MessageBox]::Show("更新失败: $($_.Exception.Message)", "自动更新", [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Error)
    }
}

$btnCancel.Click += { $form.Close() }
$form.CancelButton = $btnCancel
$form.Add_Shown({ $txt.Select() })
[void] $form.ShowDialog()
