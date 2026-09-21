# 更新日志

本文件记录 `dsh-plugin-codegraph-project` 的所有重要变更。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.0] - 2026-09-21

### 新增

- **按项目根共享一个 CodeGraph 实例**：每个项目一个 `codegraph serve --mcp` 进程（经 `npx` 启动，不依赖全局安装、不进 PATH），被该项目下所有会话按引用计数共享。同一仓库两个会话共用一个进程，两个仓库各一个。
- **按 workspace 自动识别与切换**：会话的 workspace 目录按 CLI 同口径向上解析到第一个**含索引库**的 `.codegraph/`；`~/.codegraph`（CLI 自己的安装目录，长得像索引目录但没有库）被显式排除。
- **版本可配置**：行配置 `version`（默认实测过的 `1.6.0`）拼接为 `@colbymchenry/codegraph@<version>`；`packageSpec` 作为镜像源 / 私有 registry / 本地 tarball 的逃生口；同名子集以 settings 命名空间 `codegraph-project` 发布，用户层优先于行配置，非法覆盖被拒绝且行配置继续生效。
- **未索引项目调不动 CodeGraph**：任何项目上线前不注册任何工具；项目在线后，workspace 没有索引的会话调用会被守卫拒绝，拒绝文本写明该 workspace 已给出对应的 `codegraph init` 命令。
- **初始化后动态启用**：未索引的 workspace 由观察者按 `pollIntervalMs` 轮询，索引一出现就挂载项目并给**正在运行的会话**放行，无需重启或重开会话。
- **受管子进程，四层防孤儿**：`ctx.subprocess`（`detached` 进程组）→ stdin EOF 优先（实测 CodeGraph 在 10ms 内退出）→ 进程组 TERM/KILL 阶梯 → 子进程服务 dispose 时终止并等待退出 → `CODEGRAPH_HOST_PPID` 交给 CodeGraph 自带看门狗，覆盖 harness 被强杀的情况。
- **断线透明重连**：服务崩溃后下一次工具调用自动重连一次；重连失败会作为工具错误返回（含捕获的 stderr 尾部），而不是静默成功。
- **工具集同步**：`notifications/tools/list_changed` 触发重同步，按「先取新世代、再整体替换」的顺序，失败保留旧世代。
- 可选诊断工具 `codegraph_project_status`（`diagnosticTool: true`）：报告本会话状态、解析到的项目根、每个存活实例的 pid、以及当前版本对应的 `init` 命令。
- 可选提示词段（`usageGuidance`，默认开）：**只对已挂载的会话**注入项目根与工具名，并提示用 `codegraph_explore` 代替 grep/read 循环。

### 说明

- **工具注册在根注册表，按会话的访问控制由守卫完成**。这是实测出来的平台约束，不是设计偏好：DSH 0.1.5-rc.2 组装模型工具列表时传入的是 **Agent 对象**而不是注册表分层所用的 **scope key**，因此通过 `agent.ctx` 注册的工具到不了模型——会话自己的 `schemas(scopeKey)` 视图里有它，而 `systemPrompt.assemble({ agent, scope: agent })`（agent loop 的实际调用）返回空列表；`restrict()` 同样按 scope key 求值，也无法按会话隐藏工具。实际影响：有项目在线时工具会出现在该进程内所有会话的列表里，守卫负责让未索引的会话用不了它。若 DSH 后续修正组装，注册可移回 `agent.ctx`。
- **每次模型请求开始时组装工具列表**，而连接一个项目约需两秒（`cliProbe` 预热缓存后更快）。交互式会话里工具通常在你打完字前就绪；程序化驱动的会话可能需要在首个 prompt 前等挂载完成。插件为每个项目挂载打一行日志（pid + 工具名）。
- **版本切换作用于下一次项目连接**；已连上的会话保持启动时的版本，避免中途抽走正在使用的工具。
- **不写用户项目、不改 `cordis.patch.yml`**：唯一的写入是可能创建 `cacheDir`（默认 `~/.dsh/codegraph/npm-cache`）以及用户从设置面发起的 settings 文档写入。建索引始终是用户的决定，插件绝不自动 `init`。
- **私有 registry 凭据**：harness 会把 `*TOKEN*` 之类的环境变量从子进程中清洗掉；需要认证时请用预热好的缓存目录，或 `file:`/tarball 形式的 `packageSpec`。

### 验证

- `npm test` 68 项：`locate`/`config`/`transport`/`pool`/`agent-tools`/`poll` 单元测试，以及把插件挂进**真实 Cordis 运行时**（真实 tools/systemPrompt/subprocess 服务，MCP 端用 stub）的集成测试：未索引不 spawn 且调用被拒、已索引可调用、同项目两会话共享一个进程、中途建索引在当前会话内放行、释放后注销并回收。
- `scripts/real-codegraph-e2e.mjs` 驱动**真实 CodeGraph 1.6.0**：连接并列出工具、真实查询返回源码、两家话共享同一 pid、未索引项目无实例、中途 `init` 后立即可用、关闭后进程全部回收。
- 真实 harness 持久会话（`@deepseek-ai/dsh-sdk-minimal` 的 JSON-RPC 通道）实测：模型请求的 `request/header.tools` 由 `["bash"]` 变为 `["bash","mcp__codegraph__codegraph_explore"]`。
- bundle patch 在真实 profile 装配下正常引导，无「未激活」报错。
