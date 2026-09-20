/**
 * Jev 决策语义：数字人控制域的「问题集(questions)」与「答案(answers)」。
 *
 * 这是把 Jev 当作机器人决策层的核心抽象：
 *   state（感知到的环境+内部状态） → 一组类型化问题 → 类型化决策。
 * 引擎（本地模拟 or 真实 Jev）都用同一份 schema，返回相同的答案结构，
 * 因此上层控制逻辑与引擎实现完全解耦。
 */

export type Motion = 'idle' | 'walk' | 'wave' | 'dance' | 'point' | 'shrug' | 'march' | 'reply';
export type Expression = 'neutral' | 'happy' | 'sad' | 'surprised' | 'angry';

export interface EnvState {
  intent: string;
  userProximity: number; // 0 近 .. 1 远
  obstacleAhead: boolean;
  energy: number;
  objectsDetected: string[];
  event: string | null;
  note: string;
  /* ---- P1 感知入环：真实刺激带来的内部状态 ---- */
  socialDrive: number; // 0..1 社交驱动（对话热度），用户消息抬升、随时间衰减
  recentInteraction: string; // 最近交互摘要（用户说了什么/我刚做了什么），供决策理解上下文
  memoryDirty: boolean; // 有未整理的新记忆（P3 idle 整理用）
}

/** 归一化后的决策意图（控制器/执行器直接消费） */
export interface RobotDecision {
  motion: string;
  expression: string;
  intensity: number;
  lookAtUser: boolean;
  confidence: number | null;
  probabilities: Record<string, number> | null;
  raw: unknown;
  engine?: string;
  warning?: string;
  gated?: boolean;
}

/** 一次决策步进的完整载荷（含 env/门控信息），供 UI 展示 */
export interface DecisionPayload {
  tick: number;
  env: EnvState;
  decision: RobotDecision;
  applied: RobotDecision;
  gated: boolean;
  engine: string;
  ts: number;
}

/** Pi 智能体（System Two）/ Jev 消息路由下发给机器人的指令 */
export type AgentCommand =
  | { type: 'set_intent'; intent: string; note?: string }
  | { type: 'trigger_event'; name: string }
  | {
      type: 'command';
      motion: string;
      expression?: string;
      intensity?: number;
      lookAtUser?: boolean;
      /** 指令来源引擎（用于决策面板标签），默认 pi-agent */
      engine?: string;
    };

/* ---------- Jev 问题/答案类型 ---------- */

export interface JevQuestion {
  type: 'choice' | 'score' | 'noul';
  instructions: string;
  criteria: unknown;
}

