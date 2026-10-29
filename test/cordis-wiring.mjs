/**
 * 在真实 cordis 上验证接线：用一个假 shell 服务，看插件是否把 execute 包住、
 * 按 rtk 的改写执行、并且在卸载后把 execute 还原。
 *
 * 为什么值得单独跑：cordis 每次访问 `ctx.shell` 都返回新的可追踪 Proxy，真正的方法
 * 挂在同一个 service 实例上。拿同一个引用自测会得出"补丁没生效"的错误结论——这个
 * 脚本每次都重新取引用，模拟 dsh 工具侧真实的访问方式。
 *
 * 前置：需要能 import 到 dsh 自带的 cordis（<dsh 安装目录>/dsh/node_modules/@deepseek-ai/cordis）。
 *
 * 跑法：
 *   CORDIS_ENTRY=/path/to/@deepseek-ai/cordis/lib/index.js node test/cordis-wiring.mjs
 *   （Windows: $env:CORDIS_ENTRY="D:\...\cordis\lib\index.js"; node test\cordis-wiring.mjs）
 */
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const entry = process.env.CORDIS_ENTRY;
if (!entry) {
	console.error("请先设置 CORDIS_ENTRY，指向 dsh 自带 cordis 的 lib/index.js");
	process.exit(2);
}

const { Context, Service } = await import(pathToFileURL(entry).href);
const rtkPlugin = (await import("../lib/index.js")).default;

/** 假的 shell 执行器：只记录拿到的命令，不真的跑。 */
class FakeShell extends Service {
	constructor(ctx) {
		super(ctx, "shell");
		this.seen = [];
	}
	resolve(request) {
		return { command: request.command, workdir: request.workdir ?? process.cwd() };
	}
	async execute(spec) {
		this.seen.push(spec.command);
		return { result: async () => ({ exitCode: 0, stdout: { text: "" } }) };
	}
}

const ctx = new Context();
ctx.plugin(FakeShell);
ctx.plugin(rtkPlugin, { log: false });
await new Promise((resolve) => setTimeout(resolve, 300));

/** 每次都重新取引用，跟 dsh 工具侧的用法一致。 */
const fresh = () => ctx.get("shell");
const run = async (command) => {
	const shell = fresh();
	await (await shell.execute(shell.resolve({ command }))).result();
};

assert.equal(fresh() === fresh(), false, "cordis 每次访问都返回新的可追踪 Proxy");

await run("git status");
await run("ls -la");
await run("rtk git log -n 1");
await run("git status | Select-String foo");

const seen = fresh().seen;
console.log("seen:", JSON.stringify(seen, null, 2));
assert.equal(seen[0], "rtk git status", "白名单命令要被改写");
assert.equal(seen[1], "ls -la", "PowerShell 的 ls 必须原样");
assert.equal(seen[2], "rtk git log -n 1", "已经是 rtk 的命令不能被包第二次");
assert.equal(seen[3], "git status | Select-String foo", "管道命令 rtk 自己就拒绝");

// 卸载插件后必须还原
ctx.registry.delete(rtkPlugin);
await new Promise((resolve) => setTimeout(resolve, 200));
const shell = fresh();
shell.seen.length = 0;
await run("git status");
console.log("after dispose:", JSON.stringify(shell.seen));
assert.deepEqual(fresh().seen, ["git status"], "卸载后命令必须原样通过");

console.log("\nPASS: 接线、改写、白名单、管道拒绝、卸载还原 全部符合预期");
