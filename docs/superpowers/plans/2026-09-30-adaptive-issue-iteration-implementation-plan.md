# 自适应 issue 迭代：实施计划

日期：2026-09-30
状态：计划已确认并实施，离线验证完成；未提交，未进行真实服务试跑。

依据：[已确认设计](../specs/2026-09-30-adaptive-issue-iteration-design.md)。本计划采用普通代码分析流程编写，不新增技能或依赖；用户已明确确认“开始实施并验证”。以下任务记录实施顺序，末节记录执行结果。

## 1. 范围与基线

本次只实现已确认的行为：实际启动的实现／review 会话共用 20 次额度；Todo 重新授权；启动前失败直接 Blocked；reviewer 有效退出及基于进展的返工；完整 issue 交接；一行尽力展示的用量；移除费用及独立审查次数限制。

不做 reviewer 代码提交、外部共享文档、操作者追踪、强制定时审查、绝对时长限制、持久化用量补写队列、终态重新开工、新依赖或真实看板变更。不自动提交、推送、安装个人技能或启动服务。

2026-09-30 在当前含既有未提交改动的工作区运行：

| 命令 | 实际结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm test` | 159 个测试通过，0 失败 |
| `./bin/symphony check WORKFLOW.md` | 无问题 |
| `./bin/symphony check examples/WORKFLOW.md` | 0 错误；仅项目编号未填写的预期警告 |
| `git diff --check` | 通过 |

这是旧行为的基线，不是新功能的验收结果。保留现有未提交的完整上下文分页、权限隔离、长输出清理和主动验证提示词改动；不得通过回退这些改动换取测试通过。

## 2. 执行方式与顺序

建议在当前工作区串行实施，沿用现有 Node 测试框架与 SDK mock。调度器、运行器和 tracker 接口共同变动，避免多个实现 agent 同时写这些文件。可在各阶段后安排只读复核，不另外运行真实的 Symphony worker。

顺序：配置契约 → 最小控制账本／纯决策 → 会话启动确认 → review 与关键交接 → 调度集成 → 用量尾行 → 提示词与说明 → 全量验收。

每个任务先写失败测试，再改对应实现，最后运行类型检查及测试。中间允许为接口迁移暂时调整 mock，但阶段结束必须恢复绿色；不长期保留同时执行的新旧限额逻辑。不执行任何 Git commit，后续是否提交由用户决定。

## 3. 最小接口边界

复用现有组件，不建立新平台。可新增一个小型纯迭代策略模块，存放有表驱动测试的继续／暂停规则；GitHub 请求仍在 adapter，持久化仍在现有账本。

- **稳定 issue 身份**：从已验证的 repository 和原生 issue node ID 构造控制键。Project item ID 仍用于请求看板，只作为可更新映射；不凭显示标题猜身份。FakeTracker 显式提供测试身份。
- **调用身份**：宿主生成 invocation ID，记录所属授权、角色、启动状态；不在派发时扣次数。成功的 SDK session ID 与调用绑定，得到固定序号。
- **启动确认**：增加可等待的 `onSessionCreated(invocationId, sessionId)` 控制回调；返回前必须完成一次性计数和关键保存。普通 `onUpdate` 保留日志、tokens 等遥测职责，不承担可以丢失的计数副作用。
- **结果接受**：结构化 review／实现交接通过 `acceptResult` 保存，返回固定结果标识和下一步；重复提交同一结果直接复用，不能重复结算返工。
- **发布恢复**：仅为每个 issue 当前未完成的核心交接保存结果、目标状态和已经完成的发布步骤。工具正常路径和宿主恢复路径共用发布代码，不维护一般性的消息队列。
- **用量展示**：当前调用仅在内存保留自己的 issue 消息引用；收尾时尽力补写一次尾行。缺数据、消息删除或编辑失败都不进入核心交接恢复。

控制回调必须检查调用归属。不要在等待 worker 完成的串行临界区中，再等待由该 worker 触发的控制回调，以免死锁。已发送的远程请求不能撤回，不能用本地取消标记声称实现了远程原子性。

## 4. 分步任务

### 任务 1：统一配置契约和迁移检查

**修改位置：** [src/config.ts](../../../src/config.ts)、[src/check.ts](../../../src/check.ts)、[schema/workflow.schema.json](../../../schema/workflow.schema.json)、[src/tracker/github-project.ts](../../../src/tracker/github-project.ts)、[src/board.ts](../../../src/board.ts)。对应测试为 [test/config.test.ts](../../../test/config.test.ts)、[test/check.test.ts](../../../test/check.test.ts)、[test/board.test.ts](../../../test/board.test.ts) 和 [test/helpers.ts](../../../test/helpers.ts)。

1. 在 GitHub provider 配置中增加明确的 `start_state`、`working_state`；本项目映射为 Todo、In Progress。通过 adapter 的规范化生命周期配置提供给调度器，不在调度器猜英文列名或数组顺序。
2. `agent.max_sessions` 默认改为 20，保留正整数校验；移除两个费用配置和 `review.max_rounds`。在运行时和离线检查中显式拒绝旧键，并指出迁移方式，不能仅删 schema 后由 runtime 静默忽略。
3. 在 runtime 也执行状态交叉校验：起始／工作／review 列不能混用；自动交接目标、返工目标及 agent 可设状态不得指向起始列；Blocked 为等待列且不参与自动冲突恢复。
4. 调整 `boardStates()`／`desiredBoard()` 的列说明，标明人工入口和调度器运行列，沿用现有排序和自定义名称能力；不修改真实看板。
5. 更新 `everyKey` 的 schema 漂移测试。旧键检测不应被误计为受支持配置读取；同时保留“schema 与正常配置读取一致”的校验能力。
6. 同步调整涉及这些配置的测试 fixture，以及根工作流、示例的 front matter，使阶段结束可检查；提示词正文和文档说明在任务 7 完成。

**新增断言：** 默认 20；旧三个限制键明确报错；中文列名能工作；自动返回 Todo 被拒；正常新建 follow-up 放 Todo 且无派发标签仍允许；普通与 review 工作流均能校验。

### 任务 2：账本保存授权、实际会话与返工状态

**修改位置：** [src/ledger.ts](../../../src/ledger.ts)、[src/tracker/types.ts](../../../src/tracker/types.ts)、[src/types.ts](../../../src/types.ts) 中确有必要的身份信息。新增账本专项测试与纯迭代决策测试；现有调度 fixture 位于 [test/orchestrator.test.ts](../../../test/orchestrator.test.ts)。

1. 账本做一次格式迁移，保留稳定 issue 键、当前 item 映射、授权 ID／限额／已用次数、等待或暂停原因、当前 invocation、返工关联和连续无进展次数、已知累计用量。
2. 提供原子文件替换后的显式成功／失败结果；关键保存错误必须向调用者传播，不能使用当前只记录日志的 `saveLedger()` 行为继续派发。
3. 提供明确操作：创建／消费授权、记录启动中、确认会话并计数、接受结果、结算返工、记录暂停与正常等待。不让调用方随意修改多个字段后忘记保存。
4. 同一 invocation/session 重复确认不加次数；尚未确认的启动不算成功，也不能被第二次派发覆盖。
5. 一份 pending 核心结果只保留发布恢复所需的正文和阶段；发布完成后清除正文，保留必要引用和控制状态。不得加入尾行待补写字段。
6. 旧账本根据实际取到的 issue 做身份映射，保留已知计数和费用；旧停滞信息不可恢复时从新的有效评估开始。只有 item ID／显示 identifier 而无法唯一映射的记录暂停，不推断为新任务。

**纯规则测试：** 初审不计停滞；一次无进展继续；两次不同返工无进展暂停；有效进展归零；运行失败不增减；重复结算无效果；批准优先作为成功交接，不能因它恰为第 20 次而报失败。

### 任务 3：SDK 会话确认和启动失败出口

**修改位置：** [src/runner.ts](../../../src/runner.ts)、[src/cli.ts](../../../src/cli.ts)、[src/orchestrator.ts](../../../src/orchestrator.ts) 的 worker 参数与确认回调、[test/runner.test.ts](../../../test/runner.test.ts)。

1. 复用 `runAgentAttempt()` 生命周期，在成功创建会话后等待持久化确认，再渲染／发送工作提示词；以此保留“成功创建计一次，首个请求失败仍计一次”的边界。
2. 为准备工作区、hook、runtime start、session create 和已启动后运行故障保留可区分的阶段，不仅依赖目前混用的 `response_timeout` 错误码。
3. 已安装 SDK 的 `SessionConfig.sessionId` 支持调用方指定 ID，可用宿主生成的 ID关联启动记录；它只是关联能力，不代表 `session.create` 幂等或跨进程创建结果必然可恢复。
4. 保留原始启动／创建 promise，处理超时或取消后晚到的成功结果：不发送任务，清理会话和 runtime，向宿主报告确认结果。无法确认的启动保持暂停，禁止直接重试第二个会话。
5. 保存确认失败时停止当前会话。进程重启留下启动中记录时，保守核对；不能确认则 Blocked，而不是静默赠送未记账的调用。
6. 不删除现有 per-session 长输出目录、读取权限和分层清理测试；SDK runtime 施加的费用限制不再传入。供应商自身报错仍作为运行错误，不伪装为 Symphony 费用阈值。

**复用 fixture：** `setup()`、`Behavior.start/create/turn`、SDK prototype mocks、真实 `WorkspaceManager`。补测保存延迟期间不调用 `send`、保存失败清理、start/create 超时、取消和晚到结果；这些是当前基线未覆盖的组合。

### 任务 4：review 结果、完整交接与有效 Blocked

**修改位置：** [src/tracker/types.ts](../../../src/tracker/types.ts)、[src/tracker/github-project.ts](../../../src/tracker/github-project.ts)、运行器结果完成标记和控制回调。复用 [test/github-project.test.ts](../../../test/github-project.test.ts) 的 `reviewFetch()` 及提交 fixture。

1. 去掉 `ReviewToolContext.maxRounds` 和只传字符串的 `onVerdict`；传入 invocation、初审／返工关联、宿主控制接口。
2. 实现设计中的 `reviewed_head`、`progress`、`progress_reason`、`next_action`、`next_step`；验证字段组合。`unable_to_verify` 可缺 SHA，但必须说明缺失条件，不能作为质量批准或停滞评估。
3. 保留 reviewer 的受限工具集，通过 `tracker_submit_review` 的明确无法继续结果进入 Blocked，不给它一般状态设置、push 或实现提交能力。
4. 实现者沿用评论加受限 Blocked 状态路径；用当前 invocation 关联其完整说明和暂停结果，不为此增加通用聊天工具。正常提交的 summary 包含失败尝试、证据、下一步和代码 SHA。
5. 工具先完成输入、角色、Git 和必要只读查询校验，再接受并保存关键结果。已接受后，issue 记录与 PR 展示／状态更新失败由同一发布代码恢复，不重新调用 agent 作同一结论。
6. 将完整 issue 正文作为独立的核心发布步骤，持久化接受后优先发布，不排在 PR review／展示写入成功之后。PR 部分失败仍保留可恢复的完整 issue 记录，不能只保存一个链接。PR 继续保留现有代码审查用途，不扩展到独立历史存储或批量镜像所有人工评论。
7. 以 invocation/result 标记和已知消息 ID核对未知创建结果，避免响应丢失后盲目重复评论。保持一份当前核心交接，不创建通用发布队列。
8. 实现者正式交接后才让 reviewer 结算相应返工；已经有开放 PR、HEAD 未变时允许交接失败尝试。未提交不启动额外 reviewer，重复 review 不能把一次返工算两次。

**审查版本检查：** 接受有效质量结果前核对远端 `headRefOid`；发布 review 时绑定被审 commit。最终状态交接前再核对版本。若期间已变更，不批准新代码、不用旧结果结算它的进展；先完成旧 SHA 的 issue 证据发布、标记为已过期并取消旧目标状态，清理这份 pending 结果后，才能让尚有额度的 reviewer 检查新 head，否则暂停。不得用新 review 覆盖尚未处理的旧结果。暂停／停止信号仍优先于自动再审。该处理只针对版本变化，不修改分支。

**完成边界：** 运行器看到已接受的终结结果后不再发 continuation，后续 tracker refresh／disconnect 错误不触发另一次语义执行。数据格式错误、校验未通过则仍可在当前会话中纠正。

### 任务 5：把新控制状态接入调度流程

**修改位置：** [src/orchestrator.ts](../../../src/orchestrator.ts) 的 `pollOnce()`、`closeFinishedRuns()`、`admit()`、`dispatch()`、`recordUsage()`、`onWorkerExit()`、`onRetryTimer()`、`returnConflicted()`、`reconcile()`；[test/orchestrator.test.ts](../../../test/orchestrator.test.ts)。

1. 不再因“未出现在 active candidates”删除账本。每轮按列查询须覆盖起始列、运行列和相关人工等待列，使用查回的原生 issue 身份更新 item 映射，才能识别等待 → Todo 和 item 重加。已保存 item ID的查询仅作运行中刷新，不能是恢复等待卡片的唯一来源；缺失不推断为终态或新授权。
2. 首次合法 Todo 创建并消费授权；再次观察到同一个 Todo 或失败重试不再授予。已记录 Blocked／Human Review 回 Todo 才重置当前会话和停滞计数，累计用量保留。
3. 先持久化接管并移到 working state，确认允许执行再派发；无槽位时不启动，不扣次数。更新状态超时只恢复本次转换，不创建新授权。
4. `runLimitReached()` 只检查当前授权保存的会话总上限；删除费用中止路径。会话 20 可正常收尾：批准 → Human Review；尚需实现或 review → Blocked，并说明是否未经审查。
5. 启动前失败立即记录暂停并发布故障阶段、进入 Blocked；不要进入当前普通 worker 退避重试。启动后失败仍使用剩余额度；正常停止服务不改成业务失败，不触发后台自我重启。
6. 工具提交和角色交接只沿用本周期；持久化暂停不得被远端活跃状态或冲突恢复覆盖。正常 Human Review 的合并冲突恢复可使用剩余额度，不新开周期。
7. 有效 invocation 以外的新工具请求不能改看板；已发出的远程请求先核对再交接。保留已有 stale-poll、并发槽位、重试与关闭测试，不实现操作者追踪。
8. Issue 关闭后不再派发；配置终态继续执行既有清理。项目 item 重加使用同一个原生 issue 控制记录。首次发现无可恢复账本的运行列卡片只报告需要人工接管，不凭它所在列发放新额度。

**核心恢复表：** 已保存但未完成的状态交接，观察到目标态则结束该动作，观察到仍为来源态则重试同一动作；观察到关闭／终态则取消旧动作，不覆盖它；其他不能确认的状态暂停。这个表用于恢复已知动作，不用于判定是谁移动卡片。

**fixture 调整：** 给 `FakeTracker` 增加明确生命周期配置和结构化结果回调，`finishSession()` 必须模拟真正的会话确认。将旧的“每次 handoff 清零”“费用即时杀会话”“初始运行列直接获得额度”测试替换为新行为断言，而不是直接删掉覆盖。

### 任务 6：一行用量，失败不影响交接

**修改位置：** [src/runner.ts](../../../src/runner.ts) 的 `SessionSummary` 和 metrics 收尾、[src/orchestrator.ts](../../../src/orchestrator.ts) 的 `formatUsageReport()`／`sessionReport()`／`reportSession()`、[src/tracker/github-project.ts](../../../src/tracker/github-project.ts) 的消息引用与更新方法。

1. 日志继续输出完整摘要。停止以 `reportSession()` 独立新增用量评论，将展示格式改为仅返回规定尾行或 `null`。
2. 实时 usage 与最终 metrics 合并不重复相加；记录是否真正取得用量，不能把默认数值 0 当作观测值。模型来自实际事件／metrics，不回退为配置里的 `auto`。
3. 使用本次 issue 结果消息 ID和 invocation 标记，收尾后读取最新正文，仅替换／追加本次尾行。主实现只要求 issue 尾行，不为 PR 多种对象增加额外更新面。
4. 正常格式：用量（本轮）：12.34 · 轮次 6/20 · 模型：xxxx。多个实际模型去重列出；序号和上限取本次启动时固定值，不读取后来周期的可变计数。
5. 指标不可靠、读取或更新失败、用户改掉标记、消息删除，均跳过并记录日志；不重跑 agent、不发替代用量评论、不持久化补写队列。
6. 未发布过语义交接而失败的调用仍发必要的故障说明，有可靠用量才附尾行；这不是允许重新引入纯用量消息。`usage_comments=false` 仅关闭尾行，不关闭必要的错误说明。

**测试：** 正常尾行一次；重复回调不重复追加；真实零与未知不同；多模型；metrics 晚于提交；消息正文人工编辑；消息被删除；编辑失败；20次边界；关闭开关；完整日志仍存在；失败不产生新的 worker。

### 任务 7：提示词、onboarding 与文档同步

**修改位置：** [WORKFLOW.md](../../../WORKFLOW.md)、[REVIEW.md](../../../REVIEW.md)、[examples/WORKFLOW.md](../../../examples/WORKFLOW.md)、[examples/REVIEW.md](../../../examples/REVIEW.md)、[src/config.ts](../../../src/config.ts) 的默认 continuation、[src/check.ts](../../../src/check.ts) 的模板样例、[skills/symphony-onboard/SKILL.md](../../../skills/symphony-onboard/SKILL.md)、[skills/symphony-write-card/SKILL.md](../../../skills/symphony-write-card/SKILL.md)、[README.md](../../../README.md)、[README.zh-CN.md](../../../README.zh-CN.md)、[docs/reference.md](../../../docs/reference.md)、[docs/onboarding.md](../../../docs/onboarding.md)。

1. 移除 `max_review_rounds` 提示词变量和旧轮数上限措辞；区分审查序号、SDK 会话内 turn 与总调用数，不诱导 reviewer 按“最后一轮”勉强批准。
2. 强化实现者的外部依赖／授权／确认无法实现退出条件，保留“能在现有范围解决就继续”和证据要求；reviewer 使用有效 Blocked 结果而非仅评论后停止。
3. 把完整实现、review、阻塞记录放 issue；要求处理过的 PR 人工意见和关键约束写回交接。保留完整分页和原始输出阅读要求，不宣称所有人类评论自动同步。
4. Onboarding 明确人工只从等待态回待开始重新授权，运行三列由调度器管理；这是约定，不是技术锁定。写卡流程使用明确 `start_state`，不再使用“第一个 active state”作为启动入口。
5. 更新配置表、费用说明、示例、工作流检查和看板列说明，说明费用只供人工参考、启动失败不扣次数且暂停、用量尾行异常可缺失。
6. 同步 [test/review-prompts.test.ts](../../../test/review-prompts.test.ts) 等文本契约。保留已有不变量推导、失败类修复、独立反例与 scratch 清理要求。

个人已安装技能副本不在本次自动修改范围内；先更新仓库内来源，后续按用户确认的安装步骤同步。不要为修改技能文件自动安装任何扩展或插件。

### 任务 8：整体复核与交付

1. 执行 `npm run typecheck`、`npm test`、根工作流与示例的离线 `symphony check`、`git diff --check`。
2. 全面检查已移除字段的引用，不能留下 runtime、schema、README 翻译、默认提示词或 fixture 仍认为费用／review 上限存在的情况。
3. 用假的 tracker/SDK 串联演练：Todo → 实现 → review 请求修改 → 返工 → 连续两次无进展 → Blocked → 人工 Todo → 新额度；另测超过三次 review 仍有进展继续、20次未审实现、启动前失败、终态关闭。
4. 对重启点做故障注入：授权保存后状态更新前、创建成功后确认保存前、结构化结果接受后 issue 发布前、issue 发布后状态交接前。保证核心控制不会因收尾错误重复跑模型；用量丢失可忽略。
5. 检查所有 workspace cleanup 和长输出权限回归，确认没有扩大 reviewer 写权限、网络或任意命令权限。
6. 提供实际执行结果和剩余人工检查项。未跑真实看板／付费 agent 就明确写未验证；不把159个旧基线测试通过当作新功能证明。

## 5. 验收追踪

| 设计验收项 | 主要任务与测试 |
| --- | --- |
| 实际启动计数、20次边界、启动失败不扣 | 任务2、3、5；ledger／runner／orchestrator |
| Todo 单次授权、等待态恢复、item 身份与重启 | 任务2、5；ledger／orchestrator |
| 自动冲突恢复不赠送额度、终态不自动恢复 | 任务5；orchestrator |
| 两次真实返工无进展、同 SHA、有效 reviewer 阻塞 | 任务2、4、5；纯策略／tracker／runner |
| 核心交接不重复执行、取消后旧调用不改新周期 | 任务3、4、5；延迟 promise 与发布故障注入 |
| Issue 全文独立于 PR、旧分页和长输出保留 | 任务4、7、8；issue-context／runner／提示词 |
| 用量准确且尽力展示，没有独立费用消息 | 任务6；tracker／runner／orchestrator |
| 配置迁移、列映射、onboarding、中英文一致 | 任务1、7、8；config／check／board／模板 |

## 6. 执行记录（2026-09-30）

任务 1–8 已实施并通过离线验证。主要新增控制逻辑见 [src/iteration.ts](../../../src/iteration.ts)、[src/ledger.ts](../../../src/ledger.ts)；运行器、调度器、GitHub adapter、配置、提示词与中英文文档同步更新。保留此前未提交的上下文和长输出改进，未扩大 reviewer 的实现代码或推送权限。

| 最终执行 | 实际结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm test` | 321 项通过，0 失败、0 跳过 |
| `./bin/symphony check WORKFLOW.md` | 无问题 |
| `./bin/symphony check examples/WORKFLOW.md` | 0 错误；仅项目编号未填写的预期警告 |
| `git diff --check` | 通过 |

