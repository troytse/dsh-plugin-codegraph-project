# 更新日志

本文件记录 `dsh-plugin-codegraph-project` 的所有重要变更。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.3] - 2026-09-30

这一版全部来自一次针对 **DSH 0.2.0 桌面版**的生产就绪复审：1 个阻塞、1 个严重、7 个中等，全部修复并各自配了回归测试（79 → 90 项）。

### 修复

- **行配置非法不再拖垮宿主（阻塞）**：`validateConfig` 失败原先直接 `throw`，而 loader 只按 `Config` schema 校验行配置——`toolCallTimeoutMs: 0`、`pollIntervalMs: 100`、`serverName: 'code.graph'` 这类「schema 放行、语义非法」的值会让该行变成**未激活**，桌面版随即判定启动失败并进入 profile 恢复流程（本轮实测过同类后果）。现在改为逐条 `logger.error` 后 `return`：拒绝服务，但不炸宿主，与 `enabled: false` 的既有早返回路径同风格。
- **共享实例的引用不再被偷（严重）**：`Pool.acquire` 原先不 retain，refs 只统计「已挂载的会话」——于是「acquire 后、retain 前」的窗口（冷启动 npx 下载可达百秒）里，另一个会话被销毁时执行的 release 会扣掉**别人的**引用，把仍在服务的 hub 关掉并移出池：活着的会话此后永久 `the MCP connection is closed`，且 `reconnects=0` 没有自愈路径。现在 retain 并入 `acquire`（连接失败即释放），与 in-flight release 严格对称；`mountSession` 里多余的 `retain()` 已删除。
- **工具集变化真正到达注册表**：`ProjectHub.subscribe()` 原先在生产代码里没有任何调用方（只有测试自己订阅），`tool-set-changed` 分支不可达，`session.release` 从未赋值。现在按 hub 订阅（每个 hub 恰好一个 listener）并在工具集变化时重建注册：服务端后加的工具立刻可用，被删除/改名的工具不再留下永远报错的旧注册。
- **挂载失败不再是一次性的**：连接失败原先进入终态，一次瞬时抖动（冷下载、npm 缓存争用）就让该会话永久失去 CodeGraph。现在最多重试 3 次并复用**既有索引观察器**（不新增定时器，天然随 teardown 清理），拒绝文案区分「重试中 (N/M)」与「已放弃」。
- **stdout/stderr 行缓冲有上限**：不换行的超大输出原先让缓冲无界增长。现在 `maxBufferBytes`（默认 8 MiB）**先消费完整帧再判上限**，避免「一个 chunk 含许多小帧」被误判。stdout 超限报错并关闭（协议流已损坏，继续读无意义）；stderr 超限只保留尾部、连接不变——进度条/verbose 日志用 `\r` 不换行是常见形态，为一条纯诊断流掐掉正在服务的会话不划算。
- **未知行配置键不再静默忽略**：schemastery 的 `z.object` 不拒绝未知键，`toolCallTimeoutsMs` 这类拼写错误原先被原样保留、静默失效。现在由 `Config.dict` 得出声明键集合并逐键比对、点名报错（`argvBuilder` 作为文档化的测试缝显式放行）。
- **并发 `close()` 会等待同一次回收**：`if (this.closed) return` 让第二个调用者拿到「已关闭」而不是「已回收完成」。transport 与 ProjectHub 现在都缓存 `closePromise`，后续调用返回同一 promise。
- **0.2.0 的 settings 变化不再静默**：0.2.0 的 `dsh-settings` 已无 `register()`（只剩 `configure()`），插件原先静默跳过设置命名空间，而 README 仍承诺一个用户层。现在检测到「服务在但无 `register`」时打一条 info，说明 **0.2.0 起行配置是唯一通道**；README.md / README.zh.md 同步。
- **设置层里那个从不生效的 `enabled` 已移除**：它只在激活时读一次，用户「关掉插件」后已挂载会话继续服务、新会话继续挂载。行配置的 `enabled` 才是 loader 级真开关（在 apply 之前生效），所以从用户层 schema 与文档中去掉，不再承诺一个不会生效的开关。

### 验证

- `node --check` 19 个文件通过；`node scripts/check-node-compat.mjs` 无可疑新 API；`node --test test/*.test.js` **90/90 通过**。
- **两条依赖线都验证过**：本地 0.1.5 线与干净安装的 `0.2.0-rc.2` peer 线（CI 实际使用的解析结果）均 90/90。
- refcount 修复用仓库外的复现脚本前后对比：修复前活会话调用失败（`reconnects=0`），修复后 `A call: OK` 且 hub 保持在池中。
- 无 0.2.0 契约破坏：`tools.register(definition)`、`systemPrompt.section()`、`subprocess` 与 0.2.0 一致；本插件无客户端半边，不会因 pending 依赖卡住启动。

## [0.1.2] - 2026-09-22

### 修复

0.1.1 引入的家目录规则本身是对的，但一次针对它的对抗式复审发现三处问题，这一版全部修掉。复审同时确认了符号链接规范化、精确匹配语义、嵌套项目、`HOME=/` 容器形态、以及测试文件进程隔离这些点没有问题。

