/**
 * 决策循环控制器：把 Jev 的“决策层”串进实时控制闭环。
 *
 *   while(running) {
 *     env = 读取感知状态(模拟环境)
 *     决策 = engine.decide(env)          // 真实 Jev（失败 idle 兜底）
 *     若 决策.confidence < gate → 回退到安全动作 idle（置信度门控）
 *     下推给执行器(avatar.setDecision)
 *     等待 LOOP_MS，重复
 *   }
 *
 * 这是“基于 Jev 的机器人控制”的可运行演示：Jev/本地引擎只负责做类型化
 * 决策，外围代码负责环境状态、置信度门控、执行与安全回退。
 */
import type { EnvState, RobotDecision, DecisionPayload, DecisionEngine } from './jev/types.js';

/** 感知事件：真实刺激（用户消息/智能体行为）进入感知循环的统一入口 */
export type PerceptionEvent =
  | { type: 'user_message'; text: string; ts: number }
  | { type: 'agent_action'; motion: string; expression?: string; by: string; ts: number }
  | { type: 'agent_reply'; summary: string; ts: number }
  | { type: 'scene_event'; name: string; ts: number };

export interface SimulationOptions {
  engine: DecisionEngine;
  onDecision?: (payload: DecisionPayload) => void;
  onEnv?: (env: EnvState) => void;
  onGated?: (payload: DecisionPayload) => void;
  loopMs?: number;
  gate?: number;
}

export class Simulation {
  engine: DecisionEngine;
  loopMs: number;
  gate: number; // 置信度门控阈值
  onDecision: (payload: DecisionPayload) => void;
  onEnv: (env: EnvState) => void;
  onGated: (payload: DecisionPayload) => void;
  running = false;
  tick = 0;
  env: EnvState;

  private timer: ReturnType<typeof setInterval> | null = null;

  constructor({ engine, onDecision, onEnv, onGated, loopMs = 3200, gate = 0.45 }: SimulationOptions) {
    this.engine = engine;
    this.loopMs = loopMs;
    this.gate = gate;
    this.onDecision = onDecision ?? (() => {});
    this.onEnv = onEnv ?? (() => {});
    this.onGated = onGated ?? (() => {});
    this.env = this.freshEnv('idle');
  }

  freshEnv(intent: string, extra: Partial<EnvState> = {}): EnvState {
    return {
      intent,
      userProximity: 0.85, // 0 近 .. 1 远
      obstacleAhead: false,
      energy: 1.0,
      objectsDetected: [],
      event: null,
      note: '',
      socialDrive: 0,
      recentInteraction: '',
      memoryDirty: false,
      currentAction: null,
      recentActions: [],
      ...extra,
    };
  }

  /* ---------- 行为状态回环：一切行为统一回流外层循环 ---------- */

  /**
   * 行为回流：一次动作真正执行后调用（无论来源），外层下一轮决策即可见。
   * 同一动作延续时不重置起始时间（"跳舞已跳了 N 秒"对决策可见）。
   * @param source 行为来源 'jev-loop' | 'pi' | 'jev-route'
   */
  noteAction(motion: string, expression: string, source: string): void {
    const cur = this.env.currentAction;
    if (cur && cur.motion === motion) {
      // 延续：保留起始时间，仅刷新表情与来源（行为主权转移可见）
      cur.expression = expression;
      cur.source = source;
    } else {
      this.env.currentAction = { motion, expression, source, since: Date.now() };
      this.env.recentActions = [`${motion}(${source})`, ...(this.env.recentActions ?? [])].slice(0, 5);
      this.env.memoryDirty = true;
    }
    this.onEnv({ ...this.env });
  }

  /* ---------- P1 感知入环：真实刺激即时更新 env ---------- */

  /** 外部刺激即时写入感知状态（感知连续、决策周期）：用户消息/智能体行为 → 更新 env */
  perceive(evt: PerceptionEvent): void {
    this.applyPerception(evt);
  }

  /** 消费感知事件，更新内部状态（对话热度/用户距离/交互摘要） */
  private applyPerception(evt: PerceptionEvent): void {
    switch (evt.type) {
      case 'user_message':
        this.env.socialDrive = Math.min(1, this.env.socialDrive + 0.6);
        this.env.userProximity = 0.2; // 用户开口 → 视为就在跟前
        this.env.recentInteraction = `用户刚说: "${evt.text.slice(0, 40)}"`;
        this.env.memoryDirty = true;
        break;
      case 'agent_action':
        // 行为回流：内层（快反射/慢思考）执行的动作进入外层行为状态
        this.noteAction(evt.motion, evt.expression ?? 'neutral', evt.by);
        this.env.recentInteraction = `我刚做了动作 ${evt.motion}（来自 ${evt.by === 'jev-route' ? '消息快反射' : evt.by === 'pi' ? '慢思考' : evt.by}）`;
        break;
      case 'agent_reply':
        this.env.recentInteraction = `我刚回复了: "${evt.summary.slice(0, 40)}"`;
        this.env.memoryDirty = true;
        break;
      case 'scene_event':
        this.triggerEvent(evt.name);
        break;
    }
    this.onEnv({ ...this.env });
  }

