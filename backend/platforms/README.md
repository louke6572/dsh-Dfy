# 平台接入层（微博明确不做；贴吧已由 dsh-tieba-dive 插件替代）

平台适配器接口在 `lib/platforms.js`：

```js
{
  id: 'douyin',
  name: '抖音',
  version: '1.0.0',
  status: 'active',            // active | planned | disabled
  capabilities: ['identity', 'memory.read', 'memory.write', 'prompt.block'],
  async status() {},            // 运行态
  async readMemory(ctx) {},     // 只返回公开内容，私信/私聊必须自己先排除
  async writeMemory(ctx) {},    // 可选
  promptBlock(ctx) {}           // 可选：给提示词加平台身份/规则
}
```

内置：`qq`、`bili`、`douyin`。

> 2026-10-23 用户明确：微博不做，`weibo` 占位连同 `platforms/weibo/manifest.json` 一起移除（备份 `_backups/weibo-platform-removed-20261023/`）。

## 为什么这样切

- 记忆同步不是“QQ → B站”写死，而是“源平台 → 目标平台”的公开内容管道；隐私闸门在
  `lib/privacy.js` 统一执行，任何新平台都必须过同一道闸。
- 身份对齐的存储结构是 `{ identities: { qq, bili, … } }`，新平台只是多一个键。
- 设置窗口「扩展 / 平台」页会自动列出注册表里的平台，不需要改 UI 主流程。

## 接新平台时要补的

1. 一个 adapter（可以放在 `platforms/<id>/`，由 `PlatformRegistry.loadLocal()` 加载；
   也可以由扩展调用 `api.registerPlatform()` 注册）。
2. 只读公开内容：帖子/回复/公开动态；私信、群聊、付费内容一律不读。
3. 身份识别：平台 uid ↔ 其他平台 uid；仍然走 `api.align`，不要自己另存一套。
4. 输出前过 `sanitizeText` / `assertSafeOutput`。
