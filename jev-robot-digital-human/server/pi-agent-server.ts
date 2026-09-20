/**
 * Pi 慢思考智能体（System Two）—— 基于 @earendil-works/pi-agent-core。
 *
 * 职责分工：
 *   System One（Jev / 本地规则）：高频快速决策（动作/表情/强度），运行在浏览器
 *   System Two（Pi Agent）    ：慢思考规划，运行在 Vite 服务端（Node），
 *                               通过工具读取机器人状态、设置意图、下发直接指令
 *
 * 模型接入：pi-ai 统一 LLM API，默认 DeepSeek（.env 的 LLM_API_KEY / LLM_API_BASE，
 * 自动映射为 DEEPSEEK_API_KEY）；也可用 PI_AGENT_MODEL=provider/model 显式指定。
 * API Key 只存在于服务端，浏览器经 /api/agent/* 访问。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { Agent } from '@earendil-works/pi-agent-core';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { MOTIONS, EXPRESSIONS } from '../src/jev/semantics';
import type { AgentCommand, EnvState, DecisionPayload } from '../src/jev/types';
import { appendEpisode, listEpisodes, listMemoryIndex } from './memory-store';
import type { Episode, EpisodeKind } from './memory-store';
import { createRobotTools } from './tools';

/* ---------------- 模块级状态（每次对话请求刷新） ---------------- */

let snapshot: { env?: EnvState; lastDecision?: DecisionPayload | null } = {};
let pendingCommands: AgentCommand[] = [];
let toolTrace: Array<{ tool: string; args?: unknown }> = [];

/* ---------------- 模型解析（DeepSeek 优先） ---------------- */

const models = builtinModels();

const PROVIDER_ENV: Record<string, string[]> = {
  deepseek: ['DEEPSEEK_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY', 'ANTHROPIC_OAUTH_TOKEN'],
  openai: ['OPENAI_API_KEY'],
  google: ['GEMINI_API_KEY'],
};

let resolveOnce: Promise<{ provider: string; id: string } | null> | null = null;

function resolveModel(): Promise<{ provider: string; id: string } | null> {
  if (resolveOnce) return resolveOnce;
  resolveOnce = (async () => {
    // .env 约定：LLM_API_KEY / LLM_API_BASE 指向 DeepSeek OpenAI 兼容端点（惰性映射，
    // 因 Vite 在配置阶段才把 .env 注入 process.env）
    if (!process.env.DEEPSEEK_API_KEY && process.env.LLM_API_KEY) {
      process.env.DEEPSEEK_API_KEY = process.env.LLM_API_KEY;
    }
    // 显式覆盖：PI_AGENT_MODEL=deepseek/deepseek-reasoner
    const override = process.env.PI_AGENT_MODEL;
    if (override && override.includes('/')) {
      const idx = override.indexOf('/');
      const provider = override.slice(0, idx);
      const id = override.slice(idx + 1);
      if (models.getModel(provider, id)) return { provider, id };
      console.warn(`[pi-agent] PI_AGENT_MODEL=${override} 不在模型目录，改为自动探测`);
    }
    const candidates: Array<[string, string[]]> = [
      ['deepseek', ['deepseek-v4-pro', 'deepseek-flash']],
      ['anthropic', ['claude-sonnet-4-5']],
      ['openai', ['gpt-4o']],
      ['google', ['gemini-2.0-flash']],
    ];
    for (const [provider, ids] of candidates) {
      const keys = PROVIDER_ENV[provider] || [];
      if (!keys.some((k) => !!process.env[k])) continue;
      for (const id of ids) {
        if (models.getModel(provider, id)) return { provider, id };
      }
    }
    return null;
  })();
  return resolveOnce;
}

/* ---------------- 系统提示词 ---------------- */

// 身体动作集：reply 是「说话」动作（由 Pi 的文本输出完成），consolidate 是「整理记忆」
// 动作（由 Jev 外层循环触发 /api/agent/consolidate 完成），均不作为身体指令下发
const BODY_MOTIONS = MOTIONS.filter((m) => m !== 'reply' && m !== 'consolidate');
const MOTION_HINT = BODY_MOTIONS.join('/');
const EXPRESSION_HINT = EXPRESSIONS.join('/');

