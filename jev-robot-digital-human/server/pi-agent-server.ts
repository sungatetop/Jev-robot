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
import type { AgentMessage, AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { MOTIONS, EXPRESSIONS } from '../src/jev/semantics';
import type { AgentCommand, EnvState, DecisionPayload } from '../src/jev/types';

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

const SYSTEM_PROMPT = `你是 Pi，机器人数字人的「System Two 慢思考」智能体。

背景：机器人的「System One」（Jev 决策层）以固定频率做快速的动作/表情决策；
你负责慢思考——理解用户的自然语言请求，规划机器人该做什么，并通过工具控制机器人。

可用工具：
- get_robot_state：查询当前感知状态与最近一次 System One 决策（先查状态再行动）
- set_robot_intent：设置机器人意图，影响后续 System One 决策方向（持续生效）
- command_robot：直接下发动作用/表情指令（立即执行一次），适合明确的单次动作请求
- trigger_scene_event：注入场景事件（arrival 用户走近 / move 前进 / obstacle 障碍物 /
  direct 指引 / celebrate 庆祝 / uncertain 不确定 / reset 恢复待机）

原则：
1. 收到请求后先用 get_robot_state 了解现状，再决定用什么工具。
2. 可以在一次回复中组合调用多个工具。
3. 环境状态（userProximity/obstacleAhead/energy）会随时间漂移，注意时效性。
4. 最后用简体中文简短回复用户：说明你为机器人做了什么安排。`;

/* ---------------- 机器人控制工具 ---------------- */

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }], details: {} };
}

const getStateTool: AgentTool<any> = {
  name: 'get_robot_state',
  label: '查询机器人状态',
  description: '获取机器人当前感知状态(意图/用户距离/障碍物/能量)与最近一次 System One 决策。',
  parameters: Type.Object({}),
  execute: async () => {
    return ok(JSON.stringify(snapshot, null, 2));
  },
};

const setIntentTool: AgentTool<any> = {
  name: 'set_robot_intent',
  label: '设置意图',
  description: '设置机器人意图（持续影响 System One 快速决策的方向）。',
  parameters: Type.Object({
    intent: Type.Union(MOTIONS.map((m) => Type.Literal(m)), { description: `意图: ${MOTIONS.join('/')}` }),
    note: Type.Optional(Type.String({ description: '一句话说明设置原因' })),
  }),
  execute: async (_id, params) => {
    const { intent, note } = params as { intent: string; note?: string };
    pendingCommands.push({ type: 'set_intent', intent, note });
    return ok(`intent 已设置为 ${intent}`);
  },
};

const commandTool: AgentTool<any> = {
  name: 'command_robot',
  label: '直接指令',
  description: '立即让机器人执行一次动作/表情（跳过 System One 循环）。',
  parameters: Type.Object({
    motion: Type.Union(MOTIONS.map((m) => Type.Literal(m)), { description: `动作: ${MOTIONS.join('/')}` }),
    expression: Type.Optional(Type.Union(EXPRESSIONS.map((m) => Type.Literal(m)))),
    intensity: Type.Optional(Type.Number({ minimum: 0, maximum: 2, description: '0 低强度 .. 2 高强度' })),
    look_at_user: Type.Optional(Type.Boolean({ description: '是否面向用户' })),
  }),
  execute: async (_id, params) => {
    const p = params as { motion: string; expression?: string; intensity?: number; look_at_user?: boolean };
    pendingCommands.push({
      type: 'command',
      motion: p.motion,
      expression: p.expression,
      intensity: p.intensity,
      lookAtUser: p.look_at_user,
    });
    return ok(`已下发动作 ${p.motion}`);
  },
};

const eventTool: AgentTool<any> = {
  name: 'trigger_scene_event',
  label: '注入场景事件',
  description: '向机器人环境注入一个场景事件，改变感知状态。',
  parameters: Type.Object({
    name: Type.Union(
      ['arrival', 'move', 'obstacle', 'direct', 'celebrate', 'uncertain', 'reset'].map((n) => Type.Literal(n)),
    ),
  }),
  execute: async (_id, params) => {
    const { name } = params as { name: string };
    pendingCommands.push({ type: 'trigger_event', name });
    return ok(`场景事件 ${name} 已注入`);
  },
};

const robotTools: Array<AgentTool<any>> = [getStateTool, setIntentTool, commandTool, eventTool];

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
          systemPrompt: SYSTEM_PROMPT,
          model,
          thinkingLevel: 'low',
          tools: robotTools,
          messages: [],
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

    const run = chain.then(async () => {
      await agent.prompt(message);
      return {
        reply: extractReply(agent),
        commands: pendingCommands.splice(0),
        tools: [...toolTrace],
        model: `${(await resolveModel())!.provider}/${(await resolveModel())!.id}`,
      };
    });
    chain = run.catch(() => undefined); // 防断链
    const result = (await run) as Awaited<typeof run>;
    return json(res, 200, result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[pi-agent] chat error:', msg);
    return json(res, 500, { error: `agent_error: ${msg}` });
  }
}

async function handleHealth(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const m = await resolveModel();
  if (!m) {
    return json(res, 200, { ok: false, reason: '未配置模型 Key（.env: LLM_API_KEY）' });
  }
  return json(res, 200, { ok: true, model: `${m.provider}/${m.id}` });
}

/** Vite 插件：挂载 /api/agent/* 中间件 */
export function piAgentPlugin(): Plugin {
  return {
    name: 'pi-agent-proxy',
    configureServer(server) {
      server.middlewares.use('/api/agent/health', (req, res) => {
        void handleHealth(req, res);
      });
      server.middlewares.use('/api/agent/chat', (req, res) => {
        void handleChat(req, res);
      });
    },
  };
}
