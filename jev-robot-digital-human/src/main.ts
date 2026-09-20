/**
 * 入口：装配场景(3D) + 数字人 + Jev 决策循环 + 控制面板 + Pi 对话界面。
 *
 * WebGL 可用 → 3D 数字人（Three.js）
 * WebGL 不可用 → 2D 兜底视图（同样响应运动+表情），保证控制演示在任何环境可运行。
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GltfAvatar } from './avatar/gltf-avatar.js';
import type { DecisionInput } from './avatar/gltf-avatar.js';
import { createEngine } from './jev/decision-engine.js';
import { Simulation } from './loop.js';
import { Panel } from './ui/panel.js';
import { ChatPanel } from './ui/chat.js';
import type { AgentCommand, RobotDecision } from './jev/types.js';

const stageEl = document.getElementById('stage')!;
const panel = new Panel();

const EMOJI: Record<string, string> = {
  neutral: '🙂',
  happy: '😄',
  sad: '😢',
  surprised: '😲',
  angry: '😠',
};

/* ---------- 装配决策循环（与渲染无关） ---------- */
let currentEngine = createEngine('auto');

const applyProxy = { current: (_decision: RobotDecision) => {} };
const avatarRef = { current: null as GltfAvatar | null };

const sim = new Simulation({
  engine: currentEngine,
  onDecision: (payload) => {
    panel.setDecision(payload);
    panel.setEngineStatus({
      engine: payload.engine,
      warning: payload.decision.warning,
    });
  },
  onEnv: (env) => panel.setEnv(env),
  onGated: (payload) => {
    console.warn('[gated] confidence', payload.decision.confidence, '< gate, fell back to idle');
  },
  // P3 idle 整理：Jev 决策 consolidate → 服务端提炼长期记忆 → 感知状态更新 + 对话面板展示
  onConsolidate: runConsolidation,
  loopMs: 3200,
  gate: 0.45,
});

/** 记忆整理执行器：POST /api/agent/consolidate，成功后更新感知状态并在对话面板展示 */
async function runConsolidation(): Promise<string | null> {
  try {
    const res = await fetch('/api/agent/consolidate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}', // 整理过程由 Agent 经记忆工具自主完成，无需参数
    });
    if (!res.ok) return null;
    // 摘要是 Agent 自己说的话；整理中顺带下发的身体指令（如思考姿态）就地应用
    const data = (await res.json()) as { summary?: string; commands?: AgentCommand[] };
    for (const cmd of data.commands ?? []) applyAgentCommand(cmd);
    const summary = data.summary?.trim() || '这次没有要补记的内容';
    sim.markConsolidated(summary);
    chat.appendNote(`💭 ${summary}`);
    return summary;
  } catch (err) {
    console.warn('[consolidate] 整理失败:', err instanceof Error ? err.message : err);
    return null;
  }
}

panel.bind();
panel.cbApply = (decision) => applyProxy.current(decision);
panel.cbOnToggle = () => {
  if (sim.running) { sim.stop(); panel.setLoopRunning(false); }
  else { sim.start(); panel.setLoopRunning(true); }
};
panel.cbOnLoopMs = (ms) => sim.setLoopMs(ms);
panel.cbOnGate = (v) => { sim.gate = v; };
panel.cbOnSkeleton = (v) => { skeletonVisible = v; avatarRef.current?.showSkeleton(v); };
panel.cbOnResetPose = () => avatarRef.current?.resetToBindPose();
panel.cbOnAvatarMode = (mode) => void setAvatarMode(mode);

/* ---------- Pi 慢思考智能体（System Two）对话接线 ---------- */

const chat = new ChatPanel({
  getEnv: () => ({ ...sim.env }),
  getLastDecision: () => panel.lastDecision,
  applyCommand: applyAgentCommand,
  // 用户消息先经 Jev 决策：选中「回复」→ 唤醒 Pi 慢思考；选中身体动作 → 快反射直接执行
  decideMessage: (env, message) => sim.engine.decideMessage(env, message),
  // 感知入环：对话刺激（用户发言/智能体行为）写入感知循环，影响后续自主决策
  perceive: (evt) => sim.perceive(evt),
  // P3 整理记忆：消息路由选中 consolidate → 复用外层循环的整理执行链（防重入+防抖）
  consolidate: () => sim.handleConsolidate(),
});
chat.bind();

