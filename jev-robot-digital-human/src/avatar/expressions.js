/**
 * 面部表情系统（基于“表情通道 + 平滑插值”）。
 *
 * 每个通道是一个 0..1 或 -1..1 的标量，由表达式预设给出目标值，
 * 每帧以指数平滑逼近目标。通道再被 HumanAvatar 用来实时重建
 * 嘴部曲面、控制眉眼与眼睑，从而形成连续可读的表情（blend-shape 风格）。
 */

export const CHANNELS = [
  'browRaise',   // 眉毛整体抬升 (-0.5 .. 1)
  'browInnerUp', // 眉头上挑 (0..1)
  'eyeOpen',     // 眼睛开度 (0..1)
  'eyeSqueeze',  // 眯眼程度 (0..1)
  'mouthCurve',  // 嘴角弯曲 (-1 哭 .. +1 笑)
  'mouthWidth',  // 嘴部宽度 (0..1)
  'mouthOpen',   // 张嘴幅度 (0..1)
  'cheek',       // 脸颊鼓起/上提 (0..1)
];

export const EXPRESSION_PRESETS = {
  neutral: {
    browRaise: 0.0, browInnerUp: 0.0, eyeOpen: 0.9, eyeSqueeze: 0.0,
    mouthCurve: 0.0, mouthWidth: 0.15, mouthOpen: 0.05, cheek: 0.0,
  },
  happy: {
    browRaise: 0.2, browInnerUp: 0.1, eyeOpen: 0.55, eyeSqueeze: 0.3,
    mouthCurve: 1.0, mouthWidth: 0.8, mouthOpen: 0.22, cheek: 0.6,
  },
  sad: {
    browRaise: -0.25, browInnerUp: 0.7, eyeOpen: 0.6, eyeSqueeze: 0.1,
    mouthCurve: -0.9, mouthWidth: 0.1, mouthOpen: 0.08, cheek: 0.15,
  },
  surprised: {
    browRaise: 1.0, browInnerUp: 0.3, eyeOpen: 1.0, eyeSqueeze: 0.0,
    mouthCurve: 0.0, mouthWidth: 0.35, mouthOpen: 0.85, cheek: 0.05,
  },
  angry: {
    browRaise: -0.4, browInnerUp: -0.9, eyeOpen: 0.75, eyeSqueeze: 0.5,
    mouthCurve: -0.25, mouthWidth: 0.28, mouthOpen: 0.14, cheek: 0.1,
  },
};

export class ExpressionController {
  constructor() {
    this.current = { ...EXPRESSION_PRESETS.neutral };
    this.target = { ...EXPRESSION_PRESETS.neutral };
    this.blend = 0.999; // 平滑系数（接近 1 越平滑）
  }

  /** 切换到某个表情预设 */
  setExpression(name) {
    if (!EXPRESSION_PRESETS[name]) return;
    this.target = { ...EXPRESSION_PRESETS[name] };
  }

  /** 每帧更新通道，返回当前通道快照 */
  update(dt) {
    const k = 1 - Math.exp(-dt * 22); // 时间归一平滑
    for (const c of CHANNELS) {
      this.current[c] += (this.target[c] - this.current[c]) * k;
    }
    return this.current;
  }
}