/** 决策引擎统一接口与共享类型（浏览器端与工具层共用）。 */
export type { EnvState, RobotDecision, DecisionPayload, AgentCommand, Motion, Expression, MessageResponseDecision, MessageActionScore } from './semantics.js';
import type { EnvState, RobotDecision, MessageResponseDecision } from './semantics.js';

export interface DecisionEngine {
  /** 常规感知循环决策（动作集不含 reply） */
  decide(env: EnvState): Promise<RobotDecision>;
  /** 用户消息响应决策：各动作（含 reply）并行打分，阈值以上同时执行 */
  decideMessage(env: EnvState, message: string): Promise<MessageResponseDecision>;
}