export interface ChoiceAnswer {
  type: 'choice';
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface ScoreAnswer {
  type: 'score';
  score: number;
  legend: Record<string, string>;
  probabilities?: Record<string, number>;
  confidence?: number;
}

export interface NoulAnswer {
  type: 'noul';
  noul: number;
}

export interface JevAnswers {
  action?: ChoiceAnswer;
  expression?: ChoiceAnswer;
  intensity?: ScoreAnswer;
  lookAtUser?: NoulAnswer;
  [key: string]: ChoiceAnswer | ScoreAnswer | NoulAnswer | undefined;
}

/* ---------- 消息响应决策：动作并行打分，可同时执行 ---------- */

/** 单个动作的执行倾向分（0..1）与是否触发 */
export interface MessageActionScore {
  motion: Motion;
  score: number;
  trigger: boolean;
}

/**
 * 用户消息的响应决策：对每个动作（含 reply「说话」）独立打分，
 * 阈值以上的动作同时执行 —— 例如边挥手边回复。
 */
export interface MessageResponseDecision {
  /** 全部动作打分（按分数降序） */
  actions: MessageActionScore[];
  /** 触发的动作（score ≥ 阈值，降序；含 reply 表示要说话） */
  triggered: Motion[];
  expression: string;
  intensity: number;
  lookAtUser: boolean;
  engine?: string;
  warning?: string;
}

/** 动作触发阈值：score ≥ 0.5 即执行 */
export const MESSAGE_TRIGGER_THRESHOLD = 0.5;

export const MOTIONS: Motion[] = ['idle', 'walk', 'wave', 'dance', 'point', 'shrug', 'march', 'reply'];
export const EXPRESSIONS: Expression[] = ['neutral', 'happy', 'sad', 'surprised', 'angry'];

export const MOTION_LABEL: Record<string, string> = {
  idle: '待机 IDLE',
  walk: '行走 WALK',
  wave: '挥手 WAVE',
  dance: '舞动 DANCE',
  point: '指向 POINT',
  shrug: '耸肩 SHRUG',
  march: '踏步 MARCH',
  reply: '回复 REPLY',
};

export const EXPRESSION_LABEL: Record<string, string> = {
  neutral: '平静 NEUTRAL',
  happy: '开心 HAPPY',
  sad: '难过 SAD',
  surprised: '惊讶 SURPRISED',
  angry: '生气 ANGRY',
};

/** 动作描述：消息响应决策中每个动作的独立评分依据 */
const MESSAGE_MOTION_DESC: Record<Motion, string> = {
  reply: 'answer verbally — needs language, thought, explanation, planning, or conversation',
  wave: 'wave the hand — greeting, welcoming, saying hi or goodbye',
  dance: 'dance — celebration, party, burst of joy',
  walk: 'walk — move forward, approach, or step closer',
  point: 'point — give directions or indicate an object',
  shrug: 'shrug — uncertain, indifferent, no way to help',
  march: 'march in place — energize, keep cadence, drilling',
  idle: 'stay idle — stop, rest, stand still',
};

/**
 * 构造「消息响应决策」问题集：每个动作（含 reply）一个独立 noul 问题，
 * 各自打分互不排斥 —— 阈值以上的动作同时执行；另附表情/强度/朝向问题。
 */
export function buildMessageQuestions(
  env: EnvState,
  message: string,
): Record<string, JevQuestion> {
  const base = buildQuestions(env);
  const msg = (message || '').trim();
  const questions: Record<string, JevQuestion> = {
    expression: base.expression!,
    intensity: base.intensity!,
    lookAtUser: base.lookAtUser!,
  };
  for (const m of MOTIONS) {
    questions[m] = {
      type: 'noul',
      instructions:
        `The user just said to the robot: "${msg}". `
        + `Rate INDEPENDENTLY whether the robot should ${MESSAGE_MOTION_DESC[m]} `
        + '(0 = definitely not, 1 = definitely yes). '
        + 'Multiple actions can be true simultaneously — e.g. answer verbally while waving.',
      criteria: { false: 'No, should not do this.', true: 'Yes, should do this.' },
    };
  }
  return questions;
}

/**
 * 解析「消息响应决策」答案：每个动作 noul → 0..1 分，
 * ≥ 阈值触发；无触发时兜底最高分动作（过低则强制 reply，宁可说话）。
 */
export function normalizeMessageDecision(
  answers: JevAnswers | null,
  fallback: { expression: string; intensity: number; lookAtUser: boolean },
): MessageResponseDecision {
  const clamp01 = (v: unknown) => Math.max(0, Math.min(1, Number(v) || 0));
  const actions: MessageActionScore[] = MOTIONS.map((motion) => {
    const a = answers?.[motion];
    let score = 0;
    if (a?.type === 'noul') score = clamp01(a.noul);
    else if (a?.type === 'score') score = clamp01(a.score / 2);
    else if (a?.type === 'choice') score = clamp01(a.confidence);
    return { motion, score, trigger: score >= MESSAGE_TRIGGER_THRESHOLD };
  });
  if (!actions.some((a) => a.trigger)) {
    const best = [...actions].sort((a, b) => b.score - a.score)[0];
    if (best && best.score >= 0.25) best.trigger = true;
    else {
      const reply = actions.find((a) => a.motion === 'reply')!;
      reply.score = Math.max(reply.score, 0.6);
      reply.trigger = true;
    }
  }
  const exprRaw = answers?.expression?.type === 'choice' ? answers.expression.choice : fallback.expression;
  const intensityRaw = answers?.intensity?.type === 'score' ? Number(answers.intensity.score) : fallback.intensity;
  const look = answers?.lookAtUser?.type === 'noul' ? answers.lookAtUser.noul > 0.6 : fallback.lookAtUser;
  return {
    actions: [...actions].sort((a, b) => b.score - a.score),
    triggered: [...actions].filter((a) => a.trigger).sort((a, b) => b.score - a.score).map((a) => a.motion),
    expression: EXPRESSIONS.includes(exprRaw as Expression) ? exprRaw : fallback.expression,
    intensity: Math.max(0, Math.min(2, intensityRaw)),
    lookAtUser: look,
  };
}

/**
 * 构造发给 Jev 的问题集（常规感知循环；动作集不含 reply——循环里没有消息可回）。
 * @param ctx 上下文（如距障碍/用户距离、能量），可用于条件化 criteria
 */
export function buildQuestions(ctx: Partial<EnvState> = {}): Record<string, JevQuestion> {
  const nearUser = (ctx.userProximity ?? 1) < 0.5;
  const actionOptions: Record<string, string> = {
    idle: 'Mission idle; relax and stand still with neutral posture.',
    walk: 'User asked to move or a waypoint is ahead; pace forward calmly.',
    wave: 'A user just arrived and should be greeted; wave to attract attention.',
    dance: 'A celebratory moment or user invitation; perform a friendly dance.',
    point: 'Give directions by pointing toward an object or location.',
    shrug: 'Uncertain or no clear way to help; shrug shoulders.',
    march: 'Energize or keep cadence; step in place with higher energy.',
  };
  return {
    action: {
      type: 'choice',
      instructions:
        'Given the robot digital-human state, which single motion should it perform next?',
      criteria: actionOptions,
    },
    expression: {
      type: 'choice',
      instructions: `What facial expression should the digital-human show? ${nearUser
        ? 'A person is nearby, so social expressions matter.'
        : 'No person is nearby; keep it neutral unless the situation calls for more.'}`,
      criteria: {
        neutral: 'Calm, flat, relaxed face.',
        happy: 'Warm, positive, smiling.',
        sad: 'Low, downcast, concerned.',
        surprised: 'Wide eyes, raised brows, open mouth.',
        angry: 'Frowning, focused, frustrated.',
      },
    },
    intensity: {
      type: 'score',
      instructions: 'How energetic should the chosen motion be performed?',
      criteria: ['Low / calm', 'Moderate', 'High / lively'],
    },
    lookAtUser: {
      type: 'noul',
      instructions: 'Should the digital-human orient to face and observe the nearby user/person?',
      criteria: {
        true: 'A person is present and should be engaged.',
        false: 'No one to engage; keep scanning the environment.',
      },
    },
  };
}

/**
 * 组装发送给引擎的 state（感知观测 + 内部状态）。
 * @param env 模拟环境信号 {intent, userProximity, obstacleAhead, energy}
 */
export function buildState(env: EnvState) {
  return {
    intent: env.intent,
    userProximity: +(env.userProximity ?? 0).toFixed(2),
    obstacleAhead: !!env.obstacleAhead,
    energy: +(env.energy ?? 1).toFixed(2),
    objectsDetected: env.objectsDetected ?? [],
    event: env.event ?? null,
    note: env.note ?? '',
    socialDrive: +(env.socialDrive ?? 0).toFixed(2),
    recentInteraction: env.recentInteraction ?? '',
    memoryDirty: !!env.memoryDirty,
  };
}

/** 从引擎返回的 answers 中归一化出控制器可直接消费的“决策意图”。 */
export function normalizeDecision(answers: JevAnswers | null, fallback: RobotDecision): RobotDecision {
  const a = answers?.action; // Choice
  const e = answers?.expression; // Choice
  const in10 = answers?.intensity; // Score
  const lu = answers?.lookAtUser; // Noul

  const motion = a ? a.choice : fallback.motion;
  const expression = e ? computeSafeExpression(e) : fallback.expression;
  const intensity = in10 ? clampScore(in10.score, in10.legend) : fallback.intensity;
  const lookAtUser = lu ? lu.noul > 0.6 : fallback.lookAtUser;

  return {
    motion,
    expression,
    intensity,
    lookAtUser,
    confidence: a ? a.confidence : 0,
    probabilities: a ? a.probabilities : null,
    raw: answers,
  };
}

function computeSafeExpression(e: ChoiceAnswer): string {
  return (EXPRESSIONS as string[]).includes(e.choice) ? e.choice : 'neutral';
}

/** Score 可能落在阶梯之间，把连续分数归一到 0..2 区间，供动画强度使用。 */
function clampScore(score: number, legend: Record<string, string>): number {
  const levels = Object.keys(legend || {}).length || 3;
  const v = Number(score) || 1;
  return Math.max(0, Math.min(levels - 1, v));
}
