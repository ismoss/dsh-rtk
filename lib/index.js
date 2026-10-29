/**
 * dsh-rtk —— 让 dsh 的 shell 命令走一遍 rtk（https://rtk-ai.app）。
 *
 * 为什么需要这个插件：
 *   rtk 省 token 的方式是“把 agent 即将执行的命令改写成 `rtk <命令>`”，
 *   它的 Claude Code / Codex / Cursor 钩子做的就是这件事。dsh 的
 *   `tools/pre-execute` 事件按设计只能 allow/deny、不能改参数
 *   （见 @deepseek-ai/dsh-tools README 的 “deliberately cannot rewrite
 *   exec.arguments”），rtk 也没有 `--agent dsh`，所以 Magpie 的
 *   `magpie library rtk` 只能把 dsh 标成“暂不支持”。
 *
 *   这里补上 dsh 侧缺的那半：包住 `ctx.shell.execute(spec)`，在真正执行
 *   前把命令交给 rtk 自己的改写引擎（`rtk hook opencode <command>`）判一次，
 *   拿到 {"command": "rtk git status"} 就用改写后的命令，否则原样执行。
 *   改写规则、安全边界（管道/复合命令/权限相关一律不猜）全部复用 rtk，
 *   本插件只负责“问一句、换一条”。
 *
 * 安全设计：
 *   - 宿主里任何一步失败（rtk 不在、超时、JSON 不对）都退回原命令，
 *     绝不因为省 token 影响命令本身能否跑。
 *   - 只认白名单里的工具名：把 `ls` / `Get-ChildItem` 之类 PowerShell
 *     语义很强的命令排除掉，避免 `rtk ls` 把对象流变成文本。
 *   - `~/.dsh/rtk/off` 存在即全局旁路（一条文件就能关掉，不需要卸载）。
 *   - 用 ctx.effect 登记还原：插件卸载/热重载时把原方法还回去。
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { appendFile, mkdir, stat, truncate } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** 插件名（cordis 里显示用）。 */
export const name = "dsh-rtk";

/** 必须等 ctx.shell 就绪后再 apply：改的就是它的 execute。 */
export const inject = ["shell"];

/**
 * 默认交给 rtk 判定的命令白名单。
 * 只放“整条命令就是一次外部进程调用、输出本来就给人看”的工具；
 * ls / cat / echo 这类在 PowerShell 里是别名或语义敏感的命令不放。
 */
export const DEFAULT_COMMANDS = [
	"git",
	"gh",
	"glab",
	"docker",
	"kubectl",
	"oc",
	"dotnet",
	"cargo",
	"npm",
	"pnpm",
	"bun",
	"bunx",
	"npx",
	"tsc",
	"eslint",
	"prettier",
	"jest",
	"vitest",
	"playwright",
	"prisma",
	"next",
	"ng",
	"aws",
	"psql",
	"curl",
	"wget",
	"rg",
	"grep",
	"ast-grep",
	"diff",
	"tree",
	"json",
	"deps",
];

/** 改写结果缓存上限（同一命令在一次会话里会反复出现）。 */
const CACHE_LIMIT = 256;
/** 超过这个长度的命令不碰（多是无头脚本，交给 rtk 猜不划算）。 */
const MAX_COMMAND_LENGTH = 4096;
/** 改写日志的滚动阈值；超过就清空重来，别在用户家目录里堆文件。 */
const LOG_MAX_BYTES = 512 * 1024;

/** cordis 暴露 service 真身的符号：`ctx.shell` 拿到的是它外面的可追踪 Proxy。 */
const CORDIS_ORIGINAL = Symbol.for("cordis.original");

/** 调试探针：config.debug 为真时，把每次 rtk 往返写进 calls.jsonl。 */
let probe = null;

/** command → 改写结果（undefined 表示“不改写”）。 */
const cache = new Map();

/**
 * 把配置归一化成内部形状。
 * @param {object|undefined} raw 插件配置。
 * @returns {{enabled:boolean, rtk:string, commands:Set<string>, timeoutMs:number, log:boolean}}
 */
