/**
 * 长期记忆 MCP server 的启动垫片。
 *
 * 记忆逻辑完全用官方 `@modelcontextprotocol/server-memory`（知识图谱：实体/关系/观察），
 * 我们只做两件事：把数据文件固定到 dsh 的数据目录，让 DSH 会话通过 MCP 工具读写同一份记忆。
 */
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.MEMORY_FILE_PATH ||= path.join(os.homedir(), '.dsh', 'surfcore', 'memory', 'mcp-memory.jsonl');

const require = createRequire(import.meta.url);
const entry = path.join(path.dirname(require.resolve('@modelcontextprotocol/server-memory/package.json')), 'dist', 'index.js');
await import(pathToFileURL(entry).href);
