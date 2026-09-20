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
const MOTION_CLIP_HINTS = {
  idle:    ['Idle', 'idle', 'Standing', 'standing', 'Tpose'],
  walk:    ['Walking', 'walk', 'Run', 'run'],
  wave:    ['Wave', 'wave', 'WaveHello'],
  dance:   ['Dance', 'dance', 'Samba', 'Jump', 'jump'],
  point:   ['Pointing', 'point', 'Punch', 'punch', 'Pose', 'pose'],
  shrug:   ['Shrug', 'shrug', 'No', 'no', 'ThumbsUp', 'thumbsup'],
  march:   ['March', 'march', 'Run', 'run', 'Walking'],
};

// 表情 morph target 名（若模型支持）
const EXPRESSION_MORPHS = {
  neutral:   {},
  happy:     { smile: 1, joy: 1 },
  sad:       { sad: 1, browDown: 0.5 },
  surprised: { surprised: 1, eyeWide: 1 },
  angry:     { angry: 1, browDown: 1 },
};

export class GltfAvatar extends THREE.Group {
  constructor(url, { scale = 1, showSkeleton = false } = {}) {
    super();
    this.url = url;
    this.scaleFactor = scale;
    this.mixer = null;
    this.clips = [];          // AnimationClip[]
    this.actions = {};        // name -> AnimationAction
    this.currentAction = null;
    this.currentMotion = 'idle';
    this.intensity = 1;
    this.model = null;
    this.skeletonHelper = null;
    this.faceMeshes = [];     // 含 morphTarget 的网格
    this.ready = false;
    this._loadPromise = null;
    this._showSkeleton = showSkeleton;

    this._load();
  }

  async _load() {
    if (this._loadPromise) return this._loadPromise;
    this._loadPromise = this._doLoad();
    return this._loadPromise;
  }

  async _doLoad() {
    const loader = new GLTFLoader();
    const gltf = await loader.loadAsync(this.url);

    this.model = gltf.scene;
    this.model.scale.setScalar(this.scaleFactor);
    this.model.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
        if (o.morphTargetInfluences) this.faceMeshes.push(o);
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
  _findClip(motion) {
    const hints = MOTION_CLIP_HINTS[motion] || [];
    for (const hint of hints) {
      const found = this.clips.find((c) => c.name.toLowerCase().includes(hint.toLowerCase()));
      if (found) return found.name;
    }
    // 兜底：第一个动画
    return this.clips[0]?.name;
  }

  /** 平滑切换到目标动作（crossfade） */
  playMotion(motion) {
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
  setDecision({ motion = 'idle', expression = 'neutral', intensity = 1, lookAtUser = false }) {
    if (motion) this.playMotion(motion);
    this.intensity = Math.max(0.1, intensity);
    if (this.currentAction) this.currentAction.timeScale = 0.6 + this.intensity * 0.5;
    this._applyExpression(expression);
  }

  _applyExpression(name) {
    const morphs = EXPRESSION_MORPHS[name] || {};
    for (const mesh of this.faceMeshes) {
      const dict = mesh.morphTargetDictionary || {};
      const inf = mesh.morphTargetInfluences;
      // 先归零
      for (let i = 0; i < inf.length; i++) inf[i] = 0;
      for (const [morphName, val] of Object.entries(morphs)) {
        const idx = dict[morphName];
        if (idx != null) inf[idx] = val;
      }
    }
  }

  showSkeleton(v) {
    if (this.skeletonHelper) this.skeletonHelper.visible = !!v;
  }

  resetToBindPose() {
    if (this.currentAction) {
      this.currentAction.stop();
      this.currentAction = null;
    }
    this.currentMotion = 'idle';
    this.playMotion('idle');
  }

  update(dt) {
    if (this.mixer) this.mixer.update(dt);
  }

  whenReady() {
    return this._loadPromise || Promise.resolve(this);
  }

  dispose() {
    if (this.mixer) {
      this.mixer.stopAllAction();
      this.mixer.uncacheRoot(this.model);
    }
    if (this.skeletonHelper) this.skeletonHelper.dispose();
    if (this.model) {
      this.model.traverse((o) => {
        if (o.isMesh) {
          o.geometry?.dispose();
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          mats.forEach((m) => m?.dispose());
        }
      });
    }
  }
}