function normalizeConfig(raw) {
	const config = raw ?? {};
	const commands = Array.isArray(config.commands) && config.commands.length > 0
		? config.commands
		: DEFAULT_COMMANDS;
	return {
		enabled: config.enabled !== false,
		rtk: typeof config.rtk === "string" && config.rtk !== ""
			? config.rtk
			: process.platform === "win32" ? "rtk.exe" : "rtk",
		commands: new Set(commands.map((value) => String(value).toLowerCase())),
		timeoutMs: Number.isFinite(config.timeoutMs) && config.timeoutMs > 0
			? config.timeoutMs
			: 2500,
		log: config.log === true,
		debug: config.debug === true,
	};
}

/** 家目录下的 rtk 旁路开关文件路径。 */
function killSwitchPath() {
	return join(homedir(), ".dsh", "rtk", "off");
}

/** 安装/加载痕迹：确认插件真的被宿主 apply 过（排查热加载用）。 */
function markApplied(config) {
	try {
		mkdirSync(join(homedir(), ".dsh", "rtk"), { recursive: true });
		writeFileSync(
			join(homedir(), ".dsh", "rtk", "applied.json"),
			`${JSON.stringify({
				at: new Date().toISOString(),
				pid: process.pid,
				rtk: config.rtk,
				enabled: config.enabled,
				commands: config.commands.size,
				log: config.log,
			}, null, 2)}\n`,
			"utf8",
		);
	} catch {
		// 痕迹文件失败不影响功能
	}
}

/** 改写日志路径。 */
function logPath() {
	return join(homedir(), ".dsh", "rtk", "rewrites.jsonl");
}

/**
 * 问 rtk：这条命令该怎么改写？
 *
 * 用的是 `rtk rewrite`——rtk 自己文档里写的 “single source of truth for hooks”，
 * 比 `rtk hook opencode` 的 JSON 更稳（后者有按工具名返回空 {} 的已知问题）。
 * 退出码语义：
 *   0 / 3 有改写，stdout 是新命令（3 只是“审批交给宿主”，命令本身可用）
 *   1     不改写（没有 rtk 等价物、已被排除、或 $() / 重定向这类不碰的构造）
 *   2     被 deny 规则拦下：必须原样执行，交给 dsh 自己的权限体系
 *
 * 任何异常（rtk 不在、超时、非预期退出码）一律返回 undefined，由调用方退回原命令。
 *
 * @param {string} command 原始命令。
 * @param {{rtk:string, timeoutMs:number}} config 归一化配置。
 * @returns {Promise<string|undefined>} 改写后的命令，或 undefined。
 */
