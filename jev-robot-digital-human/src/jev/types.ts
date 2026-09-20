/** 决策引擎统一接口与共享类型（浏览器端与工具层共用）。 */
export type { EnvState, RobotDecision, DecisionPayload, AgentCommand, Motion, Expression } from './semantics.js';
import type { EnvState, RobotDecision } from './semantics.js';

export interface DecisionEngine {
  /** 常规感知循环决策（动作集不含 reply） */
  decide(env: EnvState): Promise<RobotDecision>;
  /** 用户消息响应决策：reply（说话→慢思考）也是动作选项之一 */
  decideMessage(env: EnvState, message: string): Promise<RobotDecision>;
}
