/**
 * Agent 工具集（全部以第一人称视角描述）：
 *   身体能力  get_robot_state / set_robot_intent / command_robot / trigger_scene_event
 *   记忆能力  read_memory / write_memory / read_recent_episodes
 *
 * 记忆即工具：Agent 通过 read/write_memory 自己读写 data/memory/*.md 记忆文件，
 * 自主组织记忆结构；情景流水经 read_recent_episodes 按需回顾。
 * 服务端只提供存储与索引，不写死任何整理流程。
 */
import { Type } from 'typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { MOTIONS, EXPRESSIONS } from '../src/jev/semantics';
import type { AgentCommand, EnvState, DecisionPayload } from '../src/jev/types';
import { listEpisodes, listMemoryIndex, readMemoryFile, writeMemoryFile } from './memory-store';
import type { EpisodeKind } from './memory-store';

export interface RobotSnapshot {
  env?: EnvState;
  lastDecision?: DecisionPayload | null;
}

export interface RobotToolsDeps {
  /** 感知快照（由服务端在每次请求时刷新） */
  getSnapshot: () => RobotSnapshot;
  /** 工具产生的指令下发（SSE 实时通知 / 整理请求回收） */
  emitCommand: (cmd: AgentCommand) => void;
}

// 身体动作集：reply 是「说话」动作（由文本输出完成），consolidate 是「整理记忆」
// 动作（由外循环 Jev 触发整理流程完成），均不作为身体指令下发
const BODY_MOTIONS = MOTIONS.filter((m) => m !== 'reply' && m !== 'consolidate');

const SCENE_EVENTS = ['arrival', 'move', 'obstacle', 'direct', 'celebrate', 'uncertain', 'reset'] as const;

const KIND_TEXT: Record<EpisodeKind, string> = {
  user_message: '用户说',
  agent_reply: '我回复',
  agent_action: '我做了动作',
  scene_event: '情景',
  consolidate: '整理',
};

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }], details: {} };
}

