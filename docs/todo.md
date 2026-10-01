# 待办与试点记录

最后更新：2026-09-30。用 symphony-copilot 开发电梯小游戏（试点项目，私有仓库）时发现的问题先记到「试点记录」，决定要做的再列进「待办」。做完把状态改成“已完成”并写上提交或 PR。试点记录保留当时行为；其中费用预算、8 次会话和最多 3 轮审核不是当前配置建议。

## 待办

### P0：推广前先补上

| # | 待办 | 起因 | 状态 |
|---|---|---|---|
| 1 | README 写清验证范围：端到端只在 macOS 跑过，Linux 只跑过单元测试 | CI 的 Linux 任务只跑单元测试，容易被读成“支持 Linux” | 未开始 |
| 2 | `tracker_submit_for_review` 集成测试：用本地空仓库当远端，覆盖工作区不干净、推送、已有 PR 时留言、推送被拒 | 最关键的路径，现有测试只检查工具存在 | 未开始 |
| 3 | `src/runner.ts` 测试：假的 SDK 会话，覆盖 idle、error、aborted、实际启动确认、静默超时、续写 | 原先 runner 完全没有测试 | 已有离线回归；整体交付验证见本次实现计划 |
| 4 | 端到端冒烟脚本 `npm run e2e`：测试仓库和测试看板，一张卡从领取到 PR，保留证据 | 端到端只手动跑过一次 | 未开始 |
| 5 | 发 v0.1.0：打标签、CHANGELOG、GitHub Release | 没有版本号，别人不敢用 | 未开始 |

### P1：降低上手门槛