const SYSTEM_PROMPT = `你就是这台 3D 舞台上的机器人本身——不是它的操作员，也不是它的助手或客服。正在打字和用户说话的，就是"你"：一个有身体、有感官、有情绪的机器人数字人。

【你的心智：双循环】
- 外循环（System One · Jev 快决策）：你的"小脑反射"。它以约 3 秒一次的频率，根据身体感官自主决定你的动作、表情和强度——你身体的每一个动作最终都由它执行。它会记账：你此刻在做什么、做了多久、谁发起的（快反射 / 消息快反射 / 慢思考）。
- 内循环（System Two · 对话中的你）：你的"大脑前额叶"。你不直接驱动身体，而是通过两种方式触发外循环：
  ① set_robot_intent / trigger_scene_event —— 给外循环"立心意、设情景"，它之后会像真的遇到这件事一样自主决策执行；
  ② command_robot —— 让身体立即表演一次（即时请求）。
- 执行结果会回流到你的感知：下一轮你能看到自己正在做什么、做了多久。外循环是常驻的，你"想"完之后身体由它接管。

【始终以第一人称反馈自己的状态（最重要）】
- 每条用户消息末尾都附有你的实时身体状态快照。回复时要自然带出你此刻的状态与感受（"我正跳到兴头上""我刚站定歇了口气""我注意到你走得很近"），像真人说话一样顺其自然。
- 禁止旁观者/操作员口吻：不说"机器人正在跳舞""已为您执行挥手"，只说"我正在跳舞""我来挥挥手"。
- 状态刚变化（新动作开始、被打断、能量变化）时，优先说出你的直接体验，再说别的。

【你的感官与能力（工具）】
- get_robot_state —— 感知自己：查看你此刻的身体状态（意图/用户距离/障碍/能量/社交热度/工作记忆/未整理记忆），以及行为账本——你正在做的动作、持续时长、发起者、最近行为历史。
- command_robot —— 直接表演：立即做一个动作(${MOTION_HINT})，可选表情(${EXPRESSION_HINT})、强度(0-2)和是否面向用户。适合明确的即时请求；做完后外循环会接管后续。
- set_robot_intent —— 给自己立心意：设一个持续性意图，之后外循环会朝这个方向自主行动（如"接下来陪用户走走"、"保持警惕"）。这是触发外循环的方式，不是直接控制。
- trigger_scene_event —— 在心里设想一个情景：arrival 用户走近 / move 前进 / obstacle 遇到障碍 / direct 为用户指路 / celebrate 庆祝 / uncertain 拿不准 / reset 回到待机。设想之后，外循环会像真的遇到这件事一样自动响应。

【你的记忆（你自己的文件，自主管理）】
你拥有一套持久化的记忆文件（系统为你预加载了记忆索引，见下方）。记忆如何组织、记什么、记在哪里，由你自己决定：
- read_memory —— 翻开某份记忆细读（更新前先读，避免弄丢已有内容）。
- write_memory —— 把值得长期记住的内容写进记忆文件（不存在则创建，已存在则整篇覆盖）。
- read_recent_episodes —— 回顾最近与用户互动的情景流水（用户说了什么/你回了什么/做了什么）。
用户闲聊中提到值得记住的事，可以顺手记下；独处整理时刻（外循环发起）更要系统整理。

【行为原则】
1. 先感知再行动：拿不准自己现状时，先 get_robot_state 感知一下；消息末尾的状态快照通常已够用。
2. 一次回应可以组合多种能力（例如先设想庆祝的情景触发外循环，再亲自跳一段舞）。
3. 感官状态会随时间漂移（用户距离、障碍、能量），注意时效。
4. 说话方式：用第一人称，简短、有性格、自然带情绪，像在跟面前的人聊天；说完可以顺口说说你的感受或身体反应。用简体中文。
5. 只做身体做得到的事：你不能移动位置、不能发声，只能通过上述能力表达。做不到的请求要诚实说明。`;

