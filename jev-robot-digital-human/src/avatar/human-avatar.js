/**
 * HumanAvatar —— 基于 THREE.Bone + SkinnedMesh 的程序化 3D 数字人。
 *
 * 身体（躯干+四肢）由 RiggedBody 提供：标准人形骨骼层级 + 单一蒙皮网格，
 * 关节处通过 skinIndex/skinWeight 平滑变形；骨骼可叠加标准 AnimationClip。
 * 面部保留程序化 blend-shape 风格（嘴型曲面重建 + 眉眼眼睑）。
 *
 * 运动驱动：外部决策 → setDecision → update 每帧把目标关节旋转平滑施加到骨骼。
 * 表情驱动：ExpressionController 给出通道值 → _applyFace 重建嘴/眉眼。
 */
import * as THREE from 'three';
import { RiggedBody } from './rig.js';
import { getMotionPose, JOINT_IDS } from './motions.js';
import { ExpressionController } from './expressions.js';

const COLOR = {
  skin: 0xf2c9a8,
  bodyDark: 0x3f6fb0,
  hair: 0x3b2b20,
  lip: 0xd95f4e,
  eye: 0xffffff,
  pupil: 0x1d2633,
};

// 旧关节 id → 新骨骼名 的映射
const BONE_MAP = {
  hips: 'hips',
  chest: 'chest',
  head: 'head',
  legL: 'thighL',
  kneeL: 'calfL',
  legR: 'thighR',
  kneeR: 'calfR',
  armL: 'upperArmL',
  elbowL: 'lowerArmL',
  armR: 'upperArmR',
  elbowR: 'lowerArmR',
};

export class HumanAvatar extends THREE.Group {
  constructor({ showSkeleton = false } = {}) {
    super();
    this.exp = new ExpressionController();
    this.targetMotion = 'idle';
    this.intensity = 1;
    this.targetYaw = 0;
    this.lookAtUser = false;

    // 蒙皮身体
    this.rig = new RiggedBody({ showSkeleton });
    this.rig.skinnedMesh.position.y = 0.95; // 把 hips 抬到地面以上（与原 hipY 一致）
    this.add(this.rig.skinnedMesh);
    this.add(this.rig.skeletonHelper);

    // 脚部附件（小盒子，挂在脚骨上）
    this._addFeet();

    // 面部（挂在 head 骨上）
    this.headBone = this.rig.bones.head;
    this._buildFace();

    // 平滑插值用的当前关节旋转
    this._jointSmooth = {};
    for (const id of JOINT_IDS) this._jointSmooth[id] = { x: 0, y: 0, z: 0 };

    // rootObj 用于身体整体的根偏移（颠簸）与朝向
    this.rootObj = this.rig.skinnedMesh;
  }

  /* ---------------- 小附件：脚 ---------------- */