| # | 待办 | 起因 | 状态 |
|---|---|---|---|
| 6 | `doctor` 命令：Node 版本、gh 登录和 `project` 权限、Copilot 认证与额度、看板状态和标签、git 能否推送、`WORKFLOW.md` 能否解析和渲染，逐项给修复提示 | 这些都手动排查过；detent 有同类命令 | 未开始 |
| 7 | 按 `WORKFLOW.md` 一键新建看板：先生成 `WORKFLOW.md`（待办 38），脚本读它的 `tracker`、`review`、`merge_conflicts` 段，新建看板，建状态选项、优先级字段和标签，关联仓库，然后把 `project_number` 写进 `WORKFLOW.md` 并在命令行说明。`project_number` 已填且看板存在时，问用户删掉重建还是退出（默认退出；删之前显示看板名和卡片数，要输入看板编号确认）。确认项目自动化 API 能力后，提示其存在和配置限制，不要求用户修改 | 建看板时手动做了很多步；状态名写错不报错，dry-run 只显示 0 张卡；Issue 不在看板上就不会被派发，文档没提 Auto-add | 已完成：`symphony setup-board`。GitHub 公共 API 可读取 Project workflow，但不能配置或启用它们；setup-board 说明这些自动化可能影响状态流转，异常时建议检查网页 Workflows 页面，不要求修改；新 Board 视图仍需单独创建 |
| 8 | 发布 npm 包，支持 `npx`：加编译步骤，发布 JS | Node 不剥离 `node_modules` 里 `.ts` 的类型，直接发源码跑不起来 | 未开始 |
| 9 | README 开头放演示 GIF：卡片 → PR → Human Review | 受欢迎的项目开头都有画面 | 未开始 |
| 10 | 终端实时状态：每个 agent 的轮次、最近动作、已用高级请求 | 现在只能翻日志 | 未开始 |
| 11 | 社区文件：CONTRIBUTING、SECURITY.md、Issue 模板、Dependabot | 公开仓库的基本配置 | 未开始 |
| 38 | `WORKFLOW.md` 契约：front matter 的 JSON Schema（每个键的类型、默认值、说明），和检查工具 `symphony check`：解析、按 schema 报未知键、跑 `buildConfig` 的跨字段校验、用示例 Issue 渲染提示词模板。再加一个交互式生成 `WORKFLOW.md` 的 skill：读仓库定构建命令、hooks 和允许列表，按契约填写，跑 check 直到通过 | 各列该写进 `active_states`、`agent_states`、`handoff_state`、`review.states`、`merge_conflicts` 哪一项，分散在 README 三节和 reference 里；拼错的键现在被静默忽略。契约管“填得对不对”，skill 管“按这个项目该填什么” | 已完成：`schema/workflow.schema.json`（测试保证它和代码读的键一致）、`symphony check`（`--online` 核对看板）、skill `symphony-onboard`，用 `symphony install-skills` 装到 `~/.copilot/skills` |
| 39 | 通用的 `AGENTS.md`、`REVIEW.md` 模板（放 `examples/`），和按仓库生成它们的 skill；示例 `WORKFLOW.md` 补上 `review` 段和审核者的 `before_run` 重置 | 示例提示词让 agent 先读 AGENTS.md，但没有写法和示例；REVIEW.md 和重置分支的 hook 只在试点仓库里有 | 已完成：`examples/AGENTS.md`、`examples/REVIEW.md`，由 `symphony-onboard` 按仓库生成 |
| 40 | 卡片契约：Issue 表单模板（目标、验收条件、怎么验证、范围外），和写卡片的 skill（写好后建 Issue、加到看板、打 `agent` 标签） | 卡片怎么写没有任何文档，而验收条件和验证方式直接决定 agent 做得对不对 | 已完成：`examples/ISSUE_TEMPLATE/agent-task.yml`（故意不自动加标签）、skill `symphony-write-card` |
| 47 | 跨平台 setup 向导：检查 Node 22.18+、Git 2.38+、npm、GitHub CLI、Copilot CLI，列出缺项，用户确认一次后自动装支持的平台包；默认装官方最新 Node 24 LTS（归档 SHA-256 校验、用户目录安装）。然后确认 `npm ci`，在同一登录阶段完成 `gh auth login`/Project scope/Git 凭据和 `copilot login`；让用户选择 Copilot browser-link 或 device-code 流程；让新 login 与交互式 shell 都能找到用户级 node/npm/copilot；支持 macOS、Linux、Windows | 新用户需要分别找安装说明、装工具、登录并配权限；容器 root 环境没有 sudo，且非 login bash 不读 `.profile` | 已实现并验证：Node 24.21.0 在 Apple Container root/no-sudo 环境安装成功；新 login/interactive Bash 均找到 node/npm；117 项测试通过。Windows PowerShell 实机验证仍待做 |
| 48 | 用 `symphony-copilot` 管理自己的开发：建看板，小卡片交给它自己做 | 未开始 |
| 49 | Onboarding 的模型选择：为用户提供 Copilot 账号实际可用模型的发现与选择方式；明确 `auto` 的路由行为、固定模型可复现性、reviewer 与 implementer 的独立性，以及模型可用状态和成本差异。设计完成后再决定是否提供 `symphony models` 命令、交互 picker 或只给出安全指引 | 用户无法判断 Auto 是否太随机，也不认识模型 ID；Copilot CLI/RPC 可返回账号模型目录，但罗列 ID 不能单独解决推荐、权限状态、成本与独立审核的决策问题 | 暂缓：本轮撤回模型目录命令和 skill 自动查询；保留当前 `auto` 默认。后续先设计完整选择体验 |

### P1：运行质量

