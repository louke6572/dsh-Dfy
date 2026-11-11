/**
 * 原子文件写（临时文件 + rename）——全项目唯一实现。
 *
 * 为什么要收口：这个项目里「原子写」至少被实现了 6 遍：
 *   · packages/dsh-dfy-core/backend/lib/store.js  writeTextAtomic
 *   · packages/dsh-dfy-core/src/memory-card.js    writeTextAtomic（复制了一份）
 *   · src/token-budget.js                         writeJsonAtomic
 *   · src/bridge.js                               writeJsonFileAtomicSync
 *   · backend/lib/scheduler.js                    writeJsonFileAtomic
 *   · backend/lib/billing.js                      writeAtomic
 * 每份的临时名规则、mode、失败清理还不完全一样。更糟的是**还有一批状态文件根本没走原子写**
 * （记忆卡缓存、抖音浏览记录、贴吧 cookie、AstrBot 配置、人格指纹…）：写到一半被读，
 * 读侧 catch 静默回落默认值，用户看到的是「配置被重置了 / 登录没了 / 记录丢了」。
 *
 * 本模块只做一件事，但做对：
 *   · 同目录临时文件 → writeFileSync → rename：读到的要么是旧文件，要么是新文件；
 *   · 临时名带 pid + 时间戳 + 递增序号：同进程并发写同一文件也不会撞名；
 *   · 失败时清掉临时文件，不留下垃圾；
 *   · 支持 string / Buffer（图片缓存也能用同一套）；
 *   · mode 默认 0600（状态/凭据文件不该让其它用户读）。
 *
 * 注意：这里**不**调用 ensureDirs()。它属于 store 层的业务初始化；工具脚本/子进程
 * 只想写一个文件时，不该顺带建出 8 个目录。需要时按需 mkdir 父目录即可。
 */
import fs from 'node:fs';
import path from 'node:path';

let atomicSeq = 0;

/**
 * @param {string} file 目标文件
 * @param {string|Buffer} data 内容
 * @param {{ mode?: number, ensureDir?: boolean }} [options]
 * @returns {true}
 */
export function writeFileAtomic(file, data, { mode = 0o600, ensureDir = true } = {}) {
  const target = String(file);
  if (ensureDir) {
    try { fs.mkdirSync(path.dirname(target), { recursive: true }); } catch { /* 目录已存在/无权限由下面的写入报错 */ }
  }
  const tmp = `${target}.${process.pid}.${Date.now().toString(36)}${(++atomicSeq).toString(36)}.tmp`;
  try {
    const isBuffer = Buffer.isBuffer(data) || data instanceof Uint8Array;
    fs.writeFileSync(tmp, data, isBuffer ? { mode } : { encoding: 'utf8', mode });
    // Windows 上 writeFileSync 的 mode 不总是生效（继承默认 ACL），能改就再改一次。
    if (!isBuffer) {
      try { fs.chmodSync(tmp, mode); } catch { /* 平台不支持就跳过 */ }
    }
    fs.renameSync(tmp, target);
    return true;
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch { /* 临时文件可能都没建出来 */ }
    throw error;
  }
}

/** JSON 原子写（末尾补换行，便于手工查看与 git diff）。 */
export function writeJsonFileAtomic(file, value, options) {
  writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`, options);
}
