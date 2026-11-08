# 平台接入：独立 DSH 插件（2026-11-08 起）

dsh-Dfy 的定位是**壳**：桌宠、挂件、概览聚合。平台能力（贴吧/QQ/B站/抖音…）
来自**装进 DSH 的独立插件**——装了就出现在概览「平台插件」里，卸了就消失，
装卸一律走 DSH 官方插件页，dsh-Dfy 不内置平台安装器。

> 历史注记：本目录早期的 `PlatformRegistry`（`lib/platforms.js`）是进程内适配器
> 注册表，但 `readMemory/promptBlock` 等方法从未被真正调用过，只喂概览页展示；
> 微博 2026-10-23 明确不做。现在平台扩展的正道是下面的清单约定。

## 平台插件契约（三层，全是 DSH 现成机制）

写一个平台插件（参考实现：`dsh-tieba-dive`）：

1. **发现清单**（让 dsh-Dfy 概览看见你）：在插件 `apply()` 里往
   `$DSH_HOME/shared/plugins/<id>.json` 写一份清单，`ctx.effect` 清理时删除：

   ```json
   {
     "name": "dsh-xxx-platform",
     "version": "1.0.0",
     "provides": ["dfy.platform"],
     "statusPath": "/api/xxx/status",
     "note": "一句话说明"
   }
   ```

   `statusPath` 可选：填了的话，dsh-Dfy 概览会用请求同源 Host 环回探测它
   （2.5 秒超时），运行态直接显示在列表里。发现逻辑在
   `backend/lib/platform-hub.js`（另含一层兜底：扫描 profile node_modules
   里所有带 `dsh` 字段的包，没写清单的插件也会出现在「已安装」列表）。

2. **设置界面**（DSH 原生，零主包代码）：插件自己的 client.js 通过
   `ctx.slots.register('settings.section', …)` 注册顶级设置分区，自动出现在
   DSH 设置里——不要把 UI 塞进 dsh-Dfy 的分区（宿主不支持跨插件嵌入）。

3. **能力槽**（可选，替换 dsh-Dfy 内置实现）：进程内取
   `globalThis[Symbol.for('dsh-dfy.capability-registry')]`（见
   `backend/lib/capability-registry.js`），`register({ id, provides: ['douyin.feed'], invoke })`。
   核心加载晚于插件时该全局还没就绪——轮询重试（参考 tieba-dive 等 webServer
   的兜底写法）。切换与失败回退由能力槽自带的契约测试处理。

## 红线（不变）

- 只读公开内容：帖子/回复/公开动态；私信、群聊、付费内容一律不读。
- 输出前过 `sanitizeText` / `assertSafeOutput`（`backend/lib/privacy.js`）。
- 凭据只存本机自己的数据目录（`$DSH_HOME/<你的插件目录>/`），不回显、不进日志。