| # | 待办 | 起因 | 状态 |
|---|---|---|---|
| 12 | 运行证据保留：工作区删除前把日志、截图复制到 `evidence/<卡片>` | 证据写在工作区的 `work/`，工作区一删就没了 | 截图已解决：提交审核时可附图，存到 `symphony-evidence` 分支并嵌入 Issue 和 PR。日志类证据还没做 |
| 13 | 轮询时清理终态卡片的工作区，不只在启动时 | GH-7 合并后 217 MB 的工作区一直留着 | 未开始 |
| 14 | 会话结束时汇总被拒的权限请求（命令和次数） | `git status`、`exit` 被误拒，都是翻日志才发现 | 未开始 |
| 15 | 模板变量“工作区已有进度”（如 `workspace.reused`） | 从受阻放回的卡片 `attempt` 为空，只能靠提示词提醒 | 未开始 |
| 16 | 交接后卡片很快被移回活跃列时打警告 | 看板自动化 “Pull request linked” 踩过的坑；API 读不到自动化设置 | 未开始 |
| 17 | 成本指标：每张卡、每个合并 PR 的 AI credits 和 token；日志里记下 `auto` 实际选中的模型 | 同一张卡 GH-7 两次运行用了 28.5 和 1.41 credits，现在日志看不出用的哪个模型 | 未开始 |
| 18 | 查清 token 用量高的原因：文档、工具输出还是多轮上下文 | 每轮 60–80 万 token | 未开始 |
| 27 | 模型策略：按卡片或按尝试选模型（如先用便宜的，返工或重试时换贵的），记录实际成本 | `auto` 每个会话只选一个模型，单次请求价差 40–50 倍（见试点记录 GH-9） | 未开始；当前保持 auto，不恢复费用停止阈值 |
| 28 | README 成本脚注改用真实数据：账户按 token 计费，花费主要取决于模型 | 现在只写了“1 次高级请求”，不足以说明成本 | 未开始 |
| 29 | 单一任务授权上限：默认 20 次实际启动会话，实现／审核共享；费用只记录，不驱动停止 | 旧费用预算会诱导提前收工，自动返工也不应获得新额度 | 已替换旧方案：`agent.max_sessions`，必填 `blocked_state`，启动前失败暂停不扣数、连续两次经审核的无进展返工暂停；等待列回 `start_state` 才重置。Issue 保存完整交接，费用仅详细日志与尽力补写的结果尾行；旧 credit/review cap 配置报迁移错误 |
| 30 | 参考 openai/symphony 的 `elixir/WORKFLOW.md` 改进示例：固定模型，借鉴它的 workpad 评论和 PR 反馈处理流程 | 参考实现在 `codex.command` 里固定了 `gpt-5.5` 和 `xhigh`，我们的示例用的是 `auto` | 未开始 |
| 31 | 再次提交审核时用新的 summary 更新 PR 正文（保留评论记录） | 返工后 PR 正文还是第一次的内容，审核的人要翻评论才知道现状 | 未开始 |
| 32 | shell 命令的路径检查补上命令文本里的绝对路径、`~`、`$HOME` 和通配符（按通配符前的部分判断），超出工作区就拒绝 | GH-14 的 agent 用 `for d in /Users/<用户>/*/work/art-raw …` 搜主目录，放行了。`policy.ts` 只检查运行时解析出的 `possiblePaths`，通配符和变量展开后的路径不在里面 | 未开始 |
| 34 | 等人处理的 PR 与主分支冲突时，退回实现者并优先派发 | GH-13 的 PR #22 在待验证时，因为 #23 先合并而冲突；调度器只看活跃列，没人管 | 已完成（1b4fb28）：`merge_conflicts`（`states`、`return_state`）；提交审核前用 `git merge-tree` 检查冲突 |
| 35 | `merge_conflicts.states` 不能包含 `tracker.provider.blocked_state`；冲突退回不得重启暂停／耗尽次数的卡片 | 旧实现的冲突退回会新开运行并重置上限，可能无限循环 | 已覆盖配置加载和离线检查；运行时冲突退回沿用同一授权，跳过暂停／耗尽次数的卡片 |
| 36 | 冲突退回时记下 PR 的 `headRefOid`，同一个提交不重复退回 | GitHub 异步处理推送，交接后很快轮询可能读到旧提交的 `CONFLICTING`，白跑一次会话、多发一条留言 | 未开始 |
| 37 | 提交审核时的冲突检查改为对比 PR 的 `baseRefName`（没有 PR 时再用默认分支） | 提交时对比 `origin/<默认分支>`，调度器看的是 PR 目标分支；目标分支改变可能反复冲突退回（当前共享会话上限不再重置） | 未开始 |

### P2：更强的能力和隔离

