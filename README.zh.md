# dsh-plugin-codegraph-project

[English](README.md) | 中文

> **让 CodeGraph 按项目工作。** 每个项目一个 CodeGraph MCP 服务，由 `npx` 启动，被该项目下所有
> 会话共享；只有 workspace 真正有索引的会话才看得到它的工具。

## 为什么需要它

CodeGraph 本身很好用，但它的 MCP 服务有一个结构性限制：**从自己的进程工作目录**推断"当前项目"。
所以现有的 DSH 集成都只能全局回答"是哪个项目"——托管一行 MCP、钉一个 `cwd`，换项目就改文件加
热重载。

本插件把这个问题放到**会话维度**解决：

| 关注点 | 本插件的决策方式 |
| --- | --- |
| 这个会话属于哪个项目？ | 会话自己的 workspace 目录（`agent.session.header.cwd`），按 CLI 同款规则向上找到第一个**含索引库**的 `.codegraph/`。 |
| 用哪个 CodeGraph 版本？ | 由你决定：本插件行的配置项（并可在 DSH settings 里覆盖）。 |
| 起几个服务？ | **每个项目根一个**，按引用计数被该项目下所有会话共享。同一仓库两个会话共用一个进程，两个仓库各一个。 |
| 什么时候能用工具？ | 只在项目**确实有索引**之后。没有 `.codegraph/` 的项目无法调用 CodeGraph：调用会被拒绝，理由里写明"没有索引"并给出 `init` 命令。 |
| 会话中途才建索引怎么办？ | 几秒内自动注入到**正在运行的那个会话**。不用重开、不用重启。 |
| 进程会不会残留？ | 全部通过 harness 的托管子进程服务启动，属于 DSH：会话释放就减引用，harness 退出就终止剩下的。 |

## 安装

```bash
dsh plugin --profile <profile> add link:/path/to/dsh-plugin-codegraph-project
```

然后重启该 profile（`dsh web`）。包内自带 bundle patch，会自己插入插件行，不需要手改组成文件。
需要 Node.js 20 或更高版本。

除此之外不需要任何准备：服务通过 `npx` 拉到一个由本插件管理的缓存目录，不需要全局安装 CodeGraph。

## 先给项目建索引

建索引是**你的决定**，与上游一致——本插件绝不自己跑 `init`。需要 CodeGraph 的项目：

```bash
npx -y @colbymchenry/codegraph@1.6.0 init -y -- /path/to/project
```

它只会在项目里创建 `.codegraph/codegraph.db`，不动源码。会话开着时执行，几秒内工具就会出现；
先建好再开会话，会话一开始就带着工具。

`codegraph uninit -- /path/to/project` 可撤销。

## 配置

在 profile 的 `cordis.patch.yml` 里给这一行加配置：

```yaml
- id: codegraph-project
  config:
    version: '1.6.0'
```

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 总开关。关掉后不 spawn、不注册任何工具。 |
| `version` | `'1.6.0'` | **全局使用的 CodeGraph 版本**，以 `@colbymchenry/codegraph@<version>` 交给 npx。默认值是本插件实测过的版本。 |
| `packageSpec` | `''` | 逃生口：完整包规格，优先于 `version`（镜像源、私有 registry、`file:` tarball）。 |
| `cacheDir` | `''` → `~/.dsh/codegraph/npm-cache` | npx 使用的 npm 缓存目录，不存在会创建。DSH 的 `~/.npm` 不可写时改这里。 |
| `serverName` | `'codegraph'` | MCP 命名空间，模型看到的工具名是 `mcp__<serverName>__codegraph_explore`。 |
| `toolCallTimeoutMs` | `60000` | 单次查询的超时。 |
| `pollIntervalMs` | `3000` | 未索引 workspace 的检查间隔。 |
| `pollMaxMs` | `0` | 超过这个时长就放弃观察未索引的 workspace；`0` = 整个会话周期都观察。 |
| `telemetry` | `true` | 通过 `CODEGRAPH_TELEMETRY` 转达你的偏好，本插件不替你改。 |
| `cliProbe` | `true` | 启动时跑一次 `npx … version` 并记录结果，仅用于诊断。 |
| `usageGuidance` | `true` | 只对已挂载的会话注入一小段 CodeGraph 用法指引。 |
| `diagnosticTool` | `false` | 注册一个 `codegraph_project_status` 工具，报告本会话状态。 |

