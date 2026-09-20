/**
 * GltfAvatar —— 加载真实 GLB 人形模型，将决策 motion 映射到内置骨骼动画。
 *
 * 流程：
 *   GLTFLoader 加载 → AnimationMixer → 按 motion 名模糊匹配动画剪辑 →
 *   crossFadeTo 播放 → intensity 控制播放速率 → update(dt) 推进 mixer。
 *
 * 表情：若模型含 morph target 则按通道设置；否则仅靠肢体动画表达。
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

// 决策 motion 名 → 模型动画名的模糊映射（按优先级匹配）
const MOTION_CLIP_HINTS: Record<string, string[]> = {
  idle:    ['Idle', 'idle', 'Standing', 'standing', 'Tpose'],
  walk:    ['Walking', 'walk', 'Run', 'run'],
  wave:    ['Wave', 'wave', 'WaveHello'],
  dance:   ['Dance', 'dance', 'Samba', 'Jump', 'jump'],
  point:   ['Pointing', 'point', 'Punch', 'punch', 'Pose', 'pose'],
  shrug:   ['Shrug', 'shrug', 'No', 'no', 'ThumbsUp', 'thumbsup'],
  march:   ['March', 'march', 'Run', 'run', 'Walking'],
};

// 表情 morph target 名（若模型支持）
const EXPRESSION_MORPHS: Record<string, Record<string, number>> = {
  neutral:   {},
  happy:     { smile: 1, joy: 1 },
  sad:       { sad: 1, browDown: 0.5 },
  surprised: { surprised: 1, eyeWide: 1 },
  angry:     { angry: 1, browDown: 1 },
};

export interface GltfAvatarOptions {
  height?: number;
  showSkeleton?: boolean;
}

export interface DecisionInput {
  motion?: string;
  expression?: string;
  intensity?: number;
  lookAtUser?: boolean;
}

export class GltfAvatar extends THREE.Group {
  url: string;
  targetHeight: number;
  mixer: THREE.AnimationMixer | null = null;
  clips: THREE.AnimationClip[] = [];
  actions: Record<string, THREE.AnimationAction> = {};
  currentAction: THREE.AnimationAction | null = null;
  currentMotion = 'idle';
  intensity = 1;
  model: THREE.Group | null = null;
  skeletonHelper: THREE.SkeletonHelper | null = null;
  faceMeshes: THREE.Mesh[] = []; // 含 morphTarget 的网格
  ready = false;

  private _loadPromise: Promise<GltfAvatar> | null = null;
  private _showSkeleton: boolean;

  constructor(url: string, { height = 1.8, showSkeleton = false }: GltfAvatarOptions = {}) {
    super();
    this.url = url;
    this.targetHeight = height;
    this._showSkeleton = showSkeleton;
    void this._load();
  }

  private _load(): Promise<GltfAvatar> {
    if (this._loadPromise) return this._loadPromise;
    this._loadPromise = this._doLoad();
    return this._loadPromise;
  }

  private async _doLoad(): Promise<GltfAvatar> {
    const loader = new GLTFLoader();
    const gltf = await loader.loadAsync(this.url);

    this.model = gltf.scene;

    // 归一化尺寸：GLB 各模型原生单位差异巨大（RobotExpressive≈4.8，Xbot≈1.8），
    // 按包围盒统一缩放到目标身高，并把脚底对齐地面 y=0
    const box = new THREE.Box3().setFromObject(this.model);
    const size = new THREE.Vector3();
    box.getSize(size);
    if (size.y > 1e-4) {
      const s = this.targetHeight / size.y;
      this.model.scale.setScalar(s);
      this.model.position.y = -box.min.y * s;
    }
    this.model.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if ((mesh as unknown as { isMesh?: boolean }).isMesh) {
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        if (mesh.morphTargetInfluences) this.faceMeshes.push(mesh);
      }
    });
    this.add(this.model);

    // 动画
    this.clips = gltf.animations || [];
    this.mixer = new THREE.AnimationMixer(this.model);
    for (const clip of this.clips) {
      this.actions[clip.name] = this.mixer.clipAction(clip);
    }

    // 骨骼可视化
    this.skeletonHelper = new THREE.SkeletonHelper(this.model);
    this.skeletonHelper.visible = this._showSkeleton;
    this.add(this.skeletonHelper);

    // 默认播 idle
    this.playMotion('idle');
    this.ready = true;
    console.log('[GltfAvatar] loaded:', this.url,
      '| animations:', this.clips.map((c) => c.name).join(', ') || '(none)');
    return this;
  }

  /** 按 motion 名匹配一个动画剪辑名 */
  private _findClip(motion: string): string | undefined {
    const hints = MOTION_CLIP_HINTS[motion] || [];
    for (const hint of hints) {
      const found = this.clips.find((c) => c.name.toLowerCase().includes(hint.toLowerCase()));
      if (found) return found.name;
    }
    // 兜底：第一个动画
    return this.clips[0]?.name;
  }

  /** 平滑切换到目标动作（crossfade） */
  playMotion(motion: string): void {
    if (!this.ready || !this.mixer) return;
    if (motion === this.currentMotion && this.currentAction) return;

    const clipName = this._findClip(motion);
    if (!clipName) return;

    const next = this.actions[clipName];
    if (!next) return;

    const prev = this.currentAction;
    next.reset().play();
    if (prev && prev !== next) {
      next.crossFadeFrom(prev, 0.35, false);
    }
    this.currentAction = next;
    this.currentMotion = motion;
  }

  /** 外部决策入口 */
  setDecision({ motion = 'idle', expression = 'neutral', intensity = 1 }: DecisionInput): void {
    if (motion) this.playMotion(motion);
    this.intensity = Math.max(0.1, intensity);
    if (this.currentAction) this.currentAction.timeScale = 0.6 + this.intensity * 0.5;
    this._applyExpression(expression);
  }

  private _applyExpression(name: string): void {
    const morphs = EXPRESSION_MORPHS[name] || {};
    for (const mesh of this.faceMeshes) {
      const dict = mesh.morphTargetDictionary || {};
      const inf = mesh.morphTargetInfluences;
      if (!inf) continue;
      // 先归零
      for (let i = 0; i < inf.length; i++) inf[i] = 0;
      for (const [morphName, val] of Object.entries(morphs)) {
        const idx = dict[morphName];
        if (idx != null) inf[idx] = val;
      }
    }
  }

  showSkeleton(v: boolean): void {
    if (this.skeletonHelper) this.skeletonHelper.visible = !!v;
  }

  resetToBindPose(): void {
    if (this.currentAction) {
      this.currentAction.stop();
      this.currentAction = null;
    }
    this.currentMotion = '';
    this.playMotion('idle');
  }

  update(dt: number): void {
    if (this.mixer) this.mixer.update(dt);
  }

  whenReady(): Promise<GltfAvatar> {
    return this._loadPromise || Promise.resolve(this);
  }

  dispose(): void {
    if (this.mixer) {
      this.mixer.stopAllAction();
      if (this.model) this.mixer.uncacheRoot(this.model);
    }
    this.skeletonHelper?.dispose();
    this.model?.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if ((mesh as unknown as { isMesh?: boolean }).isMesh) {
        mesh.geometry?.dispose();
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        mats.forEach((m) => m?.dispose());
      }
    });
  }
}