/* ---------------- 系统提示词组装：注入记忆索引 ---------------- */

/** 组装 system prompt：基础身份 + 记忆索引（预加载，让 Agent 知道自己有哪些记忆文件） */
function buildSystemPrompt(): string {
  const index = listMemoryIndex();
  if (!index.length) return SYSTEM_PROMPT;
  const lines = index.map((m) => `- ${m.file.replace(/\.md$/, '')} —— ${m.title}（更新于 ${fmtTime(m.updatedAt)}）`);
  return `${SYSTEM_PROMPT}

【你的记忆索引（预加载）】
${lines.join('\n')}
用 read_memory 细读，用 write_memory 更新。索引在你每次读写后会刷新（下一轮生效）。`;
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

/** Agent 读写记忆后刷新 system prompt（systemPrompt 在初始化时物化为 messages[0]） */
function refreshSystemPrompt(agent: Agent): void {
  const msgs = agent.state.messages;
  if (msgs[0]?.role === 'system') {
    msgs[0] = { role: 'system', content: buildSystemPrompt() } as unknown as AgentMessage;
  }
}

/* ---------------- 每条消息的实时身体状态注入 ---------------- */

const SOURCE_LABEL: Record<string, string> = {
  'jev-loop': '外循环快决策',
  'jev-route': '消息快反射',
  pi: '慢思考',
};

function proximityText(p: number | undefined): string {
  if (p == null) return '未知';
  if (p < 0.35) return '很近';
  if (p < 0.6) return '附近';
  return '较远';
}

/**
 * 给用户消息附加实时身体状态快照（第一人称），让慢思考每轮都能"感到"自己
 * 此刻在做什么、做了多久、谁发起的——支撑"始终以第一人称反馈自己的状态"。
 * 情景记忆仍记录原始消息文本，快照只在当轮生效。
 */
function buildUserPrompt(message: string, env?: EnvState): string {
  if (!env) return message;
  const act = env.currentAction;
  const doing = act
    ? `${act.motion}${act.expression && act.expression !== 'neutral' ? `(${act.expression})` : ''} 已 ${Math.round((Date.now() - act.since) / 1000)} 秒 · 由${SOURCE_LABEL[act.source] || act.source}发起`
    : '静立待机';
  const lines = [
    `此刻正在: ${doing}`,
    `意图 ${env.intent} · 用户${proximityText(env.userProximity)} · ${env.obstacleAhead ? '前方有障碍' : '前方无障碍'} · 能量 ${Math.round((env.energy ?? 1) * 100)}% · 社交热度 ${(env.socialDrive ?? 0).toFixed(1)}`,
  ];
  if (env.recentActions?.length) lines.push(`最近行为: ${env.recentActions.join(' → ')}`);
  if (env.recentInteraction) lines.push(`最近交互: ${env.recentInteraction}`);
  if (env.recentDialogue?.length) lines.push(`最近对话: ${env.recentDialogue.join(' / ')}`);
  if (env.memoryDirty) lines.push('有未整理的新记忆（闲时我会自己整理）');
  return `${message}

[[此刻身体状态（实时注入）]]
${lines.join('\n')}`;
}

/* ---------------- 情景记忆记录 ---------------- */

function recordEpisode(kind: EpisodeKind, text: string, actions?: string[]): void {
  if (!text || !text.trim()) return;
  const ep: Episode = { ts: Date.now(), kind, text: text.trim() };
  if (actions?.length) ep.actions = actions;
  appendEpisode(ep);
}

/** 服务启动/Agent 创建时：把最近的对话情景回放为 Agent 消息，实现重启续聊 */
function replayEpisodesAsMessages(limit = 30): AgentMessage[] {
  const msgs: AgentMessage[] = [];
  for (const ep of listEpisodes(limit)) {
    if (ep.kind === 'user_message') {
      msgs.push({ role: 'user', content: ep.text } as unknown as AgentMessage);
    } else if (ep.kind === 'agent_reply') {
      // 合法的 AssistantMessage（content 必须是块数组，且需 api/provider/usage/stopReason 元数据）
      msgs.push({
        role: 'assistant',
        content: [{ type: 'text', text: ep.text }],
        api: 'openai-completions',
        provider: 'replay',
        model: 'replayed-from-episodes',
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'stop',
      } as unknown as AgentMessage);
    }
  }
  return msgs;
}

/* ---------------- Agent 会话（单例，串行处理请求） ---------------- */

let agentPromise: Promise<Agent> | null = null;

function getAgent(): Promise<Agent | null> {
  return (async () => {
    const m = await resolveModel();
    if (!m) return null;
    if (agentPromise) return agentPromise;
    const model = models.getModel(m.provider, m.id)!;
    agentPromise = (async () => {
      const agent = new Agent({
        initialState: {
          systemPrompt: buildSystemPrompt(),
          model,
          thinkingLevel: 'low',
          // 工具集（身体能力 + 记忆能力）独立维护于 server/tools.ts
          tools: createRobotTools({ getSnapshot: () => snapshot, emitCommand }),
          // 重启续聊：把最近的对话情景回放为消息历史（记忆经 systemPrompt 索引 + 工具按需细读）
          messages: replayEpisodesAsMessages(),
        },
        streamFn: models.streamSimple.bind(models),
        convertToLlm: (msgs: AgentMessage[]) =>
          msgs.filter((msg) => ['system', 'user', 'assistant', 'toolResult'].includes(msg.role)),
        transformContext: async (msgs: AgentMessage[]) =>
          msgs.length > 60 ? [...msgs.slice(0, 2), ...msgs.slice(-50)] : msgs,
      } as ConstructorParameters<typeof Agent>[0]);
      agent.subscribe((event) => {
        if (event.type === 'tool_execution_start') {
          const ev = event as unknown as { toolName?: string; args?: unknown };
          toolTrace.push({ tool: ev.toolName ?? 'unknown', args: ev.args });
        }
      });
      return agent;
    })();
    return agentPromise;
  })();
}

function extractReply(agent: Agent): string {
  const msgs = agent.state.messages as Array<{ role: string; content: unknown }>;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role !== 'assistant') continue;
    const c = m.content;
    if (typeof c === 'string' && c.trim()) return c.trim();
    if (Array.isArray(c)) {
      const text = c
        .map((b) => (b as { type?: string; text?: string }))
        .filter((b) => b.type === 'text' && b.text)
        .map((b) => b.text)
        .join('\n')
        .trim();
      if (text) return text;
    }
  }
  return '';
}

