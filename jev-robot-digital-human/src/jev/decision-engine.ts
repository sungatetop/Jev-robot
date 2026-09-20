/**
 * Jev 决策引擎（真实 TypeSafe Jev，经 /api/systemone 代理，浏览器不持有 Key）。
 *
 * 统一接口（DecisionEngine）：
 *   decide(env)                     → 常规感知循环决策（动作集不含 reply）
 *   decideMessage(env, message)     → 用户消息响应决策（各动作含 reply 并行打分）
 *
 * 失败策略：上抛错误，由调用方兜底——
 *   感知循环失败 → Simulation 用 idle 安全动作兜底，循环不中断；
 *   消息响应失败 → 对话默认转交慢思考（Pi），对话不中断。
 */

import { decideWithRealJev, decideMessageWithRealJev } from './jev-client.js';
import type { DecisionEngine, EnvState, RobotDecision, MessageResponseDecision } from './types.js';

/** 真实 Jev 引擎。 */
export class RealJevEngine implements DecisionEngine {
  onError?: (err: Error) => void;
  lastError: Error | null = null;

  constructor(opts: { onError?: (err: Error) => void } = {}) {
    this.onError = opts.onError;
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
      throw e;
    }
  }

  /** 消息响应决策：各动作（含 reply）并行打分，阈值以上同时执行。 */
  async decideMessage(env: EnvState, message: string): Promise<MessageResponseDecision> {
    try {
      const decision = await decideMessageWithRealJev(env, message);
      decision.engine = 'jev';
      return decision;
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      this.lastError = e;
      this.onError?.(e);
      throw e;
    }
  }
}

export type EngineKind = 'auto' | 'real';

export function createEngine(_kind: EngineKind = 'auto'): DecisionEngine {
  return new RealJevEngine();
}