- **`allowHomeProject` 在观察者路径上静默失效（严重）**。挂载路径 (`lib/index.js`) 把该开关传给了 `locateIndex`，但轮询路径 (`lib/poll.js` 的 `pollTick`) 没有传，于是两者在「会话建立时索引还不存在」的场景下判断相反：开启该开关的部署，若家目录索引是在会话**打开之后**才出现，会话会永远停在 `waiting`，观察者永不触发——而文档与拒绝文案都在告诉用户去设这个开关。现在开关由注册表以**读取器**形式贯穿到每次 tick（与 `pollIntervalMs`/`pollMaxMs` 同样的方式，所以设置改动对已运行的观察者也生效），并补了一条回归测试：已验证该测试在缺少接线的代码上会失败。
- **拒绝文案把 workspace 说成家目录**。`mountRefusal` 用 `session.workspaceDir` 组织句子，而真正被拒绝的是解析出的项目根。于是 `$HOME/develop/others` 下的会话会被告知"该 workspace 就是家目录"——一句不成立的话，且 `session.projectRoot` 在被拒会话上是 `undefined`，真正的原因根没有任何地方保留。现在 `locateIndex` 在 `indexRoot` 里带上被拒绝的那个根，会话记录它，文案改为「其项目是家目录（<真实路径>）」；同时把建议改成两条可执行的出路（给具体项目建索引 / 设 `allowHomeProject`），原先那句 `<project root>` 占位符对家目录场景并不可执行。
- **诊断工具漏报该开关**。`codegraph_project_status` 的 `configuration` 块列出了 version / packageSpec / cacheDir / serverName / pollIntervalMs，却没有列出 `allowHomeProject`——而它现在决定「有没有东西被服务」。已补上，`session` 块也一并给出 `refusedRoot`。
- 修正 0.1.1 更新日志里「全套 77 项」的过时数字（当时实际已是 78 项）。

### 升级须知

0.1.1 起，**有意对家目录执行过 `codegraph init --force -- ~` 并依赖插件服务该索引的用户**，升级后会失去这个行为，直到设置 `allowHomeProject: true`。这是本次修复的预期语义（与 CLI 拒绝家目录的规则一致），拒绝文案里也点名了该开关；但它在补丁版本里是一次无条件的行为变更，特此说明。

## [0.1.1] - 2026-09-22

### 修复

- **家目录被当成项目（严重）**。判定规则原先是「向上找到第一个含 `*.db` 的 `.codegraph/` 即项目」。但 `~/.codegraph` 有**两种形态**且从内容上无法区分：它既是 CLI 的运行目录（`daemon.sock`、`codegraph.lock`、`telemetry*.json`），也是 `codegraph init --force -- ~` 写入 `codegraph.db` 的地方。于是只要家目录里存在一个 `codegraph.db`，`$HOME` 下**每一个**会话都会向上命中它，被挂载成一个谁都没打算建的「家目录项目」，工具也会为一个没建过索引的代码库提供出来。而家目录那种宽索引本身极易卡死（实测 `status` 超时，CLI 自己的看门狗每 60 秒杀一次）。
  - 现新增规则：**家目录与文件系统根永远不算项目**，即使里面真的有索引。这与 CLI 一致——它对家目录 `init` 会直接拒绝（"Refusing to initialize in /Users/troy — it looks like your home directory … pass --force"）。
  - 判定是**精确匹配解析出的项目根**，不是封禁整棵子树：嵌套在家目录里的真实项目（`~/work/api`）仍由它自己的索引正常服务。
  - `allowHomeProject: true`（行配置与 settings 命名空间都支持）是插件的 `--force` 等价物。
  - 拒绝会作为独立状态 `home-directory` 记录，守卫的拒绝文本与诊断工具都会说明原因并给出 `allowHomeProject` 出路，不会看起来像插件坏了。
- **`allowHomeProject` 的接线错误**（在修复过程中自查发现）。`locateIndex` 的选项名是 `protectedHomes`，而调用处写成了 `{ protectedPaths: [] }`，导致文档里承诺的逃生口**静默失效**（单元测试直接调 `locateIndex` 所以看不出来）。已改为传 `{ allowHomeProject }`，并补了一条端到端测试锁住它（该测试在错误接线下会失败，已验证）。
- **重复注册会话守卫**（自查发现）。守卫的注册块被整段复制了一次，同一个进程里装了两个功能相同的守卫。已删除重复块。

### 文档

- README 中英文修正了对 `~/.codegraph` 的错误描述（原先写成"CLI 安装目录、里面没有数据库"，这个前提不成立），并补充家目录/文件系统根规则与 `allowHomeProject` 配置项。
- `.codegraph` 只含运行态文件（无数据库）的形态仍判为 `not-a-project`（原行为不变，测试保留）。

### 验证

- 单元测试新增 6 条：家目录索引被拒并给出原因、家目录下的真实项目仍被服务、`allowHomeProject` 生效、文件系统根被拒、`HOME=/` 的容器形态不会把所有路径都判成家目录、CLI 运行目录形态仍被拒。
- 集成测试新增 2 条（真实 Cordis 运行时）：家目录索引不会成为每个会话的项目（不 spawn、不注册工具、守卫拒绝且文案含 `allowHomeProject`）、以及开启 `allowHomeProject` 后端到端可用。
- 全套 77 项在 Node 20.20.2 / 22 / 24 上通过；`scripts/real-codegraph-e2e.mjs` 对真实 CodeGraph 1.6.0 全部通过（共享实例、中途建索引、关闭后回收，`ps` 残留为 0）。

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