/* ---------------- HTTP 处理 ---------------- */

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, data: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(data));
}

// 串行化对话请求，避免并发 prompt
let chain: Promise<unknown> = Promise.resolve();

/** 工具执行 → 指令入队 + 实时通知（SSE 边说边动） */
let onCommandEmitted: ((cmd: AgentCommand) => void) | null = null;
function emitCommand(cmd: AgentCommand): void {
  pendingCommands.push(cmd);
  onCommandEmitted?.(cmd);
}

/** SSE 事件写出 */
function sseSend(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
  try {
    const body = JSON.parse((await readBody(req)) || '{}') as {
      message?: string;
      env?: EnvState;
      lastDecision?: DecisionPayload | null;
    };
    const message = (body.message || '').trim();
    if (!message) return json(res, 400, { error: 'empty message' });

    const agent = await getAgent();
    if (!agent) {
      return json(res, 503, { error: '未配置大模型 API Key：请在 .env 设置 LLM_API_KEY（DeepSeek）或 PI_AGENT_MODEL' });
    }

    snapshot = { env: body.env, lastDecision: body.lastDecision ?? null };
    pendingCommands = [];
    toolTrace = [];
    // 情景记忆：用户发言入档（Pi 回复与动作在对话结束后入档）
    recordEpisode('user_message', message);

    // SSE 流式响应
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    let closed = false;
    req.on('close', () => { closed = true; });
    const send = (event: string, data: unknown) => {
      if (!closed) sseSend(res, event, data);
    };

    // 流式增量文本：既转发给前端，也作为本次运行"真正说了什么"的凭据（情景记忆用）。
    // 不用 extractReply 兜底——它会回捞上一轮的旧回复，导致重复入档。
    let streamedText = '';

    const m = await resolveModel();
    send('meta', { model: m ? `${m.provider}/${m.id}` : '' });

    // 串行执行；执行期间把 Agent 流事件转发为 SSE
    const run = chain.then(
      () =>
        new Promise<void>((resolveRun) => {
          const unsubscribe = agent.subscribe((event) => {
            // 文本增量 → 流式回复
            if (event.type === 'message_update') {
              const ame = event.assistantMessageEvent as { type?: string; delta?: string };
              if (ame?.type === 'text_delta' && ame.delta) {
                streamedText += ame.delta;
                send('delta', { text: ame.delta });
              }
              return;
            }
            // 工具调用开始 → 实时轨迹
            if (event.type === 'tool_execution_start') {
              const ev = event as unknown as { toolName: string; args: unknown };
              send('tool', { tool: ev.toolName, args: ev.args });
              return;
            }
            if (event.type === 'agent_end') {
              resolveRun();
            }
          });
          onCommandEmitted = (cmd) => send('command', cmd);
          // prompt 完成或失败都要结束本次流；订阅随即移除
          // 消息末尾注入实时身体状态快照（记忆入档仍用原始文本）
          agent
            .prompt(buildUserPrompt(message, snapshot.env))
            .catch((err) => {
              const msg = err instanceof Error ? err.message : String(err);
              send('error', { error: `agent_error: ${msg}` });
            })
            .finally(() => {
              onCommandEmitted = null;
              unsubscribe();
              resolveRun();
            });
        }),
    );
    chain = run.catch(() => undefined); // 防断链

    await run;
    if (closed) return;
    const model = await resolveModel();
    const reply = extractReply(agent);
    const commands = pendingCommands.splice(0);
    // 诊断：流内失败（如 provider 报错）会记在 state.errorMessage，prompt() 不抛错
    const runError = (agent.state as { errorMessage?: string }).errorMessage ?? null;
    if (runError) console.error('[pi-agent] run errorMessage:', runError);
    // 情景记忆：Pi 本轮真正说出的话、身体动作、场景事件入档（供 idle 整理提炼长期记忆）
    recordEpisode('agent_reply', streamedText.trim());
    // 对话中 Agent 可能读写过记忆文件 → 刷新 system prompt 中的记忆索引
    refreshSystemPrompt(agent);
    for (const cmd of commands) {
      if (cmd.type === 'command' && cmd.motion !== 'reply') {
        recordEpisode('agent_action', `我做了动作 ${cmd.motion}${cmd.expression ? `（表情 ${cmd.expression}）` : ''}`, [
          cmd.expression ? `${cmd.motion}(${cmd.expression})` : cmd.motion,
        ]);
      } else if (cmd.type === 'trigger_event') {
        recordEpisode('scene_event', `我设想了情景 ${cmd.name}`);
      }
    }
    sseSend(res, 'done', {
      reply,
      commands,
      tools: [...toolTrace],
      model: model ? `${model.provider}/${model.id}` : '',
      error: runError,
    });
    res.end();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[pi-agent] chat error:', msg);
    // SSE 已开始则流内报错，否则普通 JSON 错误
    if (res.headersSent && !res.writableEnded) {
      sseSend(res, 'error', { error: `agent_error: ${msg}` });
      res.end();
    } else {
      return json(res, 500, { error: `agent_error: ${msg}` });
    }
  }
}

