# dsh-rtk

把 dsh 的 shell 命令先交给 [rtk](https://github.com/rtk-ai/rtk)（Rust Token Killer）判一次改写，命中就用 `rtk <命令>` 执行，省掉工具输出吃掉的 token。

dsh 没有能改写工具调用的 hook（`tools/pre-execute` 按设计只能 allow/deny），rtk 也没有 `--agent dsh`——这个插件补的就是那一半：在 `ctx.shell` 这个能力缝上包一层，用 rtk 自己的改写引擎决定"改不改、怎么改"。

## 原理

```text
dsh 工具（pwsh/bash）→ ctx.shell.execute(spec)
        └─ dsh-rtk 拦截
              ├─ rtk rewrite -- "<命令>"      ← rtk 自己的改写引擎
              ├─ 退出码 0/3 且有输出         → 执行改写后的命令
              ├─ 退出码 1（无等价物）/ 2（deny）→ 执行原命令
              └─ token 闸门：只接受"纯插入 rtk"的改写
```

rtk 的退出码语义（见其 `src/hooks/rewrite_cmd.rs`）：`0` 可自动放行、`3` 有改写但审批交给宿主、`1` 不改写、`2` deny 交给宿主自己的权限体系。只有 `0/3` 会被采纳。

**token 闸门**：按 `&&` `||` `|` `;` `&` 切 token，把改写结果里插入的 `rtk` 去掉后必须与原文逐 token 相等。丢参数、加参数、拆引号、偷加管道的改写一律拒绝——宁可少省一次 token，也不让"实际执行的命令"和"审计/历史里显示的命令"差出一个参数。

## 安装

Windows（已在本机验证，dsh 0.2.1-rc.3 + rtk 1.1.0）：

```powershell
git clone https://github.com/ismoss/dsh-rtk.git
cd dsh-rtk
.\install.ps1            # 复制到 profile + 写好 cordis.patch.yml 条目
Get-Content ~\.dsh\rtk\applied.json   # 确认被 apply（时间戳是新的）
```

`install.ps1` 做的事：源码复制到 `~\.dsh\plugins\dsh-rtk`（权威副本），再复制到 `~\.dsh\profiles\desktop\node_modules\dsh-rtk`（运行副本），并在 `cordis.patch.yml` 末尾追加 `- insert: id: dsh-rtk`（已存在就跳过）。dsh 的 HMR 会热加载，不用重启。

其它平台：把两个目录换掉即可，`rtk` 用 PATH 里的 `rtk`（或配置 `rtk: "/path/to/rtk"`）。

## 配置

写在 `cordis.patch.yml` 的 `insert` 条目下，改完保存即热生效：

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关掉等于旁路（仍保留挂载） |
| `rtk` | `rtk.exe`（Windows）/ `rtk` | rtk 可执行文件 |
| `commands` | 33 个工具名 | 允许被改写的白名单（`git` `rg` `dotnet`…；不含 `ls`/`cat`/`echo`，它们在 PowerShell 里是别名） |
| `timeoutMs` | `2500` | 单次 `rtk rewrite` 超时，超时按"不改写"处理 |
| `log` | `false` | 写 `~\.dsh\rtk\rewrites.jsonl`（含缓存命中） |
| `debug` | `false` | 写 `~\.dsh\rtk\calls.jsonl`（每次 execute + 每次 rtk 往返） |

## 开关与卸载

- 旁路：新建 `~\.dsh\rtk\off`（或设 `DSH_RTK=off`），整条链路立刻不生效，不用卸载。
- 卸载：删掉 `cordis.patch.yml` 里 `- insert: id: dsh-rtk` 那段（保存后 HMR 自动卸载并还原 `execute`），再删两个 `dsh-rtk` 目录。

## 验证

```powershell
.\verify.ps1
# 或手动：
Get-Content ~\.dsh\rtk\applied.json            # 插件被 apply 的时间/pid
Get-Content ~\.dsh\rtk\rewrites.jsonl -Tail 3  # 原命令 → rtk 命令
rtk gain                                        # Total commands 在涨
```

## 测试

```powershell
node test\rewrite.test.mjs     # 改写正确性（含 & 与引号边界）
node test\invariant.test.mjs   # token 闸门正反用例
node test\fallback.mjs         # rtk 缺失时是否安全回退
```

`harness/cordis-test.mjs` 是接在真实 cordis 4.0.5 上的接线测试（含卸载还原），需要先解开 dsh 自带的 cordis 包，脚本头部有说明。

## 已知限制

- **不是 hook**：改写发生在 `ctx.shell.execute` 内部，所以 dsh 的会话历史、审计日志、UI 卡片显示的都是模型发出的**原命令**，实际执行的是 `rtk <原命令>`。改写记录在 `rewrites.jsonl` 里作为旁证。这是 dsh 尚未实现 pre-tool input rewrite 的直接后果。
- **只覆盖走 `ctx.shell` 的命令**：`pwsh` 工具、后台作业都会经过；**持久终端（pty）不经过**，那里敲的命令不会被改写。
- **exit 2 带 stdout 的情况**（rtk 的 pipeline 规则拒绝并给出阻断消息）：本插件按"跑原命令"处理，交给 dsh 自己的策略；Claude Code 那种钩子会直接阻断。
- **Magpie 里 dsh 仍显示"RTK 暂不支持"**：那是 Magpie 编译进二进制的静态表（`internal/library/rtk.go` 的 `rtkNoHook`），判断的是"rtk 官方有没有这个 agent 的 hook"，与本插件无关。
- **命令缓存不过期**：同一条命令本次进程只问 rtk 一次；改了 rtk 规则需重启 dsh 或换命令。
- **profile 由 pnpm 管**：插件管理操作可能清掉手动放进 `node_modules` 的目录，重装就是再跑一次 `install.ps1`。

## 相关

- rtk 侧讨论：[#4809](https://github.com/rtk-ai/rtk/pull/4809)（instructions-only）、[#3847](https://github.com/rtk-ai/rtk/issues/3847)（FR）
- 给 rtk 的文档 PR：[#4841](https://github.com/rtk-ai/rtk/pull/4841)（"没有 hook 的宿主怎么接"）

MIT License.