function fail(text: string) {
  return { content: [{ type: 'text' as const, text }], details: {} };
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

/** 情景流水 → 可读文本（供 Agent 回顾最近经历） */
function formatEpisodes(limit: number): string {
  const eps = listEpisodes(limit);
  if (!eps.length) return '（还没有任何情景记录）';
  return eps.map((e) => `[${fmtTime(e.ts)}] ${KIND_TEXT[e.kind]}: ${e.text}`).join('\n');
}

/* ---------------- 工具定义 ---------------- */

const getStateTool = (deps: RobotToolsDeps): AgentTool<any> => ({
  name: 'get_robot_state',
  label: '感知自己',
  description:
    '感知你此刻的身体状态（意图/用户距离/障碍/能量/社交热度/工作记忆/未整理记忆），以及行为账本——你正在做的动作、持续时长、发起者、最近行为历史，和反射系统最近替你做的决定。',
  parameters: Type.Object({}),
  execute: async () => ok(JSON.stringify(deps.getSnapshot(), null, 2)),
});

const setIntentTool = (deps: RobotToolsDeps): AgentTool<any> => ({
  name: 'set_robot_intent',
  label: '给自己立心意',
  description: `给自己设定一个持续性意图（如 ${BODY_MOTIONS.join('/')}），之后你的反射系统（外循环）会朝这个方向自主行动。这是触发外循环的方式，不是直接控制身体。`,
  parameters: Type.Object({
    intent: Type.Union(BODY_MOTIONS.map((m) => Type.Literal(m)), { description: `心意方向: ${BODY_MOTIONS.join('/')}` }),
    note: Type.Optional(Type.String({ description: '一句话说明你为什么这么想' })),
  }),
  execute: async (_id, params) => {
    const { intent, note } = params as { intent: string; note?: string };
    deps.emitCommand({ type: 'set_intent', intent, note });
    return ok(`你的心意已定：${intent}，接下来身体会朝这个方向自主行动`);
  },
});

const commandTool = (deps: RobotToolsDeps): AgentTool<any> => ({
  name: 'command_robot',
  label: '直接表演',
  description: `立即亲自做一个动作（${BODY_MOTIONS.join('/')}），可带表情、强度(0-2)和是否面向用户。动作立即执行一次，不经反射循环，做完后外循环接管。说话不需要用它——你打的字就是你说的话。`,
  parameters: Type.Object({
    motion: Type.Union(BODY_MOTIONS.map((m) => Type.Literal(m)), { description: `动作: ${BODY_MOTIONS.join('/')}` }),
    expression: Type.Optional(Type.Union(EXPRESSIONS.map((m) => Type.Literal(m)))),
    intensity: Type.Optional(Type.Number({ minimum: 0, maximum: 2, description: '0 低强度 .. 2 高强度' })),
    look_at_user: Type.Optional(Type.Boolean({ description: '是否面向用户' })),
  }),
  execute: async (_id, params) => {
    const p = params as { motion: string; expression?: string; intensity?: number; look_at_user?: boolean };
    deps.emitCommand({
      type: 'command',
      motion: p.motion,
      expression: p.expression,
      intensity: p.intensity,
      lookAtUser: p.look_at_user,
    });
    return ok(`你正在做 ${p.motion}${p.expression ? `（表情 ${p.expression}）` : ''}`);
  },
});

const eventTool = (deps: RobotToolsDeps): AgentTool<any> => ({
  name: 'trigger_scene_event',
  label: '设想一个情景',
  description: `在你心里设想一个情景（${SCENE_EVENTS.join(' / ')}），你的反射系统（外循环）会像真的遇到一样自动响应。`,
  parameters: Type.Object({
    name: Type.Union(SCENE_EVENTS.map((n) => Type.Literal(n))),
  }),
  execute: async (_id, params) => {
    const { name } = params as { name: string };
    deps.emitCommand({ type: 'trigger_event', name });
    return ok(`你脑中浮现情景 ${name}，反射系统即将自动响应`);
  },
});

const readMemoryTool: AgentTool<any> = {
  name: 'read_memory',
  label: '翻开记忆',
  description: '翻开你的一份记忆文件细读（文件名见你的记忆索引，不含 .md 后缀也可）。想更新某份记忆时，先读再写。',
  parameters: Type.Object({
    file: Type.String({ description: '记忆文件名，如 "用户偏好"（对应 用户偏好.md）' }),
  }),
  execute: async (_id, params) => {
    const { file } = params as { file: string };
    const content = readMemoryFile(file);
    if (content == null) {
      const names = listMemoryIndex().map((m) => m.file).join('、') || '（还没有任何记忆文件）';
      return fail(`没有找到记忆「${file}」。你现有的记忆：${names}`);
    }
    return ok(content);
  },
};

const writeMemoryTool: AgentTool<any> = {
  name: 'write_memory',
  label: '写入记忆',
  description:
    '把值得长期记住的内容写进你的记忆文件（不存在则创建，已存在则整篇覆盖——更新前先 read_memory 读出旧内容，合并后再写，别弄丢已有记忆）。文件如何组织由你自己决定。',
  parameters: Type.Object({
    file: Type.String({ description: '记忆文件名（中英文/数字/下划线/连字符，≤40 字符），如 "用户偏好"' }),
    content: Type.String({ description: 'Markdown 全文内容' }),
  }),
  execute: async (_id, params) => {
    const { file, content } = params as { file: string; content: string };
    if (!content?.trim()) return fail('内容为空，未写入');
    const r = writeMemoryFile(file, content);
    if (!r.ok) return fail(`写入失败：${r.error}`);
    return ok(`已写入记忆「${r.file}」（${content.length} 字）`);
  },
};

const readEpisodesTool: AgentTool<any> = {
  name: 'read_recent_episodes',
  label: '回顾经历',
  description: '回顾你最近与用户互动的情景流水（时间正序）：用户说了什么、你回了什么、做了什么动作。整理记忆或想不起来刚才发生什么时用它。',
  parameters: Type.Object({
    limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100, description: '回看条数，默认 40' })),
  }),
  execute: async (_id, params) => {
    const { limit } = (params ?? {}) as { limit?: number };
    return ok(formatEpisodes(Math.min(100, Math.max(1, Math.round(limit ?? 40)))));
  },
};

/* ---------------- 汇总 ---------------- */

/** 创建全部 Agent 工具（身体能力 + 记忆能力） */
export function createRobotTools(deps: RobotToolsDeps): Array<AgentTool<any>> {
  return [
    getStateTool(deps),
    setIntentTool(deps),
    commandTool(deps),
    eventTool(deps),
    readMemoryTool,
    writeMemoryTool,
    readEpisodesTool,
  ];
}