新增 [账本测试](../../../test/ledger.test.ts)、[迭代决策测试](../../../test/iteration.test.ts) 和 [完整调用链测试](../../../test/iteration-integration.test.ts)，并扩展运行器、tracker、调度器与配置测试。

完整调用链使用真实 Orchestrator、运行器、账本和 GitHub adapter，SDK、HTTP、Git 执行均为测试替身：验证 6 次实际模拟会话、3 次 review、两次无进展返工后 Blocked、6 份完整 issue 记录和相应尾行；随后等待列回 Todo 获得新的 1/20，保留已有记录和 workspace。另测启动失败不计会话、不计费用、不自动重试。这证明离线组件协作，不代表真实 GitHub／模型服务已验证。

独立复核后修复并增加回归：

- 启动结果不确定必须有持久化保护，不能靠重启或 Todo 移动清除；晚到会话成功创建只计一次，且不发送工作提示词。
- 已发布的完整 issue 记录在交接恢复前被删除或改坏时，先恢复可验证的完整记录，不能仅凭保存的 comment ID继续交接。
- GitHub 原生 issue 关闭优先于仍未改变的看板列，终止执行并清理 workspace。
- 精确匹配的旧 Project item ID不因其他旧记录恰有相同显示编号而无法迁移。
- 质量审查始终验证本地 HEAD，缺失 Git checkout 不能跳过校验；`unable_to_verify` 仍可不依赖 PR 或 SHA 进入 Blocked。

运行边界：宿主崩溃后若无法确认旧启动或清理结果，任务保持暂停，需要人工核对残留 runtime／账本；正常启动失败则仍按 Blocked → Todo 恢复。用量尾行是尽力展示，不添加持久化补写队列。

未执行真实 GitHub 看板变更、真实 Copilot 会话、服务启动／重启、远程推送或工作仓库提交。测试中的临时 Git fixture 与 mocks 不代表上线验证。个人已安装技能副本也未自动更新。

上线前由用户决定服务切换和真实小任务试跑，并验证账号权限、真实 SDK 生命周期、看板状态与尾行展示。是否提交、推送或同步个人技能由用户另行决定。