  _addFeet() {
    const mat = new THREE.MeshStandardMaterial({ color: COLOR.bodyDark, roughness: 0.6 });
    for (const name of ['footL', 'footR']) {
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.06, 0.2), mat);
      box.position.set(0, -0.02, 0.05);
      this.rig.bones[name].add(box);
    }
  }

  /* ---------------- 面部 ---------------- */

  _buildFace() {
    const skullMat = new THREE.MeshStandardMaterial({ color: COLOR.skin, roughness: 0.55 });
    // 头骨（挂在 head 骨上，head 骨在脖子顶端）
    const skull = new THREE.Mesh(new THREE.SphereGeometry(0.2, 32, 24), skullMat);
    skull.position.y = 0.2;
    skull.castShadow = true;
    this.headBone.add(skull);

    // 头发
    const skullDark = new THREE.Mesh(
      new THREE.SphereGeometry(0.205, 24, 18),
      new THREE.MeshStandardMaterial({ color: COLOR.hair, roughness: 0.8 })
    );
    skullDark.scale.set(1, 0.62, 1.02);
    skullDark.position.set(0, 0.3, -0.02);
    this.headBone.add(skullDark);

    // 眉眼嘴
    const browMat = new THREE.MeshStandardMaterial({ color: COLOR.hair, roughness: 0.8 });
    this.browL = this._brow(browMat);
    this.browR = this._brow(browMat);
    this.browL.position.set(-0.075, 0.33, 0.18);
    this.browR.position.set(0.075, 0.33, 0.18);
    this.headBone.add(this.browL);
    this.headBone.add(this.browR);

    this.eyeL = this._makeEye(); this.eyeL.position.set(-0.075, 0.27, 0.17);
    this.eyeR = this._makeEye(); this.eyeR.position.set(0.075, 0.27, 0.17);
    this.headBone.add(this.eyeL); this.headBone.add(this.eyeR);

    this._mouthRef = new THREE.Object3D();
    this._mouthRef.position.set(0, 0.1, 0.18);
    this.headBone.add(this._mouthRef);
    this._mouthMesh = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshStandardMaterial({ color: COLOR.lip, roughness: 0.45 })
    );
    this._mouthRef.add(this._mouthMesh);
  }

  _brow(mat) {
    const g = new THREE.Group();
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.016, 0.03), mat);
    g.add(box);
    return g;
  }

  _makeEye() {
    const g = new THREE.Group();
    const sclera = new THREE.Mesh(
      new THREE.SphereGeometry(0.034, 20, 16),
      new THREE.MeshStandardMaterial({ color: COLOR.eye, roughness: 0.25 })
    );
    sclera.scale.set(1, 1, 0.7);
    g.add(sclera);
    const pupil = new THREE.Mesh(
      new THREE.SphereGeometry(0.02, 16, 12),
      new THREE.MeshStandardMaterial({ color: COLOR.pupil, roughness: 0.4 })
    );
    pupil.position.z = 0.03;
    g.add(pupil);
    g.userData.pupil = pupil;
    const lid = new THREE.Group();
    lid.position.y = 0.036;
    const lidBox = new THREE.Mesh(
      new THREE.BoxGeometry(0.075, 0.04, 0.012),
      new THREE.MeshStandardMaterial({ color: COLOR.skin, roughness: 0.5 })
    );
    lidBox.position.y = -0.02;
    lid.add(lidBox);
    g.add(lid);
    g.userData.lid = lid;
    return g;
  }

  /* ---------------- 外部设值 ---------------- */

  setDecision({ motion = 'idle', expression = 'neutral', intensity = 1, lookAtUser = false }) {
    if (motion) this.targetMotion = motion;
    if (expression) this.exp.setExpression(expression);
    this.intensity = Math.max(0, intensity);
    this.lookAtUser = !!lookAtUser;
  }

  /** 显示/隐藏骨骼可视化（SkeletonHelper）。 */
  showSkeleton(v) {
    this.rig.showSkeleton(v);
  }

  /** 恢复到绑定姿态（rest pose）。 */
  resetToBindPose() {
    this.rig.resetToBindPose();
    for (const id of JOINT_IDS) this._jointSmooth[id] = { x: 0, y: 0, z: 0 };
  }

  /** 直接获取某根骨骼（用于高级动画/调试）。 */
  getBone(name) {
    return this.rig.bones[name];
  }

  /* ---------------- 每帧更新 ---------------- */

  update(dt, t) {
    // 1) 身体朝向（hips 整体旋转）
    const targetYaw = this.lookAtUser ? 0 : Math.sin(t * 0.35) * 0.55;
    const hips = this.rig.bones.hips;
    hips.rotation.y += (targetYaw - hips.rotation.y) * this._k(dt, 4);

    // 2) 运动姿态 → 骨骼旋转（平滑插值）
    const pose = getMotionPose(this.targetMotion, t, this.intensity);
    const k = this._k(dt, 9);
    for (const id of JOINT_IDS) {
      const target = pose.joints[id];
      const boneName = BONE_MAP[id];
      const bone = this.rig.bones[boneName];
      if (!bone) continue;
      const cur = this._jointSmooth[id];
      cur.x += (target[0] - cur.x) * k;
      cur.y += (target[1] - cur.y) * k;
      cur.z += (target[2] - cur.z) * k;
      bone.rotation.set(cur.x, cur.y, cur.z);
    }

    // 3) 根位移（颠簸）—— 直接挪 hips 位置（相对 skinnedMesh）
    const r = pose.root;
    hips.position.x += (r.x - hips.position.x) * this._k(dt, 6);
    // 注意：hips.position.y 保持 0（由 skinnedMesh.position.y 承担整体高度），只叠加少量抖动
    hips.position.y += (r.y * 0.3 - hips.position.y) * this._k(dt, 6);
    hips.position.z += (r.z - hips.position.z) * this._k(dt, 6);

    // 4) 表情
    const ch = this.exp.update(dt);
    this._applyFace(ch);

    // 5) 骨骼可视化更新
    this.rig.update(dt);
  }

  _k(dt, sp) {
    return 1 - Math.exp(-dt * sp);
  }

  _applyFace(ch) {
    const tilt = ch.browInnerUp;
    this.browL.rotation.z = tilt * 0.6;
    this.browR.rotation.z = -tilt * 0.6;
    this.browL.rotation.x = -ch.browRaise * 0.12;
    this.browR.rotation.x = -ch.browRaise * 0.12;
    this.browL.position.y = 0.33 + ch.browRaise * 0.04;
    this.browR.position.y = 0.33 + ch.browRaise * 0.04;

    const close = Math.min(1, (1 - ch.eyeOpen) * 1.3 + ch.eyeSqueeze * 0.6);
    for (const eye of [this.eyeL, this.eyeR]) {
      eye.userData.lid.rotation.x = close * 1.15;
      const pupil = eye.userData.pupil;
      pupil.scale.z = 0.5 + (1 - close) * 0.5;
      pupil.position.z = 0.03 - close * 0.01;
    }

    this._mouthMesh.geometry.dispose();
    this._mouthMesh.geometry = this._buildMouth(ch);
  }

  _buildMouth(ch) {
    const mw = 0.045 + ch.mouthWidth * 0.08;
    const cr = ch.mouthCurve;
    const open = 0.015 + ch.mouthOpen * 0.15;
    const N = 12;
    const zF = 0.014, zB = -0.012;
    const rows = [];
    const center = (i) => -mw + (2 * mw * i) / (N - 1);
    for (let i = 0; i < N; i++) {
      const x = center(i);
      const cf = (x / (mw || 0.0001)) ** 2;
      const corner = cr * 0.06 * cf;
      const bow = -0.004 - ch.mouthWidth * 0.002;
      const topY = bow + corner - open * 0.1;
      const botY = topY - open;
      rows.push([
        [x, topY, zF], [x, topY, zB],
        [x, botY, zF], [x, botY, zB],
      ]);
    }
    return this._tessellateBand(rows);
  }

  _tessellateBand(rows) {
    const pos = [];
    const idx = [];
    const N = rows.length;
    for (let i = 0; i < N; i++) pos.push(...rows[i].flat());
    const col = 4;
    const at = (i, kind) => i * col + kind;
    const quad = (a, b, c, d) => idx.push(a, b, c, a, c, d);
    for (let i = 0; i < N - 1; i++) {
      const a = i, b = i + 1;
      quad(at(a, 0), at(b, 0), at(b, 2), at(a, 2));
      quad(at(a, 1), at(b, 1), at(b, 3), at(a, 3));
      quad(at(a, 0), at(b, 0), at(b, 1), at(a, 1));
      quad(at(a, 2), at(b, 2), at(b, 3), at(a, 3));
    }
    quad(at(0, 0), at(0, 1), at(0, 3), at(0, 2));
    quad(at(N - 1, 0), at(N - 1, 1), at(N - 1, 3), at(N - 1, 2));

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    return geo;
  }

  dispose() {
    this.rig.dispose();
  }
}