export function askRtk(command, config) {
	return new Promise((resolve) => {
		execFile(
			config.rtk,
			["rewrite", "--", command],
			{ timeout: config.timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
			(error, stdout, stderr) => {
				// rtk rewrite 用退出码表达结果，1/2 也会让 execFile 带 error 回来，
				// 所以这里先看退出码，而不是“有没有 error”。
				const code = error === null || error === undefined ? 0 : Number(error.code);
				probe?.({ at: new Date().toISOString(), pid: process.pid, cmd: command, code: Number.isNaN(code) ? String(error?.code) : code, err: String(error?.message ?? "").slice(0, 300), out: String(stdout ?? "").trim().slice(0, 300), stderr: String(stderr ?? "").trim().slice(0, 300) });
				if (code !== 0 && code !== 3) {
					resolve(undefined);
					return;
				}
				const rewritten = String(stdout ?? "").trim();
				if (rewritten === "") {
					resolve(undefined);
					return;
				}
				resolve(rewritten);
			},
		);
	});
}

/**
 * 二次把关：rtk 给出的改写只允许落在白名单工具上。
 *
 * rtk 会把 `cd x; git status` 里真正的那段改写成 `rtk git status`，
 * 但也可能改写 `ls`——PowerShell 的 `ls` 是 Get-ChildItem 别名，
 * 换成 `rtk ls` 会改变语义，所以这里检查每个 `rtk <sub>` 的子命令名。
 *
 * @param {string} rewritten rtk 给出的改写结果。
 * @param {Set<string>} allow 允许的子命令名（小写）。
 * @returns {boolean} 是否接受这条改写。
 */
export function acceptRewrite(rewritten, allow, original) {
	const segments = rewritten.split(/;|&&|\|\||\r?\n/);
	for (const segment of segments) {
		const head = /^\s*&?\s*rtk\s+(\S+)/i.exec(segment);
		if (head === null) continue;
		if (!allow.has(head[1].toLowerCase())) return false;
	}
	return original === undefined || isPrefixInsertion(original, rewritten);
}

/**
 * 把一个命令切成 token：空白分隔，`&&` `||` `|` `;` `&` 单独成 token，引号原样保留。
 *
 * 为什么按运算符切而不是只按空白切：`a&b` 和 `a & b` 在 PowerShell 里是同一个解析
 * （`&` 本来就是语句分隔），rtk 给它插空格不算改语义。只有"参数内容变了"才算。
 *
 * @param {string} text 命令文本。
 * @returns {string[]} token 列表（引号原样保留在 token 里）。
 */
export function tokens(text) {
	const operators = ["&&", "||", "|", ";", "&"];
	const out = [];
	let current = "";
	let quote = null;
	const flush = () => {
		if (current !== "") {
			out.push(current);
			current = "";
		}
	};
	for (let i = 0; i < text.length; i += 1) {
		const ch = text[i];
		if (quote !== null) {
			current += ch;
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			current += ch;
			continue;
		}
		if (/\s/.test(ch)) {
			flush();
			continue;
		}
		const op = operators.find((candidate) => text.startsWith(candidate, i));
		if (op !== undefined) {
			flush();
			out.push(op);
			i += op.length - 1;
			continue;
		}
		current += ch;
	}
	flush();
	return out;
}

/**
 * 硬不变式：改写只能在命令位置插入 `rtk` token，不能增删改任何参数。
 *
 * 背景：DSH 的 pre-tool-input-rewrite 提案要求"执行文本与审计文本只能差一个过滤器，
 * 不能差一个参数"。这里把它变成可执行的检查——rtk 之外的任何 token 变化都拒绝改写。
 * 宁可少省一次 token，也不让模型看到的结果和实际执行的命令对不上。
 *
 * 实现用贪心匹配：遇到和原文对不上的 `rtk` 就当作插入跳过，其余必须逐字相等。
 * 这样 `git log --grep rtk`（参数里本来就有 rtk 字样）也不会被误判。
 *
 * @param {string} original 原始命令。
 * @param {string} rewritten rtk 给的改写结果。
 * @returns {boolean} 是否只是插入了 rtk 前缀。
 */
export function isPrefixInsertion(original, rewritten) {
	const want = tokens(original);
	const got = tokens(rewritten);
	let i = 0;
	for (const token of got) {
		if (i < want.length && token === want[i]) {
			i += 1;
			continue;
		}
		if (token === "rtk" || token === "rtk.exe") continue;
		return false;
	}
	return i === want.length;
}

/**
 * 硬不变式：改写只能"插入 rtk token"，不能增删改任何参数。
 *

/**
 * 形状检查：多行脚本、子表达式、反引号一律不碰。
 * @param {string} command 原始命令。
 * @returns {boolean} 是否值得问 rtk。
 */
function looksRewritable(command) {
	if (command.trim() === "" || command.length > MAX_COMMAND_LENGTH) return false;
	if (/[\r\n`]/.test(command)) return false;
	if (/\$\(/.test(command)) return false;
	if (/^\s*rtk(\.exe)?\s/i.test(command)) return false;
	return true;
}

/**
 * 拿一条命令的最终执行文本：能改写就改写，否则原样返回。
 * @param {string} command 原始命令。
 * @param {ReturnType<typeof normalizeConfig>} config 归一化配置。
 * @param {string} logFile 日志路径。
 * @returns {Promise<string>} 真正要执行的命令。
 */
export async function rewriteCommand(command, config, logFile) {
	if (!looksRewritable(command)) return command;
	const hit = cache.get(command);
	if (hit !== undefined) {
		const cached = hit === "" ? command : hit;
		// 命中缓存也要记一笔：审计日志里不该少了“实际被改写过”的调用。
		if (config.log && cached !== command) {
			await appendLog(logFile, { at: new Date().toISOString(), from: command, to: cached, cached: true });
		}
		return cached;
	}

	const candidate = await askRtk(command, config);
	let final = command;
	if (candidate !== undefined && candidate.trim() !== command.trim() && acceptRewrite(candidate, config.commands, command)) {
		final = candidate;
	}

	cache.set(command, final === command ? "" : final);
	if (cache.size > CACHE_LIMIT) {
		const oldest = cache.keys().next();
		if (!oldest.done) cache.delete(oldest.value);
	}

	if (config.log && final !== command) {
		await appendLog(logFile, { at: new Date().toISOString(), from: command, to: final });
	}
	return final;
}

/**
 * 追加一行改写记录（超过阈值就先清空）。
 * @param {string} logFile 日志文件。
 * @param {object} record 记录内容。
 * @returns {Promise<void>} 写完即返回，失败静默。
 */
async function appendLog(logFile, record) {
	try {
		await mkdir(join(homedir(), ".dsh", "rtk"), { recursive: true });
		const info = await stat(logFile).catch(() => undefined);
		if (info !== undefined && info.size > LOG_MAX_BYTES) await truncate(logFile, 0);
		await appendFile(logFile, `${JSON.stringify(record)}\n`, "utf8");
	} catch {
		// 日志只是旁证，不能影响命令执行
	}
}

/**
 * cordis 插件入口：包住 ctx.shell.execute。
 *
 * 注意 cordis 的服务访问模型：`ctx.shell` 每次访问都返回一个新的可追踪
 * Proxy（真正的方法挂在同一个 service 实例上）。所以：
 *   - 不能拿 `ctx.shell === ctx.shell` 判断同一个对象，也不能用实例身份做冒烟测试；
 *   - 补丁要打到 Proxy 后面的那个 service 实例上（`Symbol.for("cordis.original")`），
 *     否则只改了当前这一个 Proxy 的影子属性；
 *   - 调用原方法时必须显式 `.call(target, spec)`，别依赖 this。
 *
 * @param {import("@deepseek-ai/cordis").Context} ctx 插件上下文。
 * @param {object|undefined} raw 插件配置。
 */
export function apply(ctx, raw) {
	const config = normalizeConfig(raw);
	markApplied(config);
	if (!config.enabled) return;

	const shell = ctx.shell;
	if (shell === undefined || shell === null) {
		ctx.logger?.warn?.("dsh-rtk: ctx.shell is unavailable; rtk stays off");
		return;
	}

	const target = shell[CORDIS_ORIGINAL] ?? shell;
	const original = target.execute;
	if (typeof original !== "function") {
		ctx.logger?.warn?.("dsh-rtk: ctx.shell has no execute(); rtk stays off");
		return;
	}
	const logFile = logPath();
	const callsFile = join(homedir(), ".dsh", "rtk", "calls.jsonl");
	probe = config.debug ? (record) => { void appendLog(callsFile, record); } : null;

	const wrapped = async function executeWithRtk(spec) {
		if (config.debug) await appendLog(callsFile, { at: new Date().toISOString(), pid: process.pid, cmd: spec?.command });
		if (existsSync(killSwitchPath()) || process.env.DSH_RTK === "off") return original.call(target, spec);
		const command = spec?.command;
		if (typeof command !== "string") return original.call(target, spec);
		let final = command;
		try {
			final = await rewriteCommand(command, config, logFile);
		} catch {
			final = command;
		}
		if (final === command) return original.call(target, spec);
		return original.call(target, { ...spec, command: final });
	};

	target.execute = wrapped;
	ctx.effect(() => () => {
		if (target.execute === wrapped) target.execute = original;
	});
}

export default { name, inject, apply };
