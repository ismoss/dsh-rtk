/**
 * dsh-rtk 的纯逻辑测试：不需要 dsh，只要本机有 rtk。
 * 跑法：node test/rewrite.test.mjs
 */
import assert from "node:assert/strict";
import { DEFAULT_COMMANDS, acceptRewrite, rewriteCommand } from "../lib/index.js";

const config = {
	enabled: true,
	rtk: process.platform === "win32" ? "rtk.exe" : "rtk",
	commands: new Set(DEFAULT_COMMANDS),
	timeoutMs: 5000,
	log: false,
};

const cases = [
	// [原始命令, 期望结果, 说明]
	["git status", "rtk git status", "最普通的 git 命令要被改写"],
	["git log --oneline -n 5", "rtk git log --oneline -n 5", "带参数透传"],
	['git commit -m "hello world"', 'rtk git commit -m "hello world"', "引号不能丢"],
	["rg -n foo src", "rtk rg -n foo src", "ripgrep 是白名单"],
	["dotnet build C:\\work\\demo\\app", "rtk dotnet build C:\\work\\demo\\app", "dotnet 构建"],
	["ls -la", "ls -la", "PowerShell 的 ls 是别名，不能换成 rtk ls"],
	["Get-ChildItem -Force", "Get-ChildItem -Force", "PowerShell cmdlet 不碰"],
	["echo hi", "echo hi", "rtk 没有 echo"],
	["git status | Select-String foo", "git status | Select-String foo", "管道命令 rtk 自己就拒绝"],
	["rtk git status", "rtk git status", "已是 rtk 命令，不重复包"],
	["git status\nls", "git status\nls", "多行脚本不碰"],
	["cd C:\\work\\demo; git status", "cd C:\\work\\demo; rtk git status", "复合命令里只改写 git 那段"],
	["curl -s https://example.com/a?b=c&d=e", "rtk curl -s https://example.com/a?b=c & d=e", "`&` 插空格与 PowerShell 解析等价，可以接受"],
	["git log --grep rtk", "rtk git log --grep rtk", "参数本身叫 rtk 时不误判"],
];

let failed = 0;
for (const [input, expected, note] of cases) {
	const actual = await rewriteCommand(input, config, "");
	const ok = actual === expected;
	if (!ok) failed += 1;
	console.log(`${ok ? "PASS" : "FAIL"}  ${note}`);
	if (!ok) {
		console.log(`  in : ${JSON.stringify(input)}`);
		console.log(`  out: ${JSON.stringify(actual)}`);
		console.log(`  exp: ${JSON.stringify(expected)}`);
	}
}

// 白名单闸门本身
assert.equal(acceptRewrite("rtk git status", config.commands), true);
assert.equal(acceptRewrite("rtk ls -la", config.commands), false);
assert.equal(acceptRewrite("cd x && rtk git status", config.commands), true);
assert.equal(acceptRewrite("git status", config.commands), true);

console.log(failed === 0 ? "\nall rewrite cases passed" : `\n${failed} case(s) failed`);
process.exit(failed === 0 ? 0 : 1);

