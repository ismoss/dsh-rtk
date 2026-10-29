# 把 dsh-rtk 装进 dsh profile：源码落两份（权威副本 + 运行副本），并确保 cordis.patch.yml 里有挂载条目。
# 用法：.\install.ps1 [-Profile desktop]
param(
	[string]$Profile = "desktop"
)

$ErrorActionPreference = "Stop"

$source = Split-Path -Parent $PSCommandPath
$profileDir = Join-Path $env:USERPROFILE ".dsh\profiles\$Profile"
if (-not (Test-Path $profileDir)) {
	throw "找不到 profile 目录：$profileDir（确认 dsh 里建过这个 profile）"
}

$canonical = Join-Path $env:USERPROFILE ".dsh\plugins\dsh-rtk"
$target = Join-Path $profileDir "node_modules\dsh-rtk"

New-Item -ItemType Directory -Force -Path $canonical, $target | Out-Null

# 只复制插件本体，跳过 .git 之类的开发残留
function Copy-Plugin($from, $to) {
	Get-ChildItem -Force $from | Where-Object { $_.Name -notin @('.git', '.gitignore', 'node_modules') } | ForEach-Object {
		Copy-Item -Recurse -Force $_.FullName (Join-Path $to $_.Name)
	}
}

Copy-Plugin $source $canonical
Copy-Plugin $canonical $target
Write-Host "已复制: $canonical"
Write-Host "已复制: $target"

$patch = Join-Path $profileDir "cordis.patch.yml"
if (-not (Test-Path $patch)) {
	New-Item -ItemType File -Force -Path $patch | Out-Null
	Write-Host "已新建空的 profile patch: $patch"
}

$yaml = Get-Content $patch -Raw
if ($yaml -match "(?m)^\s*-\s*id:\s*dsh-rtk\s*$") {
	Write-Host "挂载条目已存在，跳过: $patch"
} else {
	$block = @"

- insert:
    - id: dsh-rtk
      name: dsh-rtk
      config:
        log: true
"@
	Add-Content -Path $patch -Value $block -Encoding utf8
	Write-Host "已追加挂载条目: $patch"
}

Write-Host ""
Write-Host "下一步：dsh 的 HMR 会热加载，等几秒后跑 .\verify.ps1 确认。"
