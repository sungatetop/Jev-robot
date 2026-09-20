/**
 * 控制面板 UI：参数设置弹窗（引擎选择/滑块/数字人/骨骼）、
 * 决策可视化(概率条/置信度)、紧凑状态总览。纯 DOM，不依赖框架。
 */
import { MOTION_LABEL, EXPRESSION_LABEL } from '../jev/semantics.js';
import type { RobotDecision, EnvState, DecisionPayload } from '../jev/types.js';

const $ = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el;
};

export class Panel {
  lastDecision: DecisionPayload | null = null;
  history: DecisionPayload[] = [];

  cbApply?: (decision: RobotDecision) => void;
  cbOnToggle?: () => void;
  cbOnLoopMs?: (ms: number) => void;
  cbOnGate?: (v: number) => void;
  cbOnSkeleton?: (v: boolean) => void;
  cbOnResetPose?: () => void;
  cbOnAvatarMode?: (mode: string) => void;

  bind(): void {
    // 循环开关
    $('btn-toggle').addEventListener('click', () => this._onToggle());
    // 参数设置弹窗
    $('btn-settings').addEventListener('click', () => this._openSettings(true));
    $('settings-close').addEventListener('click', () => this._openSettings(false));
    $('settings-modal').addEventListener('click', (e) => {
      if (e.target === $('settings-modal')) this._openSettings(false);
    });
    // 滑块
    $('loop-ms').addEventListener('input', (e) => {
      const v = (e.target as HTMLInputElement).value;
      $('loop-ms-val').textContent = v + ' ms';
      this._onLoopMs(+v);
    });
    $('gate').addEventListener('input', (e) => {
      const v = (e.target as HTMLInputElement).value;
      $('gate-val').textContent = (+v / 100).toFixed(2);
      this._onGate(+v / 100);
    });
    // 骨骼可视化 + 重置姿态
    $('skeleton-toggle').addEventListener('change', (e) =>
      this._onSkeleton((e.target as HTMLInputElement).checked));
    $('btn-reset-pose').addEventListener('click', () => this._onResetPose());
    // 数字人类型切换
    document.querySelectorAll<HTMLButtonElement>('[data-avatar]').forEach((b) =>
      b.addEventListener('click', () => this._onAvatarMode(b.dataset.avatar!))
    );
  }

  private _openSettings(open: boolean): void {
    ($('settings-modal') as HTMLElement).hidden = !open;
  }

  private _onToggle(): void { this.cbOnToggle?.(); }
  private _onLoopMs(ms: number): void { this.cbOnLoopMs?.(ms); }
  private _onGate(v: number): void { this.cbOnGate?.(v); }
  private _onSkeleton(checked: boolean): void { this.cbOnSkeleton?.(checked); }
  private _onResetPose(): void { this.cbOnResetPose?.(); }
  private _onAvatarMode(mode: string): void { this.cbOnAvatarMode?.(mode); }

  /* -------- 对外更新接口 -------- */

  setEngineStatus({ engine, warning }: { engine: string; warning?: string | null; error?: string }): void {
    const el = $('engine-status');
    el.textContent = engine === 'jev' ? '● 真实 Jev' : '● Jev 离线';
    el.className = engine === 'jev' ? 'badge ok' : 'badge warn';
    $('engine-warn').textContent = warning ? '离线原因: ' + warning : '';
  }

  setLoopRunning(running: boolean): void {
    $('btn-toggle').textContent = running ? '⏸ 暂停循环' : '▶ 启动循环';
    $('btn-toggle').classList.toggle('on', running);
  }

  setEnv(env: EnvState): void {
    $('state-json').textContent = JSON.stringify(env, null, 2);
    // 紧凑总览：意图 / 距离 / 能量 / 障碍
    $('env-intent').textContent = MOTION_LABEL[env.intent] || env.intent;
    ($('env-prox-bar') as HTMLElement).style.width =
      `${Math.max(0, Math.min(100, (1 - env.userProximity) * 100))}%`;
    ($('env-energy-bar') as HTMLElement).style.width =
      `${Math.max(0, Math.min(100, env.energy * 100))}%`;
    const ob = $('env-obstacle');
    ob.textContent = env.obstacleAhead ? '有' : '无';
    ob.classList.toggle('danger', env.obstacleAhead);
  }

  setDecision(payload: DecisionPayload): void {
    this.lastDecision = payload;
    const a = payload.applied, d = payload.decision;

    $('motion-badge').textContent = MOTION_LABEL[a.motion] || a.motion;
    $('motion-badge').className = 'pill motion' + (a.gated ? ' gated' : '');
    $('expr-badge').textContent = EXPRESSION_LABEL[a.expression] || a.expression;
    $('expr-badge').className = 'pill expr';
    ($('intensity-bar') as HTMLElement).style.width =
      `${Math.max(0, Math.min(100, (a.intensity / 2) * 100))}%`;

    $('engine-emitter').textContent =
      payload.engine === 'jev' ? '真实 Jev' : payload.engine === 'pi-agent' ? 'Pi 智能体' : 'Jev 离线';
    $('confidence-num').textContent =
      d.confidence != null ? `置信 ${(d.confidence * 100).toFixed(0)}%` : '置信 --';
    const gate = $('conf-gate-num');
    gate.textContent = a.gated ? '已门控→IDLE' : '通过';
    gate.className = 'ds-chip gate ' + (a.gated ? 'blocked' : 'pass');

    ($('look-bar') as HTMLElement).style.width =
      `${Math.max(0, Math.min(100, (a.lookAtUser ? 1 : 0.2) * 100))}%`;

    this._renderProbabilities(d);
    this._pushHistory(payload);

    // 应用给三维数字人由外部回调(cbApply)完成
    this.cbApply?.(payload.applied);
  }

  private _renderProbabilities(decision: RobotDecision): void {
    const box = $('prob-bars');
    const probs = decision.probabilities || {};
    box.innerHTML = '';
    for (const [k, v] of Object.entries(probs).sort((a, b) => b[1] - a[1])) {
      const row = document.createElement('div');
      row.className = 'prow';
      row.innerHTML = `
        <span class="pkey">${MOTION_LABEL[k] || k}</span>
        <span class="ptrack"><i style="width:${(v * 100).toFixed(0)}%"></i></span>
        <span class="pval">${(v * 100).toFixed(0)}%</span>`;
      box.appendChild(row);
    }
  }

  private _pushHistory(payload: DecisionPayload): void {
    this.history.unshift(payload);
    if (this.history.length > 8) this.history.pop();
    const ul = $('history-list');
    ul.innerHTML = '';
    for (const h of this.history) {
      const li = document.createElement('li');
      const t = new Date(h.ts).toLocaleTimeString();
      const g = h.gated ? ' · 门控→IDLE' : '';
      li.textContent = `${t}  ${(MOTION_LABEL[h.applied.motion] || h.applied.motion).split(' ')[0]} / ${(EXPRESSION_LABEL[h.applied.expression] || h.applied.expression).split(' ')[0]}${g}`;
      ul.appendChild(li);
    }
  }
}