/** 应用 Pi 智能体的机器人控制指令 */
function applyAgentCommand(cmd: AgentCommand): void {
  switch (cmd.type) {
    case 'set_intent':
      sim.patchEnv({
        intent: cmd.intent,
        note: cmd.note || `Pi 设置意图: ${cmd.intent}`,
        event: null,
      });
      console.info('[pi-agent] set_intent:', cmd.intent);
      break;
    case 'trigger_event':
      sim.triggerEvent(cmd.name);
      console.info('[pi-agent] trigger_event:', cmd.name);
      break;
    case 'command': {
      // 「回复」是说话动作，不是身体动作：由对话气泡本身呈现，不下发动画
      if (cmd.motion === 'reply') break;
      // 直接指令：合成一条决策，走统一应用/可视化路径（来源：Pi 智能体 或 Jev 消息路由）
      const d: RobotDecision = {
        motion: cmd.motion,
        expression: cmd.expression ?? 'neutral',
        intensity: cmd.intensity ?? 1,
        lookAtUser: cmd.lookAtUser ?? false,
        confidence: null,
        probabilities: null,
        raw: cmd,
        engine: cmd.engine ?? 'pi-agent',
      };
      panel.setDecision({
        tick: 0,
        env: { ...sim.env },
        decision: d,
        applied: d,
        gated: false,
        engine: d.engine ?? 'pi-agent',
        ts: Date.now(),
      });
      // 感知入环：指令执行回流感知循环（行为状态 + 摘要，下次自主决策知道"我刚做过什么"）
      const source = d.engine === 'jev' ? 'jev-route' : 'pi';
      sim.perceive({ type: 'agent_action', motion: cmd.motion, expression: d.expression, by: source, ts: Date.now() });
      console.info('[pi-agent] command:', cmd.motion);
      break;
    }
  }
}

/* ---------- 数字人模式切换 ---------- */
const AVATAR_CONFIG: Record<string, { label: string; url: string; height: number }> = {
  robot: { label: '真实模型 · RobotExpressive (GLB)', url: '/models/RobotExpressive.glb', height: 1.8 },
  xbot:  { label: '真实模型 · Xbot (GLB)', url: '/models/Xbot.glb', height: 1.8 },
};

let scene3D: THREE.Scene | null = null;
let camera3D: THREE.PerspectiveCamera | null = null;
let skeletonVisible = false;

function setAvatarInfo(text: string): void {
  const el = document.getElementById('avatar-info');
  if (el) el.textContent = text;
}

/** 创建指定模式的数字人（GLTF 为异步加载） */
function createAvatar(mode: string): GltfAvatar {
  const cfg = AVATAR_CONFIG[mode] || AVATAR_CONFIG.robot;
  return new GltfAvatar(cfg.url, { height: cfg.height, showSkeleton: skeletonVisible });
}

/** 切换数字人模式：销毁旧实例，创建新实例并接入场景 */
async function setAvatarMode(mode: string): Promise<void> {
  // 销毁旧 avatar
  const old = avatarRef.current;
  if (old) {
    if (old.parent) old.parent.remove(old);
    try { old.dispose(); } catch { /* ignore */ }
    avatarRef.current = null;
  }
  setAvatarInfo(mode + ' · 加载中…');
  document.querySelectorAll<HTMLElement>('[data-avatar]').forEach((b) =>
    b.classList.toggle('active', b.dataset.avatar === mode)
  );

  const avatar = createAvatar(mode);
  scene3D?.add(avatar);
  avatarRef.current = avatar;

  // GLTF 模型异步加载，等就绪
  try {
    await avatar.whenReady();
  } catch (e) {
    console.error('[avatar] load failed:', e);
    setAvatarInfo(mode + ' · 加载失败: ' + (e instanceof Error ? e.message : String(e)));
    return;
  }
  setAvatarInfo(AVATAR_CONFIG[mode]?.label || mode);
  // 立即应用当前状态
  applyProxy.current({ motion: 'idle', expression: 'neutral', intensity: 1, lookAtUser: false, confidence: null, probabilities: null, raw: null });
}

/* ---------- 3D 渲染路径 ---------- */
interface RendererHandle {
  start: () => void;
  apply?: (decision: RobotDecision) => void;
}

