/**
 * 控制面板 UI：引擎选择、场景事件、决策可视化(概率条/置信度)、
 * 状态/历史输出。纯 DOM，不依赖框架。
 */
import { MOTION_LABEL, EXPRESSION_LABEL } from '../jev/semantics.js';

const $ = (id) => document.getElementById(id);

export class Panel {
  constructor() {
    this.lastDecision = null;
    this.history = [];
  }

  bind() {
    // 引擎选择（HTML 用 data-engine 属性，无独立 id）
    document.querySelectorAll('[data-engine]').forEach((b) =>
      b.addEventListener('click', () => this._onEngine(b.dataset.engine))
    );
    // 循环开关
    $('btn-toggle').addEventListener('click', () => this._onToggle());
    // 场景事件
    document.querySelectorAll('[data-event]').forEach((b) =>
      b.addEventListener('click', () => this._onEvent(b.dataset.event))
    );
    // 滑块
    $('loop-ms').addEventListener('input', (e) => {
      $('loop-ms-val').textContent = e.target.value + ' ms';
      this._onLoopMs(+e.target.value);
    });
    $('gate').addEventListener('input', (e) => {
      $('gate-val').textContent = (e.target.value / 100).toFixed(2);
      this._onGate(+e.target.value / 100);
    });
    // 骨骼可视化 + 重置姿态
    $('skeleton-toggle').addEventListener('change', (e) => this._onSkeleton(e.target.checked));
    $('btn-reset-pose').addEventListener('click', () => this._onResetPose());
    // 数字人类型切换
    document.querySelectorAll('[data-avatar]').forEach((b) =>
      b.addEventListener('click', () => this._onAvatarMode(b.dataset.avatar))
    );
  }

  _onEngine(mode) {
    document.querySelectorAll('[data-engine]').forEach((b) =>
      b.classList.toggle('active', b.dataset.engine === mode)
    );
    this.cbOnEngine(mode);
  }

  _onToggle() {
    this.cbOnToggle();
  }

  _onEvent(name) {
    this.cbOnEvent(name);
  }

  _onLoopMs(ms) {
    this.cbOnLoopMs(ms);
  }

  _onGate(v) {
    this.cbOnGate(v);
  }

  _onSkeleton(checked) {
    if (this.cbOnSkeleton) this.cbOnSkeleton(checked);
  }

  _onResetPose() {
    if (this.cbOnResetPose) this.cbOnResetPose();
  }

  _onAvatarMode(mode) {
    if (this.cbOnAvatarMode) this.cbOnAvatarMode(mode);
  }

  /* -------- 对外更新接口 -------- */

  setEngineStatus({ engine, warning, error }) {
    const el = $('engine-status');
    el.textContent = engine === 'jev' ? '● 真实 Jev' : engine === 'local' ? '● 本地引擎(回退)' : '● 本地引擎';
    el.className = engine === 'jev' ? 'badge ok' : 'badge warn';
    if (warning) $('engine-warn').textContent = '回退原因: ' + warning;
    else $('engine-warn').textContent = '';
  }

  setLoopRunning(running) {
    $('btn-toggle').textContent = running ? '⏸ 暂停循环' : '▶ 启动循环';
    $('btn-toggle').classList.toggle('on', running);
  }

  setEnv(env) {
    $('state-json').textContent = JSON.stringify(env, null, 2);
  }

  setDecision(payload) {
    this.lastDecision = payload;
    const a = payload.applied, d = payload.decision;

    $('motion-badge').textContent = MOTION_LABEL[a.motion] || a.motion;
    $('motion-badge').className = 'pill motion' + (a.gated ? ' gated' : '');
    $('expr-badge').textContent = EXPRESSION_LABEL[a.expression] || a.expression;
    $('expr-badge').className = 'pill expr';
    $('intensity-bar').style.width = `${Math.max(0, Math.min(100, (a.intensity / 2) * 100))}%`;

    $('engine-emitter').textContent = payload.engine === 'jev' ? '真实 Jev' : '本地引擎';
    $('confidence-num').textContent =
      d.confidence != null ? (d.confidence * 100).toFixed(0) + '%' : '--';
    $('conf-gate-num').textContent = (a.gated ? '已门控→IDLE' : '通过');

    $('look-bar').style.width = `${Math.max(0, Math.min(100, (1 - a.lookAtUser ? 1 : a.lookAtUser) * 50))}%`;

    this._renderProbabilities(d);
    this._pushHistory(payload);

    // 应用给三维数字人由外部回调(applyToAvatar)完成
    if (this.cbApply) this.cbApply(payload.applied);
  }

  _renderProbabilities(decision) {
    const box = $('prob-bars');
    const probs = decision.probabilities || {};
    box.innerHTML = '';
    const n = Object.keys(probs).length || 1;
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

  _pushHistory(payload) {
    this.history.unshift(payload);
    if (this.history.length > 8) this.history.pop();
    const ul = $('history-list');
    ul.innerHTML = '';
    for (const h of this.history) {
      const li = document.createElement('li');
      const t = new Date(h.ts).toLocaleTimeString();
      const g = h.gated ? ' · 门控→IDLE' : '';
      li.textContent = `${t}  ${MOTION_LABEL[h.applied.motion].split(' ')[0]} / ${EXPRESSION_LABEL[h.applied.expression].split(' ')[0]}${g}`;
      ul.appendChild(li);
    }
  }
}