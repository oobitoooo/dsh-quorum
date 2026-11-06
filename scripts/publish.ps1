# publish.ps1 —— 把 dsh-council 推上 GitHub（本机 GitHub 被 hosts 指到 127.0.0.1，所以全程用 --resolve 绕 DNS）
#
# 用法（token 只从环境变量读，不落盘）：
#   $env:GITHUB_TOKEN = "ghp_xxx"      # classic token，勾 repo；或 fine-grained：Contents + Administration 写
#   powershell -ExecutionPolicy Bypass -File .\scripts\publish.ps1
#   可选参数：-Owner <账号> -Repo <仓库名> -Private
#
# 做三件事：
#   1) 调 API 建仓（已存在则跳过）
#   2) 配 origin 为带 token 的 https 地址（token 只写进 .git/config 的 remote，脚本结束后可自行改回）
#   3) push main，并打印仓库地址

param(
  [string]$Owner = 'oobitoooo',
  [string]$Repo = 'dsh-council',
  [string]$Token = $env:GITHUB_TOKEN,
  [string]$ApiIp = '140.82.112.5',
  [string]$GitIp = '140.82.112.4',
  [switch]$Private
)

$ErrorActionPreference = 'Stop'
$git = 'C:\Program Files\Git\cmd\git.exe'
if (-not (Test-Path $git)) { $git = 'git' }

if ([string]::IsNullOrWhiteSpace($Token)) {
  throw '缺少 GITHUB_TOKEN：先 $env:GITHUB_TOKEN = "ghp_..." 再跑本脚本'
}

$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot
try {
  # 1) 建仓（HTTP 422/409 = 已存在，直接继续）
  $payload = @{
    name        = $Repo
    description = 'DSH 插件：虚拟内阁多 Agent 辩论评审（上下文沙箱 / 三维评分与动态权重 / 3 轮熔断 / 只回 Markdown 摘要）'
    private     = [bool]$Private
    has_issues  = $true
    has_wiki    = $false
  } | ConvertTo-Json -Compress

  $tmp = Join-Path $env:TEMP "gh-create-$([guid]::NewGuid().ToString('N')).json"
  $code = & curl.exe -sS -m 30 --resolve "api.github.com:443:$ApiIp" `
    -o $tmp -w '%{http_code}' `
    -H "Authorization: Bearer $Token" `
    -H 'Accept: application/vnd.github+json' `
    -H 'X-GitHub-Api-Version: 2022-11-28' `
    -X POST -d $payload `
    "https://api.github.com/user/repos"
  Write-Host "[1/3] 建仓 -> HTTP $code"
  if ($code -notin @('201', '422')) {
    Write-Host (Get-Content $tmp -Raw -Encoding UTF8)
    throw "建仓失败：HTTP $code"
  }
  Remove-Item $tmp -ErrorAction SilentlyContinue

  # 2) origin（token 走 extraHeader，不写进 remote URL）
  $b64 = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("x-access-token:$Token"))
  $remote = "https://github.com/$Owner/$Repo.git"
  & $git remote remove origin 2>$null | Out-Null
  & $git remote add origin $remote

  # 3) push main
  Write-Host "[2/3] push -> $remote"
  & $git -c "http.curloptResolve=github.com:443:$GitIp" -c "http.extraHeader=AUTHORIZATION: basic $b64" `
    push -u origin HEAD:main 2>&1 | Select-Object -Last 6
  if ($LASTEXITCODE -ne 0) { throw "push 失败（退出码 $LASTEXITCODE）" }

  Write-Host "[3/3] 完成：https://github.com/$Owner/$Repo"
}
finally {
  Pop-Location
}
