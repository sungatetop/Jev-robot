/** 决策引擎统一接口与共享类型（浏览器端与工具层共用）。 */
export type { EnvState, RobotDecision, DecisionPayload, AgentCommand, Motion, Expression } from './semantics.js';
import type { EnvState, RobotDecision } from './semantics.js';

export interface DecisionEngine {
  decide(env: EnvState): Promise<RobotDecision>;
}