同样的子集也作为 DSH settings 命名空间 `codegraph-project` 暴露
（`enabled`、`version`、`packageSpec`、`cacheDir`、`toolCallTimeoutMs`），**用户层优先于行配置**。
所有值在使用前都会校验：非法设置会被拒绝，行配置继续生效。

### 切换版本

`version` 作用于**下一次**项目连接。已经连上的会话保持它启动时的版本——在一个正在使用的会话里
把服务换掉，会让正在被调用的工具凭空消失。重开该会话（或该项目的最后一个会话）即可切到新版本。

## 模型看到什么

每个项目连接一个工具，命名与 MCP 桥完全一致：

```
mcp__codegraph__codegraph_explore
```

CodeGraph 1.6.0 默认只暴露 `codegraph_explore`。要开放它其余的具，用上游自己的开关；本插件
原样透传服务端声明的工具集，不改名、不筛选：

```bash
# 子进程环境由 harness 环境清洗重建，所以在启动 harness 的地方导出
# （本插件行没有 `env` 配置项）：
export CODEGRAPH_MCP_TOOLS=explore,node,search,callers
```

会话已挂载时，`usageGuidance` 还会注入一小段指引，写明项目根与可用工具，并告诉模型优先用
`codegraph_explore` 而不是 grep/read 循环。没有索引的会话不会拿到这段内容。

## 行为细节

- **没索引就没有 CodeGraph。** 判定标准是 `.codegraph/` 里存在 `*.db`，不是目录存在。这点很关键：
  CodeGraph 把自己的安装数据放在 `~/.codegraph`，长得像索引目录但不是项目。任何项目上线之前工具根本
  没有注册；一旦有项目上线，某个 workspace 没索引的会话仍然调不动它——守卫会拒绝，拒绝理由里写明该
  workspace 与它对应的 `init` 命令。
- **第一次请求可能赶在连接之前。** 会话的工具列表在每次模型请求开始时组装，而连接一个项目约需两秒
  （`cliProbe` 预热过缓存会更快）。交互式会话里这意味着你还没打完字工具就已经就绪；程序化驱动的会话
  可能需要在首个 prompt 前等挂载完成。插件会为每个项目挂载打一行日志，写明 pid 与工具名。
- **向上解析。** monorepo 里 `packages/app` 下的会话由仓库根的索引服务，服务进程的 `cwd` 就是那个根。
- **每个项目一个进程。** 同项目的第二个会话接入已有服务；最后一个会话释放时进程才停止。
- **动态注入。** 稍后出现的索引由轮询发现，工具会注册进**正在运行的会话**的作用域。
- **断线自愈。** 服务崩了，下一次工具调用会透明重连；重连失败会作为工具错误返回，而不是假装成功。
- **首次冷启动。** 某个版本第一次使用要下载平台包（几十 MB）。会话永远不会被它阻塞——连接就绪后
  工具才出现。`cliProbe` 会在启动时顺便预热同一个缓存。

## 一个需要知道的平台限制

本插件把工具定义注册在**根**工具注册表上，用守卫实现按会话的访问控制，而不是按会话注册。这是刻意
的选择，也是这个约束的真实形态：DSH 的工具注册表支持 agent 作用域注册，但**模型的工具列表是用
`scope: agent`（Agent 对象本身，而不是注册表分层所用的 scope key）组装的**，因此 agent 作用域的定义
永远到不了模型。这是实测结论（0.1.5-rc.2）：通过 `agent.ctx` 注册的工具，会话自己的
`schemas(scopeKey)` 视图里有它，而 `systemPrompt.assemble({ agent, scope: agent })`（agent loop 的实际
调用）返回空列表；`restrict()` 同样是按 scope key 求值的，所以也无法按会话隐藏工具。

