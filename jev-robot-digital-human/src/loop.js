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

export class Simulation {
  constructor({ engine, onDecision, onEnv, onGated, loopMs = 3200, gate = 0.45 }) {
    this.engine = engine;
    this.loopMs = loopMs;
    this.gate = gate;          // 置信度门控阈值
    this.onDecision = onDecision || (() => {});
    this.onEnv = onEnv || (() => {});
    this.onGated = onGated || (() => {});
    this.running = false;
    this.timer = null;
    this.tick = 0;

    this.env = this._freshEnv('idle');
  }

  _freshEnv(intent, extra = {}) {
    return {
      intent,
      userProximity: 0.85,     // 0 近 .. 1 远
      obstacleAhead: false,
      energy: 1.0,
      objectsDetected: [],
      event: null,
      note: '',
      ...extra,
    };
  }

  /** 由 UI 触发场景事件，改变感知状态 */
  triggerEvent(name) {
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
        this.env = this._freshEnv('idle');
        this.env.note = '恢复待机';
        break;
      default:
        break;
    }
    this.onEnv({ ...this.env });
    return this.env;
  }

  /** 一次决策步进 */
  async step() {
    this.tick += 1;
    // 轻量环境自发漂移（能量消耗/随机扰动），模拟真实感知变化
    this._drift();
    const env = { ...this.env };

    // 从引擎取决策（真实 Jev 或本地规则），结构已归一化
    const decision = await this.engine.decide(env);

    // ===== 置信度门控：不够自信就回退到安全动作 =====
    const gated = decision.confidence != null && decision.confidence < this.gate;
    let applied = decision;
    if (gated) {
      applied = {
        ...decision,
        motion: 'idle',
        expression: decision.expression === 'surprised' ? 'neutral' : decision.expression,
        gated: true,
      };
    }

    const payload = {
      tick: this.tick,
      env,
      decision,
      applied,
      gated,
      engine: decision.engine,
      ts: Date.now(),
    };
    if (gated) this.onGated(payload);
    this.onDecision(payload);
    return payload;
  }

  _drift() {
    this.env.energy = Math.max(0.3, +(this.env.energy - 0.001).toFixed(3));
    if (this.env.intent === 'idle' && Math.random() < 0.02) {
      this.env.userProximity = Math.max(0.15, +(this.env.userProximity - 0.05).toFixed(2));
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.step(); // 立即来一次
    this.timer = setInterval(() => this.step().catch(console.error), this.loopMs);
  }

  stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  setLoopMs(ms) {
    this.loopMs = ms;
    if (this.running) {
      this.stop();
      this.start();
    }
  }

  dispose() {
    this.stop();
  }
}