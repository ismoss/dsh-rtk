# 检查 dsh-rtk 是否真的装好并在工作：加载痕迹、改写日志、rtk 记账、旁路开关、挂载条目。
# 用法：.\verify.ps1 [-Profile desktop]
param(
	[string]$Profile = "desktop"
)

$state = Join-Path $env:USERPROFILE ".dsh\rtk"
$profileDir = Join-Path $env:USERPROFILE ".dsh\profiles\$Profile"

function Show-Step($name, $ok, $detail) {
	$mark = if ($ok) { "OK  " } else { "FAIL" }
	Write-Host ("[{0}] {1}{2}" -f $mark, $name, $(if ($detail) { " — $detail" } else { "" }))
}

# 1. 运行副本与权威副本
$target = Join-Path $profileDir "node_modules\dsh-rtk\lib\index.js"
$canonical = Join-Path $env:USERPROFILE ".dsh\plugins\dsh-rtk\lib\index.js"
Show-Step "运行副本存在" (Test-Path $target) $target
Show-Step "权威副本存在" (Test-Path $canonical) $canonical

# 2. profile 挂载条目
$patch = Join-Path $profileDir "cordis.patch.yml"
$mounted = (Test-Path $patch) -and ((Get-Content $patch -Raw) -match "(?m)^\s*-\s*id:\s*dsh-rtk\s*$")
Show-Step "cordis.patch.yml 有挂载条目" $mounted $patch

# 3. 加载痕迹（时间戳应该是最近一次 dsh 启动/重载）
$appliedFile = Join-Path $state "applied.json"
if (Test-Path $appliedFile) {
	$applied = Get-Content $appliedFile -Raw | ConvertFrom-Json
	$age = [int]((Get-Date).ToUniversalTime() - ([datetime]$applied.at).ToUniversalTime()).TotalMinutes
	Show-Step "插件被 apply 过" $true ("at=$($applied.at) pid=$($applied.pid) 距今 $age 分钟")
} else {
	Show-Step "插件被 apply 过" $false "没有 $appliedFile：插件没加载，或 dsh 还没重载"
}

# 4. 旁路开关
$off = Join-Path $state "off"
Show-Step "旁路开关未开启" (-not (Test-Path $off)) $off

# 5. 改写日志
$rewrites = Join-Path $state "rewrites.jsonl"
if (Test-Path $rewrites) {
	$last = Get-Content $rewrites -Tail 1
	Show-Step "有改写记录" $true $last
} else {
	Show-Step "有改写记录" $false "还没有 $rewrites（跑一条 git 命令就会产生）"
}

# 6. rtk 自己的记账
Write-Host ""
Write-Host "rtk gain:"
try { rtk gain 2>&1 | Select-Object -Skip 3 -First 5 } catch { Write-Host "  （rtk 不在 PATH）" }