  /** 由 UI 触发场景事件，改变感知状态 */
  triggerEvent(name: string): EnvState {
    this.env.event = name;
    switch (name) {
      case 'arrival':
        this.env.intent = 'greet';
        this.env.userProximity = 0.2;
        this.env.note = '检测到用户走近，需问候';
        break;
      case 'move':
        this.env.intent = 'move';
        this.env.obstacleAhead = false;
        this.env.note = '导航到前方目标点';
        break;
      case 'obstacle':
        this.env.intent = 'move';
        this.env.obstacleAhead = true;
        this.env.note = '前方探测到障碍物';
        break;
      case 'direct':
        this.env.intent = 'direct';
        this.env.note = '为用户指引方向';
        break;
      case 'celebrate':
        this.env.intent = 'celebrate';
        this.env.note = '任务达成，进入庆祝';
        break;
      case 'uncertain':
        this.env.intent = 'uncertain';
        this.env.note = '目标不明确，需要帮助';
        break;
      case 'reset':
        this.env = this.freshEnv('idle');
        this.env.note = '恢复待机';
        break;
      default:
        break;
    }
    this.onEnv({ ...this.env });
    return this.env;
  }

  /** 外部（如 Pi 智能体）直接修补感知状态 */
  patchEnv(patch: Partial<EnvState>): EnvState {
    Object.assign(this.env, patch);
    this.onEnv({ ...this.env });
    return this.env;
  }

  /** 一次决策步进 */
  async step(): Promise<DecisionPayload> {
    this.tick += 1;
    // 轻量环境自发漂移（能量消耗/随机扰动），模拟真实感知变化
    this.drift();
    const env = { ...this.env };

    // 从引擎取决策；失败（网络/Key 问题）用 idle 安全动作兜底，循环不中断
    let decision: RobotDecision;
    try {
      decision = await this.engine.decide(env);
    } catch (err) {
      decision = {
        motion: 'idle',
        expression: 'neutral',
        intensity: 0,
        lookAtUser: false,
        confidence: 0,
        probabilities: null,
        raw: null,
        engine: 'jev-fail',
        warning: err instanceof Error ? err.message : String(err),
      };
    }

    // ===== 置信度门控：不够自信就回退到安全动作 =====
    const gated = decision.confidence != null && decision.confidence < this.gate;
    let applied: RobotDecision = decision;
    if (gated) {
      applied = {
        ...decision,
        motion: 'idle',
        expression: decision.expression === 'surprised' ? 'neutral' : decision.expression,
        gated: true,
      };
    }

    const payload: DecisionPayload = {
      tick: this.tick,
      env,
      decision,
      applied,
      gated,
      engine: decision.engine ?? 'jev',
      ts: Date.now(),
    };
    if (gated) this.onGated(payload);
    this.onDecision(payload);
    // 行为回流：外层循环自身的决策也进入行为状态（内层/外层行为同一账本）
    this.noteAction(applied.motion, applied.expression, 'jev-loop');
    return payload;
  }

  private drift(): void {
    this.env.energy = Math.max(0.3, +(this.env.energy - 0.001).toFixed(3));
    // 社交驱动自然衰减（半衰期约 20s：每 3.2s 步 ×0.895）
    this.env.socialDrive = Math.max(0, +(this.env.socialDrive * 0.895).toFixed(3));
    // 用户距离缓慢回漂到默认远距（仅在无社交热度时，对话中保持"就在跟前"）
    if (this.env.socialDrive <= 0.05) {
      this.env.userProximity = Math.min(0.85, +(this.env.userProximity + 0.01).toFixed(2));
    }
    if (this.env.intent === 'idle' && Math.random() < 0.02) {
      this.env.userProximity = Math.max(0.15, +(this.env.userProximity - 0.05).toFixed(2));
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.step(); // 立即来一次
    this.timer = setInterval(() => this.step().catch(console.error), this.loopMs);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  setLoopMs(ms: number): void {
    this.loopMs = ms;
    if (this.running) {
      this.stop();
      this.start();
    }
  }

  dispose(): void {
    this.stop();
  }
}
