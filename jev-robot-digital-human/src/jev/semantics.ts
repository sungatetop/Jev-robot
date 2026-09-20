/**
 * Jev 决策语义：数字人控制域的「问题集(questions)」与「答案(answers)」。
 *
 * 这是把 Jev 当作机器人决策层的核心抽象：
 *   state（感知到的环境+内部状态） → 一组类型化问题 → 类型化决策。
 * 引擎（本地模拟 or 真实 Jev）都用同一份 schema，返回相同的答案结构，
 * 因此上层控制逻辑与引擎实现完全解耦。
 */

export type Motion = 'idle' | 'walk' | 'wave' | 'dance' | 'point' | 'shrug' | 'march';
export type Expression = 'neutral' | 'happy' | 'sad' | 'surprised' | 'angry';

export interface EnvState {
  intent: string;
  userProximity: number; // 0 近 .. 1 远
  obstacleAhead: boolean;
  energy: number;
  objectsDetected: string[];
  event: string | null;
  note: string;
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

/** Pi 智能体（System Two）下发给机器人的指令 */
export type AgentCommand =
  | { type: 'set_intent'; intent: string; note?: string }
  | { type: 'trigger_event'; name: string }
  | { type: 'command'; motion: string; expression?: string; intensity?: number; lookAtUser?: boolean };

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
}

export const MOTIONS: Motion[] = ['idle', 'walk', 'wave', 'dance', 'point', 'shrug', 'march'];
export const EXPRESSIONS: Expression[] = ['neutral', 'happy', 'sad', 'surprised', 'angry'];

export const MOTION_LABEL: Record<string, string> = {
  idle: '待机 IDLE',
  walk: '行走 WALK',
  wave: '挥手 WAVE',
  dance: '舞动 DANCE',
  point: '指向 POINT',
  shrug: '耸肩 SHRUG',
  march: '踏步 MARCH',
};

export const EXPRESSION_LABEL: Record<string, string> = {
  neutral: '平静 NEUTRAL',
  happy: '开心 HAPPY',
  sad: '难过 SAD',
  surprised: '惊讶 SURPRISED',
  angry: '生气 ANGRY',
};

/**
 * 构造发给 Jev 的问题集。criteria 里的文字会给模型足够语义。
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
