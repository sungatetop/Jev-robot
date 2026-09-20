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

import { decideWithRealJev } from './jev-client.js';
import { MOTIONS, EXPRESSIONS, normalizeDecision, buildQuestions, buildState } from './semantics.js';

/** 本地规则引擎：把 env 状态映射为带概率/置信度的决策，结构对齐 Jev。 */
class LocalMockEngine {
  constructor() {
    this.tick = 0;
  }

  /** 规则打分，返回对每个 motion 的原始得分（未归一）。 */
  scoreMotions(env) {
    const s = env.userProximity ?? 1;
    const near = s < 0.5;
    const far = s > 0.7;
    // 自增 tick，引入轻量“环境噪声”，让概率分布有变化感
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

  chooseFromScores(scores, jitter = 0) {
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

  scoreExpressions(env) {
    const near = env.userProximity < 0.5;
    const s = {
      neutral: 4 + (near ? 2 : 3),
      happy: (env.event === 'arrival' || env.intent === 'celebrate' || env.intent === 'greet') ? 6 : (near ? 3 : 1),
      sad: env.intent === 'comfort' ? 6 : 0.5,
      surprised: env.obstacleAhead ? 4 : (env.event === 'surprise' ? 5 : 0.5),
      angry: env.intent === 'warn' ? 6 : (env.obstacleAhead ? 2 : 0.5),
    };
    return s;
  }

  scoreIntensity(env) {
    if (env.energy < 0.3) return { score: 0, legend: { 0: 'Low / calm', 1: 'Moderate', 2: 'High / lively' }, probabilities: { 0: 0.9, 1: 0.08, 2: 0.02 }, confidence: 0.9 };
    if (['celebrate', 'march', 'dance'].includes(env.intent) || env.event === 'dance') {
      return { score: 2, legend: { 0: 'Low / calm', 1: 'Moderate', 2: 'High / lively' }, probabilities: { 0: 0.03, 1: 0.12, 2: 0.85 }, confidence: 0.84 };
    }
    return { score: 1.2, legend: { 0: 'Low / calm', 1: 'Moderate', 2: 'High / lively' }, probabilities: { 0: 0.15, 1: 0.65, 2: 0.2 }, confidence: 0.62 };
  }

  lookAtUser(env) {
    const noul = Math.max(0.05, Math.min(0.98, 1 - env.userProximity));
    return { type: 'noul', noul };
  }

  async decide(env) {
    this.tick += 1;
    const answers = {
      action: this.chooseFromScores(this.scoreMotions(env), this.tick),
      expression: this.chooseFromScores(this.scoreExpressions(env), this.tick),
      intensity: this.scoreIntensity(env),
      lookAtUser: this.lookAtUser(env),
    };
    return normalizeDecision(answers, { motion: 'idle', expression: 'neutral', intensity: 1, lookAtUser: false });
  }
}

/** 真实 Jev 引擎，带失败回退。 */
class RealJevEngine {
  constructor({ fallbackEngine = new LocalMockEngine(), onError } = {}) {
    this.fallbackEngine = fallbackEngine;
    this.onError = onError;
    this.lastError = null;
  }

  async decide(env, opts) {
    try {
      const decision = await decideWithRealJev(env, opts);
      decision.engine = 'jev';
      return decision;
    } catch (err) {
      this.lastError = err;
      if (this.onError) this.onError(err);
      // 回退本地引擎，保证演示不中断
      const decision = await this.fallbackEngine.decide(env);
      decision.engine = 'local';
      decision.warning = err.message;
      return decision;
    }
  }
}

export function createEngine(kind = 'auto') {
  const local = new LocalMockEngine();
  if (kind === 'local') return local;
  if (kind === 'real') return new RealJevEngine({ fallbackEngine: local });
  // auto：真实优先，无法连通时向下回退（RealJevEngine 内部已处理）
  return new RealJevEngine({ fallbackEngine: local });
}

export { LocalMockEngine, RealJevEngine }; // 供 UI 直接 new/构造使用