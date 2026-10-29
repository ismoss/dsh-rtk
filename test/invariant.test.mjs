/**
 * 不变式测试：rtk 的改写必须是"只插入 rtk"，不得增删改任何参数。
 *
 * 这是 DSH 官方 pre-tool-input-rewrite 提案最在意的点——执行文本与审计文本
 * 可以差一个过滤器，但不能差一个参数。这里用 token 级比对把这句话变成断言。
 */
import { isPrefixInsertion, rewriteCommand } from "../lib/index.js";

const config = {
	enabled: true,
	rtk: "rtk.exe",
	commands: new Set(["git", "rg", "dotnet", "docker", "kubectl", "pnpm", "npm", "gh", "curl", "tsc"]),
	timeoutMs: 5000,
	log: false,
};

const samples = [
	"git status",
	"git -C C:\\work\\demo status --porcelain",
	'git commit -m "fix: a b c"',
	"git log --oneline -n 5",
	'git log -n 1 --format="%H %s"',
	"git diff --stat HEAD~1",
	"git status 2>&1",
	"git -C C:\\work\\demo rev-parse --abbrev-ref HEAD; git -C C:\\work\\demo status",
	"rg -n --no-heading \"dsh\" docs",
	"docker ps -a",
	"kubectl get pods -n kube-system",
	"gh pr list --state open --limit 5",
	"curl -s https://example.com/a?b=c&d=e",
	"dotnet build C:\\work\\demo\\app --configuration Release",
	"pnpm install --frozen-lockfile",
];

let fail = 0;
for (const cmd of samples) {
	const out = await rewriteCommand(cmd, config, "");
	if (out === cmd) {
		console.log("OK    不改写:", cmd);
		continue;
	}
	if (!isPrefixInsertion(cmd, out)) {
		fail += 1;
		console.log("FAIL  改了参数:", cmd, "->", out);
	} else {
		console.log("OK    只插 rtk:", cmd, "->", out);
	}
}

// --- 闸门反向用例：参数变了就必须拒绝 ---
const negatives = [
	["git status --porcelain", "rtk git status", "丢参数"],
	["git status", "rtk git status --short", "加参数"],
	['git commit -m "a b"', "rtk git commit -m a b", "拆开带空格的引号"],
	["git status", "rtk git status | more", "偷加管道"],
	["git reset --hard", "rtk git reset", "截断命令"],
	["git log", "rtk git log; rm -rf /tmp/x", "追加第二条命令"],
];
const positives = [
	["cd x;git status", "cd x; rtk git status", "压缩的复合命令"],
	["git status 2>&1", "rtk git status 2>&1", "重定向后缀"],
	["git log --grep rtk", "rtk git log --grep rtk", "参数里带 rtk"],
];

for (const [a, b, why] of negatives) {
	if (isPrefixInsertion(a, b) !== false) {
		fail += 1;
		console.log("FAIL  应拒绝却接受:", why, "|", a, "->", b);
	} else {
		console.log("OK    拒绝:", why);
	}
}
for (const [a, b, why] of positives) {
	if (isPrefixInsertion(a, b) !== true) {
		fail += 1;
		console.log("FAIL  应接受却拒绝:", why, "|", a, "->", b);
	} else {
		console.log("OK    接受:", why);
	}
}

console.log(fail === 0 ? "\n不变式成立：只在命令位置插 rtk，参数一字不动；参数被改动的一律拒绝" : `\n${fail} 条不对`);
process.exit(fail === 0 ? 0 : 1);
