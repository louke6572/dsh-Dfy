/**
 * 功能模块 id 的唯一清单。
 *
 * 为什么单独一个文件：这份清单同时被三处消费——
 *   · `packages/dsh-dfy-core/backend/lib/store.js` 的 `normalizeUnified()`（保存时裁剪键）；
 *   · `backend/lib/modules.js` 的模块注册表（设置页导航 / 接口 410 开关）；
 *   · `lib/ui/` 的导航页。
 * 以前 store 里手写一份数组、modules.js 里再写一份，新增模块时漏改 store 的后果是
 * 「设置页能看到、保存后键被裁掉」——用户开关永远存不进去，代码却看起来正常。
 *
 * 注意：新增模块时还要同时补 `modules.js` 的标题/描述、路由前缀规则、以及对应设置页；
 * 这份清单只保证「id 集合」不会漂移。
 */
export const MODULE_IDS = Object.freeze([
  'bili',
  'tieba',
  'douyin',
  'qq',
  'characters',
  'memory',
  'pet',
  'voice',
]);
