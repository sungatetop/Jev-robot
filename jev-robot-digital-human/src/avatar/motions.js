/**
 * 运动系统：每个动作由一套关节目标姿态(pose)驱动。
 *
 * pose = { joints: { [jointId]: [rx, ry, rz] }, root: {x,y,z} }
 * 每帧由 HumanAvatar 将当前关节旋转向目标姿态做平滑插值，从而让
 * 不同动作之间自然衔接（决策切换不会“瞬移/跳变”）。
 */

export const JOINT_IDS = [
  'hips', 'chest', 'head',
  'legL', 'kneeL', 'legR', 'kneeR',
  'armL', 'elbowL', 'armR', 'elbowR',
];

const P = Math.PI;

// 便捷构造器
function pose(joints = {}, root = { x: 0, y: 0, z: 0 }) {
  const full = {};
  for (const id of JOINT_IDS) {
    full[id] = joints[id] || [0, 0, 0];
  }
  return { joints: full, root };
}

/** 待机：轻微呼吸起伏，双臂自然下垂 */
function idle(p, a) {
  const breathe = Math.sin(p) * 0.02;
  return pose(
    {
      chest: [-0.02 + breathe, 0, 0],
      arms: null, // 占位，会被下方替换
      armL: [-0.06, 0.08, 0.04 + Math.sin(p) * 0.01],
      armR: [-0.06, -0.08, -0.04 - Math.sin(p) * 0.01],
      elbowL: [0.12, 0, 0],
      elbowR: [0.12, 0, 0],
      head: [Math.sin(p * 0.5) * 0.03, Math.sin(p * 0.25) * 0.05, 0],
    },
    { x: 0, y: 0, z: 0 }
  );
}

/** 行走（原地踏步感）：腿/臂前后摆动 + 身体上下起伏 + 前倾 */
function walk(p, a) {
  const s = Math.sin(p);
  const arm = a * 0.55;
  return pose(
    {
      chest: [-0.1, 0, 0],
      legL: [s * a * 0.6, 0, 0],
      kneeL: [Math.max(0, -s) * a * 0.9, 0, 0],
      legR: [-s * a * 0.6, 0, 0],
      kneeR: [Math.max(0, s) * a * 0.9, 0, 0],
      armL: [s * arm, 0.05, 0.06],
      elbowL: [0.25, 0, 0],
      armR: [-s * arm, -0.05, -0.06],
      elbowR: [0.25, 0, 0],
      head: [0.02, Math.sin(p) * 0.04, 0],
    },
    { x: 0, y: Math.abs(Math.sin(p)) * a * 0.06, z: 0 }
  );
}

/** 挥手：右臂上抬并左右摆动多次 */
function wave(p, a) {
  const raise = -1.55; // 使右臂抬至近水平偏上
  const osc = Math.sin(p * 0.8) * 0.5;
  return pose(
    {
      chest: [-0.05, Math.sin(p * 0.2) * 0.04, 0],
      legL: [0.02, 0, 0],
      legR: [-0.02, 0, 0],
      armL: [-0.08, 0.1, 0.06],
      elbowL: [0.2, 0, 0],
      armR: [raise * 0.35, 0, raise + osc], // 上抬 + 摆动
      elbowR: [-0.1 + osc * 0.3, 0, 0],     // 前臂随之微摆
      head: [0.04, Math.sin(p * 0.25) * 0.08, 0],
    },
    { x: 0, y: Math.sin(p * 0.5) * 0.02, z: 0 }
  );
}

/** 舞动：髋部摆动 + 双臂轮流上抬 + 踩点 */
function dance(p, a) {
  const s = Math.sin(p);
  const c = Math.cos(p);
  return pose(
    {
      hips: [0, 0, s * 0.12 * a],
      chest: [-0.05, s * 0.1, -s * 0.05],
      legL: [c * a * 0.15, 0, s * a * 0.08],
      kneeL: [0.1 + c * a * 0.1, 0, 0],
      legR: [-c * a * 0.15, 0, -s * a * 0.08],
      kneeR: [0.1 - c * a * 0.1, 0, 0],
      armL: [-0.4 + s * a * 0.6, 0.1, 0.3 + c * a * 0.4],
      elbowL: [0.4, 0, 0],
      armR: [-0.4 + c * a * 0.6, -0.1, -0.3 - s * a * 0.4],
      elbowR: [0.4, 0, 0],
      head: [0.06, s * 0.2, c * 0.05],
    },
    { x: 0, y: Math.abs(s) * a * 0.04, z: 0 }
  );
}

/** 指向：右臂向前平伸，并轻微瞄准/颤动 */
function point(p, a) {
  const tremble = Math.sin(p * 6) * 0.02;
  return pose(
    {
      chest: [0.02, 0.06, 0],
      armL: [-0.1, 0.12, 0.08],
      elbowL: [0.3, 0, 0],
      armR: [-1.25 + tremble, 0.05, -0.1 - tremble], // 前伸
      elbowR: [0.05, 0, 0],
      head: [0.05, 0.12, 0],
    },
    { x: 0, y: 0, z: 0 }
  );
}

/** 耸肩：    双肩急促上提后回落 */
function shrug(p, a) {
  const u = Math.max(0, Math.sin(p));
  return pose(
    {
      chest: [0.03, 0, 0],
      armL: [-0.2 - u * 0.4, -0.15, 0.35 + u * 0.3],
      elbowL: [0.35, 0, 0],
      armR: [-0.2 - u * 0.4, 0.15, -0.35 - u * 0.3],
      elbowR: [0.35, 0, 0],
      head: [0.12 + u * 0.06, 0, 0],
    },
    { x: 0, y: -u * 0.02, z: 0 }
  );
}

/** 踏步（高抬腿行军）：类似行走但抬腿更高、摆臂更用力 */
function march(p, a) {
  const s = Math.sin(p);
  const thigh = a * 0.85;
  return pose(
    {
      chest: [-0.12, Math.sin(p * 0.5) * 0.05, 0],
      legL: [s * thigh, 0, 0],
      kneeL: [Math.max(0, -s) * a * 1.4, 0, 0],
      legR: [-s * thigh, 0, 0],
      kneeR: [Math.max(0, s) * a * 1.4, 0, 0],
      armL: [s * a * 0.7, 0.06, 0.08],
      elbowL: [0.4, 0, 0],
      armR: [-s * a * 0.7, -0.06, -0.08],
      elbowR: [0.4, 0, 0],
      head: [-0.02, Math.sin(p) * 0.03, 0],
    },
    { x: 0, y: Math.abs(Math.sin(p)) * a * 0.07, z: 0 }
  );
}

export const MOTION_DEFS = {
  idle: { fn: idle, speed: 1.4 },
  walk: { fn: walk, speed: 3.2 },
  wave: { fn: wave, speed: 2.6 },
  dance: { fn: dance, speed: 3.8 },
  point: { fn: point, speed: 6.0 },
  shrug: { fn: shrug, speed: 5.0 },
  march: { fn: march, speed: 6.4 },
};

/** 计算某个动作在时刻 t 的目标姿态 */
export function getMotionPose(motionName, t, intensity = 1) {
  const def = MOTION_DEFS[motionName] || MOTION_DEFS.idle;
  const checks = { idle: 0, walk: 0 }; // 占位，简化结构
  const amp = 0.6 + intensity * 0.4; // intensity 0..2 → 幅度
  const p = def.speed * t;
  return def.fn(p, amp);
}