| # | 待办 | 起因 | 状态 |
|---|---|---|---|
| 19 | 让 agent 碰不到本机 gh 登录（如给 agent 进程空的 `GH_CONFIG_DIR`），先确认不影响 Copilot 运行时自己的认证 | README 里的已知缺口 | 未开始 |
| 20 | 用真实 agent 验证并发，处理端口、缓存、设备争用 | 只验证过串行 | 未开始 |
| 21 | 规范的可选 HTTP 状态接口（§13.7） | 与规范的差异 | 未开始 |
| 22 | 对照规范逐条列出实现情况和对应测试 | 主打“忠于规范”，要拿得出证据 | 未开始 |
| 23 | 固定 SDK 版本，升级时跑端到端 | SDK 自带运行时 1.0.85，CLI 已到 1.0.89，更新频繁 | 未开始 |
| 24 | 更多 tracker，如只用 GitHub Issues 标签的无看板模式 | 同类项目都有，门槛更低 | 未开始 |
| 33 | 打开 SDK 的沙盒（`SandboxConfig`，macOS 用 seatbelt，实验性），由系统把 shell 限制在工作区；先验证 `xcodebuild`、模拟器和 DerivedData 在沙盒里能用 | 待办 32 的文本检查挡不住用变量拼出来的路径；运行时现在报告 `sandboxApplied: false` | 未开始 |
| 41 | 一台机器同时跑多个项目，每份工作流一个隔离的调度器，用稳定 ID 管理 | 旧版 `bin/symphony` 用 pgrep 拒绝第二个调度器，换 `SYMPHONY_STATE_DIR` 也没用 | 已实现：按 ID 启停、状态和日志；独立账本/工作区；同用户共享登记表在启动前拒绝状态路径冲突和同看板并发，热加载不得切换运行身份。见 README 多工作流章节；升级前先停旧实例 |

### 自举：用 symphony 开发 symphony（待办 25 的前提）

| # | 待办 | 起因 | 状态 |
|---|---|---|---|
| 42 | 调度器从固定版本的副本运行（如 `git worktree add ~/symphony-stable <tag>`），`WORKFLOW.md` 也用这份副本里的路径；写清升级步骤 | 跑调度器的代码和 agent 改的是同一个仓库：合并一个坏 PR，修它的工具先坏了；`WORKFLOW.md` 按传入路径热加载，在开发副本里 `git pull` 就立刻改掉 agent 的权限和提示词 | 未开始 |
| 43 | 改到 agent 自身权限的 PR 必须由人把关：`REVIEW.md` 把改 `src/policy.ts`、`DEFAULT_SHELL_ALLOW/DENY`、`WORKFLOW.md`、`bin/symphony` 列为必须人看，加 CODEOWNERS | agent 能通过 PR 放宽自己的限制，合并并升级后就生效 | 未开始 |
| 44 | 允许列表只放 `npm test`、`npm run typecheck`；改到 runner、tracker 真实行为的卡，PR 说明标明“需要人工跑端到端” | 端到端要 token、网络和 Copilot，agent 跑不了；待办 4 的优先级随之提高 | 未开始 |
| 45 | 公开仓库的派发防线：只派发可信作者的 Issue（如作者要有写权限，或配置允许的作者），文档写明 Issue、agent 评论、用量评论和截图分支都是公开的 | 外人提的 Issue 正文可能含提示词注入，现在只靠人不给它打 `agent` 标签 | 未开始 |
| 46 | 给 symphony-copilot 写 `AGENTS.md`：Node 直接跑 TS 的限制（相对导入带 `.ts`、`import type`、不用 enum 和参数属性）、测试写法（`t.mock.timers`）、README 中英文同步、todo 记录规则、提交信息格式 | 仓库里没有 AGENTS.md，这些约定没写下来 | 未开始 |

两个项目同时跑的问题见待办 41。

### 推广（P0 做完再开始）

| # | 待办 | 状态 |
|---|---|---|
| 25 | 用 symphony-copilot 管理自己的开发：建看板，小卡片交给它自己做 | 未开始 |
| 26 | 投稿 github/awesome-copilot；在 copilot-sdk、openai/symphony 的 Discussions 分享；r/GithubCopilot、HN、V2EX | 未开始 |

