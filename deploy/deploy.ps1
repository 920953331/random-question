<#
.SYNOPSIS
  把「知识点复习系统」部署到腾讯云服务器。

.DESCRIPTION
  流程：本地跑测试 → 打包 → scp 上传 → ssh 远程安装（写 systemd 服务并启动）。

.PARAMETER ServerHost
  服务器公网 IP 或域名（必填）。

.PARAMETER ServerUser
  SSH 用户名，默认 root。

.PARAMETER SshPort
  SSH 端口，默认 22。

.PARAMETER SshKey
  私钥文件路径（推荐）。不指定则使用默认密钥或交互式密码。

.PARAMETER RegisterCode
  注册口令（必填）。写在服务器 systemd 配置里，注册账号时需要。

.PARAMETER AppPort
  服务监听端口，默认 8080。

.PARAMETER SkipTests
  跳过本地测试（不推荐）。

.EXAMPLE
  pwsh -File deploy/deploy.ps1 -ServerHost 1.2.3.4 -ServerUser root `
       -SshKey "$env:USERPROFILE\.ssh\id_ed25519" -RegisterCode "my-secret-code"
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$ServerHost,
  [string]$ServerUser = "root",
  [int]$SshPort = 22,
  [string]$SshKey = "",
  [Parameter(Mandatory = $true)][string]$RegisterCode,
  [int]$AppPort = 8080,
  [switch]$SkipTests,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$WS = Split-Path -Parent $PSScriptRoot
Set-Location $WS

$tarball = Join-Path $env:TEMP "random-question.tar.gz"
$remoteTmp = "/tmp/random-question"

function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }

# 组装 ssh / scp 公共参数
$sshArgs = @("-p", "$SshPort", "-o", "StrictHostKeyChecking=accept-new")
$scpArgs = @("-P", "$SshPort", "-o", "StrictHostKeyChecking=accept-new")
if ($SshKey -and (Test-Path $SshKey)) {
  $sshArgs += @("-i", $SshKey)
  $scpArgs += @("-i", $SshKey)
}
$remote = "$ServerUser@$ServerHost"

Write-Host "部署目标: $remote (SSH $SshPort)  应用端口: $AppPort"

# ---------------------------------------------------------------- 1. 测试
if (-not $SkipTests) {
  Write-Step "1/5 本地运行测试"
  node tests/test_stages.mjs
  if ($LASTEXITCODE -ne 0) { throw "算法测试未通过，已中止部署" }
  node tests/test_api.mjs
  if ($LASTEXITCODE -ne 0) { throw "接口测试未通过，已中止部署" }
} else {
  Write-Step "1/5 已跳过测试"
}

# ---------------------------------------------------------------- 2. 打包
Write-Step "2/5 打包代码"
if (Test-Path $tarball) { Remove-Item $tarball -Force }

# 要包含的内容
$includes = @("server", "web", "data", "deploy", "package.json", "README.md", "docs")
$existing = $includes | Where-Object { Test-Path (Join-Path $WS $_) }
Write-Host "    包含: $($existing -join ', ')"

# 用 tar 打包（Windows 10+ 自带 bsdtar）
$tarArgs = @("-czf", $tarball) + $existing
& tar @tarArgs
if ($LASTEXITCODE -ne 0) { throw "打包失败" }
$sizeKB = [math]::Round((Get-Item $tarball).Length / 1KB, 1)
Write-Host "    已生成: $tarball ($sizeKB KB)"

# ---------------------------------------------------------------- 3. 上传
Write-Step "3/5 上传到服务器 $remoteTmp"
if ($DryRun) {
  Write-Host "    [DryRun] scp $tarball ${remote}:$remoteTmp.tar.gz" -ForegroundColor Yellow
} else {
  & scp @scpArgs $tarball "${remote}:$remoteTmp.tar.gz"
  if ($LASTEXITCODE -ne 0) { throw "上传失败（检查 IP / 端口 / 密钥 / 安全组）" }
  Write-Host "    上传完成"
}

# ---------------------------------------------------------------- 4. 远程安装
Write-Step "4/5 远程安装（解包 + 写入 systemd + 启动）"

# 安装脚本需要写 /etc/systemd/system，非 root 用户需加 sudo。
# 服务器上 ubuntu 等账号通常是免密 sudo，故用 sudo -n（非交互）。
$sudoPrefix = if ($ServerUser -eq "root") { "" } else { "sudo -n " }
if ($sudoPrefix) { Write-Host "    使用 $ServerUser 用户，将用 sudo -n 提权" }

$remoteCmd = @(
  "set -e",
  "rm -rf $remoteTmp",
  "mkdir -p $remoteTmp",
  "tar -xzf $remoteTmp.tar.gz -C $remoteTmp",
  "${sudoPrefix}env REGISTER_CODE='$RegisterCode' PORT=$AppPort bash $remoteTmp/deploy/install-on-server.sh $remoteTmp"
) -join " && "

if ($DryRun) {
  Write-Host "    [DryRun] ssh $remote `"$remoteCmd`"" -ForegroundColor Yellow
} else {
  & ssh @sshArgs $remote $remoteCmd
  if ($LASTEXITCODE -ne 0) { throw "远程安装失败，请查看上面的输出" }
}

# ---------------------------------------------------------------- 5. 验证
Write-Step "5/5 验证"
if ($DryRun) {
  Write-Host "    [DryRun] 跳过验证" -ForegroundColor Yellow
} else {
  Start-Sleep -Seconds 2
  try {
    $url = "http://${ServerHost}:${AppPort}/api/health"
    $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 15
    Write-Host "    健康检查 $url -> $($r.StatusCode)" -ForegroundColor Green
    Write-Host "    $($r.Content)"
  } catch {
    Write-Warning "外网健康检查失败: $($_.Exception.Message)"
    Write-Host "    可能原因：腾讯云安全组未放行 $AppPort 端口。" -ForegroundColor Yellow
    Write-Host "    可在服务器上执行： curl -s http://127.0.0.1:$AppPort/api/health" -ForegroundColor Yellow
  }
  Write-Host ""
  Write-Host "==================== 部署完成 ====================" -ForegroundColor Green
  Write-Host " 访问地址: http://${ServerHost}:${AppPort}/"
  Write-Host " 注册口令: $RegisterCode"
  Write-Host "=================================================" -ForegroundColor Green
}
