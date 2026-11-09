# DSH 兼容性审查（2026-11-09）

## 结论

刚才的改动可以消除本插件安装旧版 DSH 核心包这一条污染路径，但不能理论上确保各版本功能兼容。即使只考虑声明下限 0.2.1-rc.2 到最新 0.2.2-rc.1，也已发现实际接口差异。依赖修复应保留，但不能将它作为跨版本兼容验收完成的依据。

本次为静态审查，没有启动真实宿主，也没有修改宿主配置。筛查了官方发布记录和最新发布 tag 中 98 篇中文升级指南的主题，重点阅读命中本插件依赖面的指南，并对照 0.2.1-rc.2 / 0.2.2-rc.1 的 SessionController、Session history、Agent 恢复、兼容性判定源码。不是对全部功能、全部发行版的穷尽证明。

官方最新版本拼写为 **0.2.2-rc.1**。来源：[npm 包元数据](https://registry.npmjs.org/@deepseek-ai%2fdsh)、[官方发布](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.1)。

## 已确认的差异

### 1. SessionController.inspect 被移除：现有宿主侧调用没有迁移

0.2.1-rc.2 的 SessionController 提供 `inspect`，0.2.2-rc.1 不再提供；新版拆出 history/state/projections 等读取接口，并提供 `resolveAgent`。不能用一个新方法机械替换全部 inspect：读取历史与激活 Agent 是不同需求。

本插件调用点：

- `backend/lib/scheduler.js:635`：inspect 失败后调用 create。新版 inspect 不存在会被吞掉，进入创建分支；已有非空会话可能导致创建额外会话，代码还忽略 create 返回的新 ID。
- `backend/lib/douyin.js:686`：同样把 inspect 失败当作“还没建过”，然后 create，并继续使用原 ID。
- `backend/lib/token-budget.js:424`：依赖 inspect 返回历史事件来回填当日用量，新版无法执行此读取路径。
- `backend/lib/index.js:3447`：通过方法存在性判断跳过 inspect，避免抛错，但冷会话不再因此加载，后续权限操作可能返回 session-not-active。

这几处完全绕过 NodeApiClient，因此更换它的 HTTP 基类不会修复这些问题。

证据：[旧 SessionController](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/api/session-controller/src/index.ts)、[新 SessionController](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/api/session-controller/src/index.ts)、[新版会话创建实现](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/api/session-controller/src/agent.ts)。

### 2. session/follow 的默认激活语义改变

升级指南要求需要恢复冷 Agent 的客户端显式发送 `activate: true`。插件 `src/dsh-client.js:744` 的请求只发送 address、maxMessages，重连重放也使用同一请求。因此新版只跟随历史和事件，不再保持旧版“跟随即启动恢复”的行为。

这不等于所有消息必然失败：新版 prompt/selectModel 路径仍通过 resolveAgent 恢复普通 Agent。需要先明确桥接启动/重连时是否应恢复会话，再添加显式激活与就绪验证；不能将收到 snapshot 当作 Agent 就绪。

证据：[迁移指南](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/docs/upgrade-guide/v0.2.1-rc.3/session-follow-activation/guide.zh.md)、[新版 follow](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/api/session-controller/src/web/controller.ts)、[新版 prompt](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/api/session-controller/src/commands.ts)。指南目录名不一定就是变更首次生效版本，最终以发行 tag 的源码为准。

### 3. 工具名字变化使限制清单过时

新版 Schedule 移除 `schedule_update` / `schedule_delete`，新增 `schedule_view` / `schedule_edit`；新版组合还新增 `apply_patch`。`backend/qq-tool-restrict.mjs` 的隐藏清单保留旧名字且缺少上述新名字。

所以不能保证原有“危险工具不出现在模型声明中”的语义。执行期 guard 另有白名单，新名字不在允许集合中，不能据此断言新工具已经可以越权执行；仍需验证各目标版本中的 guard、作用域和工具声明行为。

证据：[Schedule 迁移](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/docs/upgrade-guide/v0.2.2-alpha.2/schedule-agent-tools/guide.zh.md)、[apply_patch 与文件观察策略](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/docs/upgrade-guide/v0.2.2-alpha.2/fs-observation-policy-default-off/guide.zh.md)。

### 4. 宿主 Node 要求与项目说明不一致

官方升级指南要求 DSH 使用 Node >=24.9。插件 package.json 和 README 仍写 >=22.13，CI 使用 Node 22。插件自身的纯 JS 基础层或许可以在 Node 22 运行，但这不能代表所支持的宿主可以在 Node 22 启动。应区分独立桥接进程要求和宿主要求，并为集成验收使用宿主支持的运行时。

证据：[Node 24 升级说明](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/docs/upgrade-guide/v0.2.1-rc.2/node-24/guide.zh.md)。

## 命中升级文档但没有证据说明当前路径被破坏的项目

- **实时 projection 帧改为 changes 数组**：插件清队列读取的是 session/projections 或 control baseline。官方明确这两者不变，所以不能误报为清队列必然失败。见 [projection-event-frames](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/docs/upgrade-guide/v0.2.2-alpha.2/projection-event-frames/guide.zh.md)。
- **index-inject 新增 Peer 参数**：插件只监听表格，不自行调用 renderIndex/collectIndexInjections；指南明确只读表格的监听器不受影响。见 [webserver-index-peer](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/docs/upgrade-guide/v0.2.1-rc.2/webserver-index-peer/guide.zh.md)。
- **system-prompt/assemble 不再带 tools、工具执行器拆分**：检查的宿主插件没有靠 assembly.tools 过滤工具，也没有配置旧 tools.mode/DSH_TOOLS_MODE；实际使用 restrict/guard，不能仅因标题有“工具破坏性变更”就判定它失效。自定义 profile 的执行器组合仍需验收。见 [conditional-tools](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/docs/upgrade-guide/v0.2.1-rc.2/conditional-tools/guide.zh.md)。
- **非页面客户端 interactions 模式**：官方建议 /connect?interactions=answer 用于参与交互的外部客户端；当前代码走浏览器 Cookie 和手动 $events。指南明确已有浏览器 Cookie 行为不变，不能直接推断当前鉴权已坏；但离线 Cookie 签名依赖内部文件结构，不是永久兼容保证。见 [operator-connect](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/docs/upgrade-guide/v0.2.1-alpha.2/operator-connect/guide.zh.md)。
- **session/attachment 请求改变**：本地基础层保留 attachment 门面，但搜索未发现业务调用该门面。不能宣称全部暴露门面都跨版本可用，也不能把未调用的门面变化写成已发生业务故障。

## 版本范围与测试结论

| 范围 | 当前可得结论 |
| --- | --- |
| 0.1.x、0.2.0、0.2.1-rc.2 之前 | 已在 engines.dsh 范围之外，不承诺支持。历史上发生 ApiProxy→Remote、Session v2/v3/v4、预设目录→组合包等迁移，保留少量回退不等于全面向后兼容。 |
| 0.2.1-rc.2 | 依赖污染路径已修复，仍需真实宿主验收；新测试没有证明整个插件兼容。 |
| 0.2.1 后续 RC 至 0.2.2-rc.1 | 依赖污染路径已修复，但 inspect 与 follow 差异等需要另外适配，不能宣称全部功能兼容。 |
| 未来版本 | >=0.2.1-rc.2 无上限地放行，不构成未来 API 保证。 |

两个已核对发行版的宿主都使用 `semver.satisfies(..., { includePrerelease: true })`。所以当前 engines 范围可以放行 0.2.2-rc.1，不存在需要凭猜测修复的“普通 semver 排除下一版预发布”问题。但放行只是声明匹配，不会检查方法是否存在、字段含义是否改变。见 [兼容性判定源码](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/boot/app-boot/src/plugin-compatibility.ts)。

刚才新增的 3 个测试检查依赖树、由本仓库构造的 HTTP 响应、API 门面绑定与超时。它们没有运行任何版本的真实 DSH，也没有测试 WebSocket、冷恢复、宿主注入服务、工具 guard、预设组装和升级残留；因此只能证明本次局部替换的部分行为。

下一步应先建立宿主能力适配层：将“只读历史”“激活已有会话”“确实创建新会话”分开，修复 inspect 的各调用点；明确 follow 激活意图；更新工具限制清单和运行时说明。然后按官方发行版建立契约/集成矩阵，至少覆盖当前宿主、最新宿主及相关变更边界，验证干净安装与旧版升级。版本范围应依据这些证据收敛，而不是用无限制 >= 宣称未来兼容。
