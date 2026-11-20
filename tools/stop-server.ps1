# =============================================================================
#  tools\stop-server.ps1 —— 停止 menu-admin（结束占用 8808 的进程并记日志）
#  ---------------------------------------------------------------------------
#  日志文件在服务运行期间被 python 独占，因此「先结束进程 → 再写停止标记」。
# =============================================================================

$ErrorActionPreference = 'Continue'

$root = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $root 'logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$log = Join-Path $logDir 'server.log'

function Add-Log([string]$msg) {
    $line = ('[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg)
    try {
        Add-Content -LiteralPath $log -Value $line -Encoding UTF8 -ErrorAction Stop
    } catch {
        Start-Sleep -Milliseconds 300
        try { Add-Content -LiteralPath $log -Value $line -Encoding UTF8 -ErrorAction Stop } catch { }
    }
}

$conns = @()
try { $conns = Get-NetTCPConnection -LocalPort 8808 -State Listen -ErrorAction Stop } catch { $conns = @() }

if (-not $conns) {
    Write-Host '[提示] 端口 8808 上没有正在运行的服务。'
    Add-Log ''
    Add-Log '===== stop.bat 停止服务 ====='
    Add-Log '[INFO] 端口 8808 没有在运行的服务'
    Write-Host ('日志文件：' + $log)
    exit 0
}

$ids = $conns | Select-Object -ExpandProperty OwningProcess -Unique
foreach ($i in $ids) { Stop-Process -Id $i -Force -ErrorAction SilentlyContinue }

# 等待端口真正释放（最多 3 秒），同时等日志文件句柄回收
$waited = 0
$left = @()
while ($waited -lt 3000) {
    Start-Sleep -Milliseconds 200
    $waited += 200
    try { $left = Get-NetTCPConnection -LocalPort 8808 -State Listen -ErrorAction Stop } catch { $left = @() }
    if (-not $left) { break }
}

Add-Log ''
Add-Log '===== stop.bat 停止服务 ====='
if ($left) {
    Write-Host '[错误] 端口 8808 仍被占用，请手动结束该进程。'
    Add-Log ('[ERROR] 端口 8808 仍被占用（PID: ' + (($left | Select-Object -ExpandProperty OwningProcess -Unique) -join ',') + '）')
} else {
    Write-Host ('[完成] 服务已停止（PID: ' + ($ids -join ',') + '）。')
    Add-Log ('[INFO] 服务已停止，结束 PID: ' + ($ids -join ','))
}

Write-Host ('日志文件：' + $log)
exit 0
