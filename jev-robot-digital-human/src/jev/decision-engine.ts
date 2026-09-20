/**
 * 可插拔 Jev 决策引擎。
 *
 * 统一接口：`decide(env) => Promise<Decision>`
 *   Decision = { motion, expression, intensity, lookAtUser, confidence, probabilities, raw }
 *
 * 两种实现：
 *   1. RealJevEngine    —— 调用真实 TypeSafe Jev（通过 /api/systemone 代理）
 *   2. LocalMockEngine  —— 离线规则引擎，返回相同结构（便于无网络/无 Key 时演示）
 * `createEngine` 根据场景自动选择；真实引擎失败时自动回退到本地引擎。
 */

import { decideWithRealJev, decideMessageWithRealJev } from './jev-client.js';
import { normalizeDecision, normalizeMessageDecision, MOTIONS, MESSAGE_TRIGGER_THRESHOLD } from './semantics.js';
import type { DecisionEngine } from './types.js';
import type { EnvState, RobotDecision, MessageResponseDecision } from './types.js';

/** 本地规则引擎：把 env 状态映射为带概率/置信度的决策，结构对齐 Jev。 */
export class LocalMockEngine implements DecisionEngine {
  private tick = 0;

  /** 规则打分，返回对每个 motion 的原始得分（未归一）。 */
  scoreMotions(env: EnvState): Record<string, number> {
    const s = env.userProximity ?? 1;
    const near = s < 0.5;
    const far = s > 0.7;
    const waveBias = 4 + (env.intent === 'greet' ? 4 : 0) + (env.event === 'arrival' ? 3 : 0);
    return {
      idle: 5 + (env.intent === 'idle' ? 5 : 0) + (far ? 2 : 0),
      walk: (env.intent === 'move' ? 6 : 1) + (env.obstacleAhead ? 3 : 0),
      wave: waveBias + (near ? 3 : 0),
      dance: (env.intent === 'celebrate' || env.event === 'dance') ? 8 : 1,
      point: (env.intent === 'direct' ? 6 : 1) + (env.obstacleAhead ? 2 : 0),
      shrug: (env.intent === 'uncertain' ? 6 : 1) + (env.obstacleAhead ? 1 : 0),
      march: env.intent === 'march' ? 8 : 1,
    };
  }

  chooseFromScores(scores: Record<string, number>): { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number } {
    // softmax 加权得到“伪概率”
    const exp = Object.fromEntries(
      Object.entries(scores).map(([k, v]) => [k, Math.exp(v * 0.55)])
    );
    const sum = Object.values(exp).reduce((a, b) => a + b, 0);
    const probs = Object.fromEntries(Object.entries(exp).map(([k, v]) => [k, v / sum]));
    const confidence = Math.max(...Object.values(probs));
    const choice = Object.entries(probs).sort((a, b) => b[1] - a[1])[0][0];
    return { type: 'choice', choice, probabilities: probs, confidence };
  }

  scoreExpressions(env: EnvState): Record<string, number> {
    const near = env.userProximity < 0.5;
    return {
      neutral: 4 + (near ? 2 : 3),
      happy: (env.event === 'arrival' || env.intent === 'celebrate' || env.intent === 'greet') ? 6 : (near ? 3 : 1),
      sad: env.intent === 'comfort' ? 6 : 0.5,
      surprised: env.obstacleAhead ? 4 : (env.event === 'surprise' ? 5 : 0.5),
      angry: env.intent === 'warn' ? 6 : (env.obstacleAhead ? 2 : 0.5),
    };
  }

  scoreIntensity(env: EnvState) {
    if (env.energy < 0.3) {
      return { type: 'score' as const, score: 0, legend: { '0': 'Low / calm', '1': 'Moderate', '2': 'High / lively' }, confidence: 0.9 };
    }
    if (['celebrate', 'march', 'dance'].includes(env.intent) || env.event === 'dance') {
      return { type: 'score' as const, score: 2, legend: { '0': 'Low / calm', '1': 'Moderate', '2': 'High / lively' }, confidence: 0.84 };
    }
    return { type: 'score' as const, score: 1.2, legend: { '0': 'Low / calm', '1': 'Moderate', '2': 'High / lively' }, confidence: 0.62 };
  }

  lookAtUser(env: EnvState) {
    const noul = Math.max(0.05, Math.min(0.98, 1 - env.userProximity));
    return { type: 'noul' as const, noul };
  }

