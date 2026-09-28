# symphony-copilot

按 Symphony 规范（本机 `~/Codes/symphony-SPEC.md`）写的本机调度器，把 Codex app-server 换成了 [GitHub Copilot SDK](https://github.com/github/copilot-sdk)：

- 定时读取 GitHub Project 看板；
- 给每张可领取的卡片建一个独立工作区；
- 在工作区里启动 Copilot agent 会话，多轮续写；
- 卡片状态变化时停止或清理，失败时退避重试。

调度规则和提示词放在目标仓库根目录的 `WORKFLOW.md`，随代码一起版本管理，修改后不用重启。

## 运行

需要 Node 24 以上（直接运行 `.ts`，不用编译），并且本机的 Copilot CLI 已登录。

```sh
npm install
export SYMPHONY_GITHUB_TOKEN=$(gh auth token)   # 只给调度器用，不会传给 agent

node src/cli.ts ~/Codes/elevator-manager-simulator/WORKFLOW.md --dry-run --once   # 只读试跑一轮
node src/cli.ts ~/Codes/elevator-manager-simulator/WORKFLOW.md                    # 常驻运行，Ctrl-C 停止

npm test          # 单元测试
npm run typecheck
```

| 参数 | 作用 |
|---|---|
| `--dry-run` | 只读看板、打印“本来会派发哪些”，不建工作区、不启动 agent、不清理 |
| `--once` | 只跑一轮轮询，等派发出去的 worker 结束后退出 |
| `--log-level` | `debug` / `info`（默认）/ `warn` / `error` |

日志是 `key=value` 格式，输出到 stderr；和卡片有关的日志带 `issue_id`、`issue_identifier`，会话日志带 `session_id`。

## 结构

| 文件 | 职责（规范章节） |
|---|---|
| `src/workflow.ts` | 读取、解析、监听 `WORKFLOW.md`；改坏了保留上一份有效配置（§5、§6.2） |
| `src/config.ts` | 带默认值的类型化配置、`$VAR`、`~`、相对路径（§6） |
| `src/template.ts` | Liquid 严格模式：未知变量、未知过滤器都报错（§5.4、§12） |
| `src/orchestrator.ts` | 唯一的调度状态：轮询、派发、对账、卡死检测、重试（§7、§8、§16） |
| `src/workspace.ts` | 工作区命名、根目录限制、四个 hook（§9） |
| `src/runner.ts` | Copilot SDK 会话与多轮循环（§10、§16.5） |
| `src/policy.ts` | agent 工具的权限判定（§10.5、§15） |
| `src/tracker/github-project.ts` | GitHub Project 适配器与 agent 工具（§11） |

## Codex app-server 与 Copilot SDK 的对应

| 规范概念 | 本实现 |
|---|---|
| `codex app-server` 子进程 | 每个 worker 一个 `CopilotClient`，stdio 方式启动 SDK 自带的 CLI（或 `copilot.cli_path`） |
| thread / turn | `createSession({ workingDirectory: 工作区 })` 的 `sessionId`；一次 `send()` 到主 agent `session.idle` 算一轮 |
| `session_id` | `<sessionId>-<轮次>` |
| 续写 | 同一会话再 `send()` 一次 `agent.continuation_prompt` |
| turn 失败 / 取消 | `session.error` / `session.idle` 且 `aborted` |
| `turn_timeout_ms` | 两个会话事件之间的最长静默，超时就 `abort()` |
| token 统计 | 累加 `assistant.usage`，以会话绝对值上报，调度器只计增量 |
| rate limits | `account.getQuota` 的快照 |
| `codex` 配置块 | `copilot` 配置块（见下） |

## `WORKFLOW.md` 配置

规范里的核心键（`tracker`、`polling`、`workspace`、`hooks`、`agent`）含义和默认值都照规范，只多了 `agent.continuation_prompt`：续写时的提示词，Liquid 模板，可用变量 `issue`、`turn`、`max_turns`。

`copilot` 是扩展块：

| 键 | 默认 | 说明 |
|---|---|---|
| `cli_path` | SDK 自带运行时 | 指定 Copilot CLI 可执行文件 |
| `model` / `reasoning_effort` | 运行时默认 | 传给 `createSession` |
| `max_ai_credits` | 无上限 | 每个会话的 AI Credits 软上限；用完判为 `budget_exhausted` 并重试 |
| `startup_timeout_ms` | 60000 | 启动运行时、建会话的超时 |
| `turn_timeout_ms` | 3600000 | 一轮里两次事件间的最长静默 |
| `stall_timeout_ms` | 300000 | 调度器按事件间隔判断卡死；`<= 0` 关闭 |
| `shell_allow` / `shell_deny` | 见 `src/config.ts` | 命令白名单 / 黑名单 |
| `read_allow` | Xcode、CommandLineTools | 工作区之外允许只读的目录 |
| `url_allow` | 空 | 允许访问的 URL 前缀 |
| `user_input_reply` | 中文固定答复 | agent 提问时的自动回答 |

hook 用 `bash -lc` 在工作区里执行，环境变量里去掉了 tracker 令牌，额外提供 `SYMPHONY_ISSUE_ID`、`SYMPHONY_ISSUE_IDENTIFIER`、`SYMPHONY_ISSUE_BRANCH`、`SYMPHONY_WORKSPACE`、`SYMPHONY_WORKSPACE_KEY`。工作区路径上如果已有文件或符号链接，本次尝试直接失败，不会删除或替换它。

## 信任边界与权限策略

适用于**单用户、可信的本机环境**，不是沙箱。

- **运行位置**：agent 只在自己的工作区里运行（cwd 等于工作区，工作区必须在 `workspace.root` 之下）。
- **tracker 令牌**：只在调度器进程里用；agent 进程和 hook 的环境变量都去掉了 `SYMPHONY_GITHUB_TOKEN`、`GH_TOKEN`、`GITHUB_TOKEN` 等。
- **权限判定**：由 `src/policy.ts` 逐项决定：
  - 写文件：只允许工作区内，符号链接解析后仍须在工作区内。
  - 读文件：工作区，加 `read_allow` 列出的目录。
  - shell 命令：
    - 每一段命令都要在白名单里，且不命中黑名单。默认禁止 `git push`、`git remote`、`git config`、`git -c`、`git -C`、`gh`、`curl`、`wget`、`ssh`、`sudo`、`open`、`osascript`、`security` 等。
    - 会写入的命令只能碰工作区里的路径；命令里带 URL 就拒绝；要求绕过沙箱也拒绝。
  - 网络访问、MCP 工具、memory 等其他请求一律拒绝，只有调度器注册的 `tracker_*` 工具放行。
  - 托管策略要求真人确认的请求，回答"无人可确认"。
- **提问**：agent 提问时自动回答 `user_input_reply`，不会一直干等。
- **已知缺口**：本机 `gh` 的登录保存在钥匙串里，只靠上面的命令黑名单拦住 agent 使用它。`find -exec`、`python3 tools/…` 这类命令仍然可能间接执行任意操作。要更强的隔离，请用单独的 macOS 用户运行调度器。

## 适配器说明：`tracker.kind: github_project`

- **`tracker.provider` 的键**：
  - 必填：`owner`、`project_number`、`repo`（`owner/name`）。
  - 选填，括号里是默认值：
    - `owner_type`（`user`，或 `organization`）；
    - `token`（`$SYMPHONY_GITHUB_TOKEN`，这是密钥，值为空也算缺失）；
    - `endpoint`（`https://api.github.com/graphql`）；
    - `status_field`（`Status`）、`priority_field`（`Priority`）；
    - `identifier_prefix`（`GH-`）、`branch_prefix`（`agent/`）；
    - `agent_states`（空，表示不提供 `tracker_set_status`）；
    - `handoff_state`（空，表示提交审核时不改状态）。
  - 配置错误报 `invalid_tracker_config`，令牌缺失报 `missing_tracker_secret`。
- **范围**：只看这个 Project 里、来自 `repo` 的 Issue；草稿、PR、其他仓库的 Issue 都忽略。按状态查询时每页 100 条，最多 100 页；按 ID 查询时每批 100 个。
- **字段映射**：

| 字段 | 取值 |
|---|---|
| `id` | Project item ID |
| `native_ref` | `project_item_id`、`issue_id`、`issue_number`、`repository` |
| `identifier` | `GH-<编号>` |
| `branch_name` | `agent/<编号>` |
| `state` | Status 选项名；没设 Status 时为 `No Status` |
| `priority` | 单选名里的数字（如 `P2` 取 2），或数字字段的整数值 |
| `labels` | 小写、去空白、去重 |
| `blocked_by` | GitHub Issue 依赖关系 |
| `dispatchable` | Issue 未关闭、项目条目未归档、所有前置 Issue 都已关闭 |

- **格式不对的条目**：按状态查询时跳过并记日志；按 ID 查询时直接报错，因为漏掉一条会被误当成"已不可见"。
- **错误分类**：
  - 网络失败：`tracker_request`；
  - HTTP 非 2xx：`tracker_status`；
  - 429、403 且剩余额度为 0、GraphQL 返回 `RATE_LIMITED`：`tracker_rate_limited`；
  - 其他 GraphQL 错误或 JSON 解析失败：`tracker_response`；
  - 有下一页却没有游标：`tracker_pagination`。

  调度器只区分成功和失败。
- **agent 工具**：都只能操作当前这张卡片，在调度器进程里用它的令牌执行：

| 工具 | 是否改看板 | 作用 |
|---|---|---|
| `tracker_get_issue` | 否 | 看板状态、正文、评论，以及对应分支上打开的 PR 的审核意见 |
| `tracker_comment` | 是 | 在 Issue 下评论 |
| `tracker_set_status` | 是 | 只能改成 `agent_states` 里的状态 |
| `tracker_submit_for_review` | 是 | 要求改动都已提交；把 HEAD 推到 `agent/<编号>`，创建 PR（写 `Closes #编号`）或在已有 PR 下留言，再把状态改成 `handoff_state` |

  工具出错时返回失败结果，会话继续。

## 和规范的差异、后续计划

- 没做可选的 HTTP 状态接口（§13.7）。`Orchestrator.snapshot()` 已经按 §13.3 给出了数据。
- 和规范一样，重启后不恢复重试队列，靠重新读取看板和保留下来的工作区恢复。
- 后续：
  - M2：用一个小 Issue 端到端跑通到"待验证"；
  - M3：验证返工和中断；
  - M4：状态接口；
  - M5：每个 agent 一台复制出来的模拟器，支持并发。