## 试点记录

| 日期 | 卡片 | 现象 | 原因 | 处理 |
|---|---|---|---|---|
| 2026-09-28 | GH-7 | `git status` 等命令全被白名单拒绝 | 运行时给的 identifier 带子命令（`git status`），规则 `git` 匹配不上 | 已修：`ruleMatches` 兼容，加回归测试（feb9ad0） |
| 2026-09-28 | GH-7 | 交接后卡片被改回“进行中”，差点重新派发 | 看板自动化 “Pull request linked to issue” 设成了进行中 | 看板改为待验证；README 快速开始写入提醒；待办 16 |
| 2026-09-28 | GH-7 | 从受阻放回的卡片按全新任务派发，`attempt` 为空 | 规范里重试计数只在进程内 | 试点提示词要求先看评论和工作区进度；待办 15 |
| 2026-09-28 | GH-7 | `exit` 被拒 | 不在白名单 | 已加入内置白名单（beffd39） |
| 2026-09-28 | GH-7 | 验证日志只在工作区 `work/` 里 | 没有证据保留机制 | 待办 12 |
| 2026-09-28 | GH-7 | 合并后工作区没删 | 终态工作区只在启动时清理 | 待办 13 |
| 2026-09-28 | GH-7 | 一次会话 1 次高级请求、约 1.41 AI credits，但每轮 60–80 万 token | 未查 | 待办 17、18 |
| 2026-09-28 | GH-7 | 两次运行成本差 20 倍：第一次 `auto` 选了 claude-sonnet-5（27 次请求，28.5 credits，接近上限 30），第二次选了 gpt-6-luna（18 次请求，1.41 credits） | `auto` 按任务类型给整个会话选一个模型；账户是按 token 计费（`tokenBasedBilling`），允许超额 | 待办 17、27、28 |
| 2026-09-28 | GH-9 | 45 秒后 agent 主动停下：留言写了分析和接手建议，设为受阻，没有提交代码 | `auto` 选了 claude-opus-5.5，5 次请求就用了 19.7 credits；运行时告诉模型“17.98/30 AI credits used”，模型判断做不完验收就停了。`max_ai_credits: 30` 是按便宜模型定的 | 第二次改用 claude-sonnet-5、预算 150；之后按用户决定改为固定 claude-opus-5.5、不设预算。待办 27、29。另：启动时清理终态工作区（GH-7）已验证可用 |
| 2026-09-28 | GH-9 | `python3 - <<'EOF'`（临时算一下各尺寸的几何数据）被拒 | 白名单只放行 `python3 tools/` | 待定：是否允许临时脚本；待办 14 |
| 2026-09-28 | GH-9 | 第二次运行 11.5 分钟交了 PR #10（claude-sonnet-5，31 次请求，80.4 credits，168 万 token）。方案目视可行，但没跑 iPad Pro 13、没导出改动前截图，PR 里写“额度耗尽” | 运行时提示“75.65/150 used”后 12 秒 agent 就提交了：看到预算就偷工，还把原因说错 | 返工；此后不设预算。印证待办 29 |
| 2026-09-28 | GH-9 | 新登记的技术债用了已存在的编号 TD-05 | 技术债表没写编号怎么取 | 返工意见里指出；试点仓库的技术债表要写明“取最大号加 1” |
| 2026-09-28 | GH-9 | 返工时要求“更新 PR 说明”，但 agent 做不到 | `tracker_submit_for_review` 对已有 PR 只会追加评论，不改 PR 正文 | 待办 31 |
| 2026-09-28 | GH-9 | 返工一次通过：6.5 分钟，claude-opus-5.5，21 次请求，54.4 credits。四条意见全部补齐，还主动说明第一个提交的提交信息里留有错误说法、因为不能强推所以没改 | 不设预算、审核意见写得具体 | 返工流程已验证。这张卡三次运行合计约 154.5 credits |
| 2026-09-28 | — | 常驻运行前梳理失控风险：一轮内请求数、会话内轮数之外，会话之间（续写、失败重试）都没有上限 | 规范按“卡片还在活跃列就继续”设计 | 做了待办 29；实测 `assistant.usage` 的 `copilotUsage.totalNanoAiu` 实时累计与会话总数完全一致，可以在一轮中途按预算停下 |
| 2026-09-28 | GH-9 | 返工结果只发在 PR 评论里，Issue 上看不到；对比图只在本机 `work/`，不会上传，卡片结束连工作区一起删掉 | 提交工具只写 PR；GitHub 没有往 Issue 传附件的公开 API | 提交审核时在 Issue 上发总结；截图走可选的 `attachments`，存到 `symphony-evidence` 分支按提交链接，私有仓库原样输出不走代理。`git clone --config` 设负向 refspec 对首次克隆无效，改为只克隆 main 再拉 `agent/*` |
| 2026-09-28 | — | 检查轮询和进行中任务之间的冲突，写测试复现出两个：①预算停下后记录的是轮询时的旧状态，agent 期间改过状态，下一次轮询误判为“有人挪过卡”又派发一次；②轮询读看板较慢时，旧结果回来后停掉了期间新启动的 worker | 轮询、重试计时器、worker 结束处理在等网络时会互相穿插 | 这三类调度决定改为排队、一次只执行一件；对账只作用于读取时已存在的 worker；停下时记录看板上的实时状态。见 docs/reference.md「Scheduling guarantees」 |
| 2026-09-28 | GH-11 | 一张完整功能卡（气泡指向多位客人、确定载客上限）一个会话用了 66 次 Opus 调用、26 分钟、648 万输入 token，301.7 credits 时被预算停下，移到受阻并留言 | 预算 300 按小卡估的 | 运行上限按设计生效。按这张卡的量，把“实现 + 最多 3 轮审核”的预算定为 1000、会话数 8 |
| 2026-09-28 | — | 加独立审核：新状态“AI 审查”，审核 agent 用 gpt-6-sol、新会话、单独工作区（`-review`，每次重置到已推送的分支）、只读实现者工作区、只有 `tracker_submit_review` 工具；最多 3 轮，之后交给人 | 用户要求每个任务都有独立审核 | 按规范的“状态驱动”做法实现；换角色时结束当前会话，避免实现者在同一会话里审自己 |
| 2026-09-28 | — | 看板自动化 “Pull request linked to issue” 会在新 PR 出现时把卡片设成“待验证”，可能跳过 AI 审查 | 自动化和调度器同时改状态 | 用户已在网页上关掉这个自动化。预算提高到每次运行 2000 credits，GH-11 拖回返工继续 |
| 2026-09-28 | GH-11 | 审核说“已如实登记 TD-12”，但用户在 main 上找不到 | TD-12 在 PR #12 的分支上，还没合并；技术债写在文档里要等合并才可见 | 用户决定以后技术债不写文档，直接建低优先级 Issue：新增 `tracker_create_followup`（标签 tech-debt、P4、待开始，不带 agent 标签，同标题复用，每个会话最多 3 个）；审核提示词要求引用文件时注明是 PR 分支 |
| 2026-09-28 | GH-14 | macOS 弹窗说 VS Code 要访问桌面。agent 找角色原图时用通配符搜主目录，命令卡在授权窗上 30 秒，agent 以为别处也没有原图，把卡设为受阻（原图其实在本机主仓库的 `work/art-raw`） | shell 路径检查漏了通配符和变量；调度器从 VS Code 终端启动，它的子进程发起的授权请求都记在 VS Code 名下 | 弹窗点“不允许”；待办 32、33 |
| 2026-09-28 | GH-13 | PR #22 在待验证时出现合并冲突：#23（CI）先合并，两边都往 `docs/VERIFICATION.md` 末尾追加了记录 | 调度器只看活跃列，等人处理的卡片没人检查 PR 能否合并 | 待办 34 |
