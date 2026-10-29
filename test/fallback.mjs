import { askRtk, rewriteCommand } from "../lib/index.js";
const bad = { enabled: true, rtk: "rtk-does-not-exist.exe", commands: new Set(["git"]), timeoutMs: 1500, log: false };
const t0 = Date.now();
const out = await rewriteCommand("git status", bad, "");
console.log("rtk 缺失时:", JSON.stringify(out), "耗时", Date.now() - t0, "ms", out === "git status" ? "→ 正确回退" : "→ 有问题");
console.log("askRtk 直接调用:", await askRtk("git status", bad));

