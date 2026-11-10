/**
 * 运行期服务共享（同一进程内的 DSH 插件 ↔ 内嵌 QQ 桥接）。
 *
 * src/bridge.js 是以 SURFCORE_EMBEDDED=1 被插件宿主 import 进来的（不是独立进程），
 * 但它拿不到 DSH 的 ctx；看图懂梗要用 ctx.get('llm') / ctx.get('attachments')，
 * 所以由插件在初始化时把服务写到这里，桥接按需取。
 *
 * 这里只放「只读服务句柄」，不放配置/状态；模块路径固定，避免桥接热重载时
 * （import 带 ?v= 重新加载）拿不到之前写入的服务。
 */
let services = Object.freeze({});

/** 插件启动时调用；可多次调用，后写的覆盖同名字段。 */
export function setQqRuntimeServices(next) {
  if (!next || typeof next !== 'object') return;
  services = Object.freeze({ ...services, ...next });
}

export function getQqRuntimeServices() {
  return services;
}