实际影响：只要有至少一个项目在线，CodeGraph 工具就会出现在该进程内**所有**会话的工具列表里，而守卫
负责让没有索引的会话用不了它。如果 DSH 将来改为按 agent 的 scope key 组装模型工具列表，注册就可以移
回 `agent.ctx`，列表也就真正是按会话的了。

## 进程归属（不留孤儿）

所有 CodeGraph 子进程都通过 `ctx.subprocess`（harness 的托管子进程服务）启动，而不是裸
`child_process`，因此有四层清理：

1. 关闭某个项目时先 SIGTERM，宽限期后 SIGKILL，并等待整个**进程组**消失。
2. 插件自身拆卸（卸载、热重载、profile 关闭）会关闭所有存活项目。
3. 子进程服务 dispose 时会终止并等待所有托管进程——harness 退出走的就是这条。
4. 子进程环境里设置了 `CODEGRAPH_HOST_PPID`（harness 的 pid），因此即使 harness 被强杀、
   完全没机会清理，CodeGraph 自带的孤儿看门狗也会退出服务。

关闭 stdin 是首选路径——实测 CodeGraph 在 stdin EOF 后几毫秒内就退出；信号只是卡死时的兜底。

## 排障

| 现象 | 原因与处理 |
| --- | --- |
| 没有 codegraph 工具，日志 `not-a-project` | `.codegraph/` 存在但没有索引库。执行上面的 `init` 命令。 |
| 没有 codegraph 工具，日志 `missing` | workspace 及其上层没有 `.codegraph/`，或向上走到了仓库根。给项目建索引。 |
| 日志 `could not resolve an npm launcher` | harness 的 `PATH` 里没有 `npx`。从有 Node 的终端启动 DSH，或把 `packageSpec` 指向仍可拉取的规格。 |
| 日志 `could not create the npx cache directory` | `cacheDir` 不可写，换一个可写目录。 |
| 日志里出现 `manifest`/下载错误 | npm 拉不到平台包（离线、镜像缺平台包、私有 registry）。把 `packageSpec` 指向可达来源。 |
| 工具调用返回 "the MCP server is not responding" | 服务崩溃且重连失败。日志里有捕获的 stderr 尾部。 |
| 会话还在用旧版本 | 会话保持连接时的版本，重开会话即可。 |
| 私有 registry 需要凭据 | harness 会把凭据类环境变量从子进程中清洗掉。请改用预热的缓存目录，或 `file:`/tarball 形式的 `packageSpec`。 |

把 `diagnosticTool` 设为 `true` 会注册一个 `codegraph_project_status` 工具，报告：解析到的项目根、
为什么有/没有工具、每个存活项目的服务 pid，以及当前版本对应的 init 命令。

## 开发

```bash
npm test          # 单元 + 集成测试，全部走 stub MCP 服务（不需要网络）
npm run lint      # 对每个源文件执行 node --check

# 针对真实 CodeGraph 服务的手工验证（需要热缓存或网络）：
node test/manual/real-codegraph-e2e.mjs --version 1.6.0
                  # 多会话共享一个进程、中途建索引、进程回收
node test/manual/stdio-probe.mjs /已建索引的项目路径 1.6.0
                  # 原始 NDJSON 帧、并发调用、stdin EOF 拆卸
```

测试套件用 stub MCP 服务替代真实服务，因此确定、离线；`test/manual/real-codegraph-e2e.mjs`
才是验证真实协议、真实查询、进程共享与进程回收的脚本，需要热缓存或网络。

## 许可

MIT