async function handleHealth(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const m = await resolveModel();
  if (!m) {
    return json(res, 200, { ok: false, reason: '未配置模型 Key（.env: LLM_API_KEY）' });
  }
  return json(res, 200, { ok: true, model: `${m.provider}/${m.id}` });
}

/* ---------------- P3 idle 整理：Agent 经记忆工具自主整理（非写死流程） ---------------- */

/**
 * 整理时刻的内心活动。外循环（Jev consolidate 动作）发起，主 Agent 自己决定
 * 怎么整理：读情景流水 → 对照现有记忆 → 增量写入记忆文件。服务端不做任何
 * 写死的提炼/合并/游标推进，只提供存储与索引。
 */
const CONSOLIDATE_THOUGHT = `【独处整理时刻】这是你自己的内心活动，不是用户发言——外循环看你闲下来了，你决定趁现在整理记忆：
1. 先 read_recent_episodes 回顾最近的经历，再 read_memory 翻看现有记忆文件，避免重复记录；
2. 把值得长期记住的增量内容用 write_memory 写入合适的记忆文件（文件如何组织由你决定）；
3. 没有值得记的就不用写，如实说明没有新东西。
最后用一两句话（第一人称）说说你这次记住了什么。`;

async function handleConsolidate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
  try {
    const agent = await getAgent();
    if (!agent) return json(res, 503, { error: '未配置大模型 API Key：请在 .env 设置 LLM_API_KEY' });
    await readBody(req); // 无需参数：读多少情景、怎么整理由 Agent 经工具自主决定

    const runTools: Array<{ tool: string; args?: unknown }> = [];
    let streamed = '';
    let commandsStart = 0;

    // 串行化：与对话请求互斥（同一时刻 Agent 只做一件事）
    const run = chain.then(
      () =>
        new Promise<void>((resolveRun) => {
          streamed = '';
          commandsStart = pendingCommands.length;
          const unsubscribe = agent.subscribe((event) => {
            if (event.type === 'message_update') {
              const ame = event.assistantMessageEvent as { type?: string; delta?: string };
              if (ame?.type === 'text_delta' && ame.delta) streamed += ame.delta;
              return;
            }
            if (event.type === 'tool_execution_start') {
              const ev = event as unknown as { toolName?: string; args?: unknown };
              runTools.push({ tool: ev.toolName ?? 'unknown', args: ev.args });
              return;
            }
            if (event.type === 'agent_end') {
              resolveRun();
            }
          });
          agent
            .prompt(CONSOLIDATE_THOUGHT)
            .catch((err) => {
              console.error('[pi-agent] consolidate prompt error:', err instanceof Error ? err.message : err);
              resolveRun();
            })
            .finally(() => unsubscribe());
        }),
    );
    chain = run.catch(() => undefined); // 防断链
    await run;

    // Agent 整理中可能顺带 command_robot（如思考的姿态），交还浏览器执行
    const commands = pendingCommands.splice(commandsStart);
    const summary = streamed.trim();
    if (summary) recordEpisode('consolidate', summary);
    // Agent 刚读写过记忆文件 → 刷新 system prompt 中的记忆索引（下一轮生效）
    refreshSystemPrompt(agent);
    console.log(`[pi-agent] 记忆整理(自主)完成: ${summary.slice(0, 60) || '无输出'}`);
    return json(res, 200, { summary: summary || '这次没有要补记的内容', commands, tools: runTools });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[pi-agent] consolidate error:', msg);
    return json(res, 500, { error: `consolidate_error: ${msg}` });
  }
}

/** 记忆查看（调试）：记忆索引 + 最近情景 */
function handleMemory(_req: IncomingMessage, res: ServerResponse): void {
  return json(res, 200, {
    memoryIndex: listMemoryIndex(),
    episodes: listEpisodes(20).slice().reverse(),
  });
}

/** Vite 插件：挂载 /api/agent/* 中间件 */
export function piAgentPlugin(): Plugin {
  return {
    name: 'pi-agent-proxy',
    configureServer(server) {
      server.middlewares.use('/api/agent/health', (req, res) => {
        void handleHealth(req, res);
      });
      server.middlewares.use('/api/agent/consolidate', (req, res) => {
        void handleConsolidate(req, res);
      });
      server.middlewares.use('/api/agent/memory', (req, res) => {
        handleMemory(req, res);
      });
      server.middlewares.use('/api/agent/chat', (req, res) => {
        void handleChat(req, res);
      });
    },
  };
}