  async decide(env: EnvState): Promise<RobotDecision> {
    this.tick += 1;
    const answers = {
      action: this.chooseFromScores(this.scoreMotions(env)),
      expression: this.chooseFromScores(this.scoreExpressions(env)),
      intensity: this.scoreIntensity(env),
      lookAtUser: this.lookAtUser(env),
    };
    return normalizeDecision(answers, { motion: 'idle', expression: 'neutral', intensity: 1, lookAtUser: false, confidence: 0, probabilities: null, raw: null });
  }

  /**
   * 用户消息响应决策（并行打分）：关键词规则给每个动作独立打 0..1 分，
   * 阈值以上同时执行 —— 可边说话边做动作。
   */
  async decideMessage(env: EnvState, message: string): Promise<MessageResponseDecision> {
    const m = message.toLowerCase();
    const has = (re: RegExp) => re.test(m);
    // 语言性语义（问句/长句/需要表达）→ 说话倾向高
    const verbal =
      has(/[?？]|为什么|怎么|什么|如何|介绍|讲|说说|聊|告诉我|你觉得|能不能|可以不|帮我|你是谁|你叫/)
      || message.length > 18;
    const scores: Record<string, number> = {
      reply: verbal ? 0.92 : 0.3,
      wave: has(/嗨|哈喽|你好|您好|hello|hi\b|欢迎|挥手|招手|打招呼/) ? 0.9 : 0.12,
      dance: has(/跳舞|舞|庆祝|dance|celebrat|嗨起来/) ? 0.94 : 0.1,
      walk: has(/走|走两步|前进|移动|过来|walk|move/) ? 0.85 : 0.1,
      point: has(/指|方向|哪里|哪边|where|指南/) ? 0.8 : 0.08,
      march: has(/踏步|原地走|行军|march/) ? 0.9 : 0.06,
      shrug: has(/不知道|说不上来|无所谓|随便你|shrug/) ? 0.8 : 0.06,
      idle: has(/停|停下|站好|休息|别动|stop|停一下/) ? 0.88 : 0.15,
    };
    const expr = this.chooseFromScores(this.scoreExpressions(env)).choice;
    const intensity = this.scoreIntensity(env).score;
    const lookAtUser = this.lookAtUser(env).noul > 0.6;
    return {
      actions: MOTIONS
        .map((motion) => ({ motion, score: scores[motion] ?? 0, trigger: (scores[motion] ?? 0) >= MESSAGE_TRIGGER_THRESHOLD }))
        .sort((a, b) => b.score - a.score),
      triggered: MOTIONS
        .filter((motion) => (scores[motion] ?? 0) >= MESSAGE_TRIGGER_THRESHOLD)
        .sort((a, b) => (scores[b] ?? 0) - (scores[a] ?? 0)),
      expression: expr,
      intensity,
      lookAtUser,
      engine: 'local',
    };
  }
}

/** 真实 Jev 引擎，带失败回退。 */
export class RealJevEngine implements DecisionEngine {
  private fallbackEngine: DecisionEngine;
  private onError?: (err: Error) => void;
  lastError: Error | null = null;

  constructor({ fallbackEngine = new LocalMockEngine(), onError }: {
    fallbackEngine?: DecisionEngine;
    onError?: (err: Error) => void;
  } = {}) {
    this.fallbackEngine = fallbackEngine;
    this.onError = onError;
  }

  async decide(env: EnvState): Promise<RobotDecision> {
    try {
      const decision = await decideWithRealJev(env);
      decision.engine = 'jev';
      return decision;
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      this.lastError = e;
      this.onError?.(e);
      // 回退本地引擎，保证演示不中断
      const decision = await this.fallbackEngine.decide(env);
      decision.engine = 'local';
      decision.warning = e.message;
      return decision;
    }
  }

  /** 消息响应决策：真实 Jev 并行打分（含 reply），失败回退本地规则。 */
  async decideMessage(env: EnvState, message: string): Promise<MessageResponseDecision> {
    try {
      const decision = await decideMessageWithRealJev(env, message);
      decision.engine = 'jev';
      return decision;
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      this.lastError = e;
      this.onError?.(e);
      const decision = await this.fallbackEngine.decideMessage(env, message);
      decision.engine = 'local';
      decision.warning = e.message;
      return decision;
    }
  }
}

export type EngineKind = 'auto' | 'real' | 'local';

export function createEngine(kind: EngineKind = 'auto'): DecisionEngine {
  const local = new LocalMockEngine();
  if (kind === 'local') return local;
  // auto/real：真实优先，无法连通时向下回退（RealJevEngine 内部已处理）
  return new RealJevEngine({ fallbackEngine: local });
}