function init3D(): RendererHandle {
  scene3D = new THREE.Scene();
  scene3D.fog = new THREE.Fog(0x0b0f17, 12, 26);

  camera3D = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera3D.position.set(2.6, 1.7, 4.2);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  stageEl.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera3D, renderer.domElement);
  controls.target.set(0, 1.05, 0);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI / 2.05;
  controls.minDistance = 1.6;
  controls.maxDistance = 8;

  scene3D.add(new THREE.HemisphereLight(0xdfe7ff, 0x0e1522, 1.0));
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(3, 6, 4);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.left = -3; key.shadow.camera.right = 3;
  key.shadow.camera.top = 4; key.shadow.camera.bottom = -1;
  scene3D.add(key);
  const rim = new THREE.DirectionalLight(0x8f7bff, 0.5);
  rim.position.set(-4, 2, -3);
  scene3D.add(rim);

  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(10, 48),
    new THREE.MeshStandardMaterial({ color: 0x1c2638, roughness: 0.9, metalness: 0.05 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene3D.add(ground);

  const grid = new THREE.GridHelper(10, 20, 0x2a3b54, 0x1a2437);
  grid.position.y = 0.01;
  scene3D.add(grid);

  // 默认真实模型数字人
  void setAvatarMode('robot');

  const clock = new THREE.Clock();
  function resize(): void {
    if (!camera3D) return;
    const w = stageEl.clientWidth, h = stageEl.clientHeight;
    camera3D.aspect = w / h;
    camera3D.updateProjectionMatrix();
    renderer.setSize(w, h);
  }
  window.addEventListener('resize', resize);
  resize();

  const start = () =>
    renderer.setAnimationLoop(() => {
      const dt = Math.min(clock.getDelta(), 0.05);
      controls.update();
      const av = avatarRef.current;
      if (av) av.update(dt);
      renderer.render(scene3D!, camera3D!);
    });

  return { start };
}

/* ---------- 2D 兜底路径 ---------- */
function initFallback(): RendererHandle {
  stageEl.innerHTML = `
    <div class="fb-wrap">
      <div class="fb-note">⚠️ 当前环境不支持 WebGL，已切换 2D 兜底视图（决策控制演示不受影响）</div>
      <div class="fb-avatar" data-motion="idle">
        <div class="fb-face" id="fb-face">🙂</div>
        <div class="fb-body"><span class="fb-motion" id="fb-motion">IDLE</span></div>
      </div>
    </div>`;
  const face = stageEl.querySelector('#fb-face')!;
  const motion = stageEl.querySelector('#fb-motion')!;
  const avatar = stageEl.querySelector('.fb-avatar') as HTMLElement;

  const apply = (decision: RobotDecision): void => {
    face.textContent = EMOJI[decision.expression] || '🙂';
    motion.textContent = (decision.motion || 'idle').toUpperCase();
    avatar.dataset.motion = decision.motion || 'idle';
    avatar.style.animationDuration = `${Math.max(0.6, 1.6 - decision.intensity * 0.4)}s`;
  };

  const start = () => {}; // CSS 动画驱动
  return { start, apply };
}

/* ---------- WebGL 检测 + 装配 ---------- */
function webglAvailable(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!(window.WebGLRenderingContext &&
      (c.getContext('webgl2') || c.getContext('webgl') || c.getContext('experimental-webgl')));
  } catch {
    return false;
  }
}

let renderer: RendererHandle;
if (webglAvailable()) {
  try {
    renderer = init3D();
    renderer.start();
  } catch (e) {
    console.warn('3D init failed, fall back to 2D:', e);
    renderer = initFallback();
    renderer.start();
  }
} else {
  renderer = initFallback();
  renderer.start();
}

applyProxy.current = (decision: RobotDecision) => {
  const av = avatarRef.current;
  const input: DecisionInput = {
    motion: decision.motion,
    expression: decision.expression,
    intensity: decision.intensity,
    lookAtUser: decision.lookAtUser,
  };
  if (av) {
    av.setDecision(input);
  } else if (renderer.apply) {
    // 2D 兜底
    renderer.apply(decision);
  }
};

// 初始展示
panel.setEnv(sim.env);
panel.setLoopRunning(false);
applyProxy.current({ motion: 'idle', expression: 'neutral', intensity: 1, lookAtUser: false, confidence: null, probabilities: null, raw: null });
