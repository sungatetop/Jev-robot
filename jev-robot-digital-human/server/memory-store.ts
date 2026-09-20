/**
 * 机器人记忆系统（服务端存储）：
 *   情景记忆（全量）  data/episodes.jsonl  —— 结构化事件流，追加写，启动时加载近 500 条进内存
 *   记忆文件（Agent 自管）data/memory/*.md —— Agent 通过 read_memory / write_memory 工具
 *                                            自己读写、自己组织结构；系统只提供存储与索引
 *
 * 职责边界：本模块只做"存储 + 索引"，不做任何写死的提炼/合并流程——
 * 记忆的组织与沉淀由 Agent（慢思考）借助工具自主完成。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const EPISODES_FILE = join(DATA_DIR, 'episodes.jsonl');
const MEMORY_DIR = join(DATA_DIR, 'memory');

/* ---------------- 情景记忆（JSONL 追加） ---------------- */

export type EpisodeKind = 'user_message' | 'agent_reply' | 'agent_action' | 'scene_event' | 'consolidate';

/** 情景记忆条目：结构化事件流 */
export interface Episode {
  ts: number;
  kind: EpisodeKind;
  text: string;
  /** 关联动作（如 ["dance(happy)"]） */
  actions?: string[];
}

const MAX_EPISODES_IN_MEM = 500;

function loadEpisodes(): Episode[] {
  try {
    if (!existsSync(EPISODES_FILE)) return [];
    const lines = readFileSync(EPISODES_FILE, 'utf-8').split('\n').filter((l) => l.trim());
    return lines
      .map((l) => {
        try {
          return JSON.parse(l) as Episode;
        } catch {
          return null;
        }
      })
      .filter((e): e is Episode => !!e && typeof e.ts === 'number' && !!e.kind)
      .slice(-MAX_EPISODES_IN_MEM);
  } catch (err) {
    console.warn('[memory] 加载情景记忆失败:', err instanceof Error ? err.message : err);
    return [];
  }
}

let episodes: Episode[] = loadEpisodes();

/** 追加一条情景记忆（内存 + 磁盘 JSONL） */
export function appendEpisode(ep: Episode): void {
  episodes.push(ep);
  if (episodes.length > MAX_EPISODES_IN_MEM) episodes = episodes.slice(-MAX_EPISODES_IN_MEM);
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    appendFileSync(EPISODES_FILE, JSON.stringify(ep) + '\n', 'utf-8');
  } catch (err) {
    console.warn('[memory] 写入情景记忆失败:', err instanceof Error ? err.message : err);
  }
}

/** 按时间正序取最近 limit 条（自 since 时间戳起可选过滤） */
export function listEpisodes(limit = 50, since = 0): Episode[] {
  const filtered = since > 0 ? episodes.filter((e) => e.ts > since) : episodes;
  return filtered.slice(-limit);
}

/* ---------------- 记忆文件（Agent 经工具自读写） ---------------- */

/** 记忆索引条目：供预加载进 system prompt，让 Agent 知道自己有哪些记忆 */
export interface MemoryFileInfo {
  file: string;
  title: string;
  updatedAt: number;
  bytes: number;
}

/** 文件名白名单：中英文/数字/下划线/连字符，防止路径穿越 */
function safeName(name: string): string | null {
  const base = name.trim().replace(/\.md$/i, '');
  if (!base || base.length > 40) return null;
  if (!/^[a-zA-Z0-9\u4e00-\u9fa5_-]+$/.test(base)) return null;
  return `${base}.md`;
}

/** 从文件内容提取标题：优先 "# 标题"，否则取首个非空行前 30 字 */
function extractTitle(content: string): string {
  for (const line of content.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    return (t.startsWith('# ') ? t.slice(2) : t).slice(0, 30);
  }
  return '(空)';
}

/** 记忆索引：data/memory/ 下所有 .md 文件（按更新时间倒序） */
export function listMemoryIndex(): MemoryFileInfo[] {
  try {
    if (!existsSync(MEMORY_DIR)) return [];
    return readdirSync(MEMORY_DIR)
      .filter((f) => f.endsWith('.md'))
      .map((f) => {
        const p = join(MEMORY_DIR, f);
        const st = statSync(p);
        const content = readFileSync(p, 'utf-8');
        return { file: f, title: extractTitle(content), updatedAt: st.mtimeMs, bytes: st.size };
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch (err) {
    console.warn('[memory] 读取记忆索引失败:', err instanceof Error ? err.message : err);
    return [];
  }
}

/** 读一份记忆文件（Agent 的 read_memory 工具后端） */
export function readMemoryFile(name: string): string | null {
  const safe = safeName(name);
  if (!safe) return null;
  try {
    const p = join(MEMORY_DIR, safe);
    if (!existsSync(p)) return null;
    return readFileSync(p, 'utf-8');
  } catch (err) {
    console.warn('[memory] 读取记忆文件失败:', err instanceof Error ? err.message : err);
    return null;
  }
}

/** 写一份记忆文件（Agent 的 write_memory 工具后端，整文件覆盖；不存在则创建） */
export function writeMemoryFile(name: string, content: string): { ok: boolean; file?: string; error?: string } {
  const safe = safeName(name);
  if (!safe) return { ok: false, error: `文件名不合法: ${name}（仅允许中英文/数字/下划线/连字符，≤40 字符）` };
  try {
    mkdirSync(MEMORY_DIR, { recursive: true });
    writeFileSync(join(MEMORY_DIR, safe), content, 'utf-8');
    return { ok: true, file: safe };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[memory] 写入记忆文件失败:', msg);
    return { ok: false, error: msg };
  }
}
