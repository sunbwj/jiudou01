# =============================================================================
#  tools\start-server.ps1 —— menu-admin 后台启动（由 start.bat 以隐藏窗口调用）
#  ---------------------------------------------------------------------------
#  · 负责：结束 8808 旧实例 / 日志轮转 / 环境校验 / 前台托管 python 进程；
#  · python 的 stdout+stderr 直接追加写入 logs\server.log（不经 PowerShell 转码）；
#  · 日志文件在服务运行期间被 python 独占，所以「先结束旧实例 → 再写日志」；
#  · 进程运行在隐藏控制台里，用户看不到命令行窗口；停止用 stop.bat。
# =============================================================================

$ErrorActionPreference = 'Continue'

$root = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $root 'logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$log = Join-Path $logDir 'server.log'

$python = 'C:\Users\chx\.workbuddy\binaries\python\envs\menuadmin\Scripts\python.exe'
$app = Join-Path $root 'server\app.py'

function Add-Log([string]$msg) {
    $line = ('[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg)
    try {
        Add-Content -LiteralPath $log -Value $line -Encoding UTF8 -ErrorAction Stop
    } catch {
        Start-Sleep -Milliseconds 300
        try { Add-Content -LiteralPath $log -Value $line -Encoding UTF8 -ErrorAction Stop } catch { }
    }
}

# ---- 1. 结束占用 8808 的旧实例（旧实例会独占日志文件，必须先结束）----
$oldIds = @()
$conns = @()
try { $conns = Get-NetTCPConnection -LocalPort 8808 -State Listen -ErrorAction Stop } catch { $conns = @() }
if ($conns) {
    $oldIds = $conns | Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($i in $oldIds) { Stop-Process -Id $i -Force -ErrorAction SilentlyContinue }
    $waited = 0
    while ($waited -lt 3000) {
        Start-Sleep -Milliseconds 200
        $waited += 200
        $still = @()
        try { $still = Get-NetTCPConnection -LocalPort 8808 -State Listen -ErrorAction Stop } catch { $still = @() }
        if (-not $still) { break }
    }
}

# ---- 2. 日志轮转：超过 5MB 归档为 server.log.1 ----
if (Test-Path $log) {
    if ((Get-Item -LiteralPath $log).Length -gt 5MB) {
        $bak = "$log.1"
        if (Test-Path $bak) { Remove-Item $bak -Force -ErrorAction SilentlyContinue }
        Move-Item -LiteralPath $log -Destination $bak -Force -ErrorAction SilentlyContinue
    }
}

# ---- 3. 写启动标记 ----
Add-Log ''
Add-Log '===== start.bat 启动服务（端口 8808 · 隐藏后台运行）====='
Add-Log ('[INFO] 工程目录: ' + $root)
if ($oldIds.Count -gt 0) {
    Add-Log ('[INFO] 已结束旧实例 PID: ' + ($oldIds -join ','))
} else {
    Add-Log '[INFO] 端口 8808 空闲'
}

if (-not (Test-Path $python)) {
    Add-Log ('[ERROR] 未找到 Python 解释器: ' + $python)
    Add-Log '[ERROR] 请修改 tools\start-server.ps1 里的 $python 变量'
    exit 1
}
if (-not (Test-Path $app)) {
    Add-Log ('[ERROR] 未找到 server\app.py: ' + $app)
    exit 1
}

$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'
$env:PYTHONUNBUFFERED = '1'
Set-Location $root

Add-Log ('[INFO] Python: ' + $python)
Add-Log '[INFO] 服务启动中: http://127.0.0.1:8808/   停止请双击 stop.bat'
Add-Log '---------------------------------------------------------------'

# 用 cmd 做重定向：python 的原始字节直写日志，避免 PowerShell 重新编码
& cmd.exe /c "`"$python`" `"$app`" >> `"$log`" 2>&1"
$code = $LASTEXITCODE

Add-Log '---------------------------------------------------------------'
Add-Log ('===== 服务已退出（exit code ' + $code + '）=====')
exit $code
