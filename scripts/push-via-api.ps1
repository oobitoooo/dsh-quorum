# push-via-api.ps1 -- publish local commits through the GitHub REST API when git-over-https is unreachable.
# Only uses api.github.com (the host that still works when github.com:443 is blocked by DNS/hosts).
# It replays the last commits as one squashed commit built from blobs/trees, then updates refs/heads/main.
#
# Usage:
#   $env:GITHUB_TOKEN = '<token>'      # or rely on git credential fill
#   powershell -ExecutionPolicy Bypass -File .\scripts\push-via-api.ps1 -Owner oobitoooo -Repo dsh-quorum -From 69fc899 -Tag v0.4.1

param(
  [string]$Owner = 'oobitoooo',
  [string]$Repo = 'dsh-quorum',
  [string]$ApiIp = '20.205.243.168',
  [string]$From = '',
  [string]$Tag = '',
  [string]$Message = ''
)

$ErrorActionPreference = 'Stop'
$git = 'C:\Program Files\Git\cmd\git.exe'
$base = "https://api.github.com/repos/$Owner/$Repo"
$tmp = [IO.Path]::GetTempPath()

if ([string]::IsNullOrWhiteSpace($env:GITHUB_TOKEN)) {
  $cred = ("protocol=https`nhost=github.com`n`n" | & $git credential fill) -split "`r?`n"
  $env:GITHUB_TOKEN = (($cred | Where-Object { $_ -like 'password=*' }) -replace '^password=','')
}
$token = $env:GITHUB_TOKEN
if ([string]::IsNullOrWhiteSpace($token)) { throw 'no token' }

function Api {
  param([string]$Method, [string]$Path, [string]$BodyPath)
  $out = Join-Path $tmp ("gh-api-" + [guid]::NewGuid().ToString('N') + '.json')
  $argv = @('-sS', '-m', '45', '--resolve', "api.github.com:443:$ApiIp", '-o', $out, '-w', '%{http_code}',
    '-H', "Authorization: Bearer $token", '-H', 'Accept: application/vnd.github+json',
    '-H', 'X-GitHub-Api-Version: 2022-11-28', '-X', $Method)
  if ($BodyPath) { $argv += @('-H', 'Content-Type: application/json', '--data-binary', "@$BodyPath") }
  $argv += ("$base$Path")
  $code = & curl.exe @argv
  $text = if (Test-Path $out) { Get-Content $out -Raw -Encoding UTF8 } else { '' }
  Remove-Item $out -ErrorAction SilentlyContinue
  if ($code -notin @('200', '201')) { throw "API $Method $Path -> HTTP $code : $($text.Substring(0, [Math]::Min(300, $text.Length)))" }
  if ($text) { return ($text | ConvertFrom-Json) }
  return $null
}

function PostJson {
  param([string]$Method, [string]$Path, $Object)
  $f = Join-Path $tmp ("gh-body-" + [guid]::NewGuid().ToString('N') + '.json')
  [IO.File]::WriteAllText($f, ($Object | ConvertTo-Json -Depth 8 -Compress), (New-Object System.Text.UTF8Encoding($false)))
  try { return Api -Method $Method -Path $Path -BodyPath $f }
  finally { Remove-Item $f -ErrorAction SilentlyContinue }
}

if ([string]::IsNullOrWhiteSpace($From)) { $From = (& $git rev-parse 'HEAD~1').Trim() }
if ([string]::IsNullOrWhiteSpace($Message)) { $Message = "sync from local: $From..HEAD" }

Push-Location (Split-Path -Parent $PSScriptRoot)
try {
  # 以「远端当前 head」为基座：本地 HEAD 在 GitHub 上还不存在，不能拿它当 base
  $remoteRef = Api -Method GET -Path '/git/ref/heads/main'
  $remoteSha = $remoteRef.object.sha
  $head = Api -Method GET -Path "/git/commits/$remoteSha"
  $localHead = (& $git rev-parse HEAD).Trim()
  Write-Host "[1/5] remote $remoteSha / local $localHead, base tree $($head.tree.sha)"

  # 远端 commit 是 API 生成的，本地对象库里没有它，不能直接 git diff 它。
  # 有 -From 就用本地锚点；没有就提示用户补一个。
  $anchor = $From
  if ([string]::IsNullOrWhiteSpace($anchor)) {
    & $git cat-file -e "$remoteSha^{commit}" 2>$null
    if ($LASTEXITCODE -ne 0) { throw "remote commit $remoteSha 不在本地，无法算 diff；请用 -From <本地锚点 sha>" }
    $anchor = $remoteSha
  }
  $changed = @(& $git diff --name-only $anchor $localHead) | Where-Object { $_ }
  if ($changed.Count -eq 0) { throw "no changed files between $anchor and $localHead" }
  Write-Host "[2/5] changed files: $($changed.Count) (anchor $anchor)"

  $entries = @()
  foreach ($path in $changed) {
    if (-not (Test-Path $path)) { throw "missing file: $path" }
    $b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes((Resolve-Path $path)))
    $blob = PostJson -Method POST -Path '/git/blobs' -Object @{ content = $b64; encoding = 'base64' }
    $entries += @{ path = $path; mode = '100644'; type = 'blob'; sha = $blob.sha }
    Write-Host "      blob $($blob.sha.Substring(0,8)) $path"
  }

  $tree = PostJson -Method POST -Path '/git/trees' -Object @{ base_tree = $head.tree.sha; tree = $entries }
  Write-Host "[3/5] tree $($tree.sha)"

  $commit = PostJson -Method POST -Path '/git/commits' -Object @{ message = $Message; tree = $tree.sha; parents = @($remoteSha) }
  Write-Host "[4/5] commit $($commit.sha)"

  $ref = PostJson -Method PATCH -Path '/git/refs/heads/main' -Object @{ sha = $commit.sha; force = $false }
  Write-Host "[5/5] refs/heads/main -> $($ref.object.sha)"

  if ($Tag) {
    $tagObj = PostJson -Method POST -Path '/git/tags' -Object @{
      tag = $Tag; message = $Tag; object = $commit.sha; type = 'commit'
    }
    PostJson -Method POST -Path '/git/refs' -Object @{ ref = "refs/tags/$Tag"; sha = $tagObj.sha } | Out-Null
    Write-Host "      tag $Tag -> $($tagObj.sha)"
  }
  Write-Host "DONE https://github.com/$Owner/$Repo/commit/$($commit.sha)"
}
finally { Pop-Location }
