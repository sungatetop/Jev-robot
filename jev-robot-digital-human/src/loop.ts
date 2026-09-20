/**
 * 决策循环控制器：把 Jev 的“决策层”串进实时控制闭环。
 *
 *   while(running) {
 *     env = 读取感知状态(模拟环境)
 *     决策 = engine.decide(env)          // 本地规则 or 真实 Jev
 *     若 决策.confidence < gate → 回退到安全动作 idle（置信度门控）
 *     下推给执行器(avatar.setDecision)
 *     等待 LOOP_MS，重复
 *   }
 *
 * 这是“基于 Jev 的机器人控制”的可运行演示：Jev/本地引擎只负责做类型化
 * 决策，外围代码负责环境状态、置信度门控、执行与安全回退。
 */
import type { EnvState, RobotDecision, DecisionPayload, DecisionEngine } from './jev/types.js';

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
      ...extra,
    };
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

    // 从引擎取决策（真实 Jev 或本地规则），结构已归一化
    const decision = await this.engine.decide(env);

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
      engine: decision.engine ?? 'local',
      ts: Date.now(),
    };
    if (gated) this.onGated(payload);
    this.onDecision(payload);
    return payload;
  }

  private drift(): void {
    this.env.energy = Math.max(0.3, +(this.env.energy - 0.001).toFixed(3));
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
