/**
 * RiggedBody —— 真正的 Three.js 骨骼绑定（骨骼 + 蒙皮）。
 *
 * 相比原先“每个肢体段一个独立 Mesh 挂在 Group 上”的刚性分段方案，
 * 这里使用：
 *   THREE.Bone        —— 标准人形骨架层级（hips → spine → chest → neck → head / 四肢）
 *   THREE.Skeleton    —— 管理骨骼数组与 bindMatrix
 *   THREE.SkinnedMesh —— 单一身体网格，通过 skinIndex/skinWeight 实现关节处的平滑蒙皮变形
 *   SkeletonHelper    —— 可选的骨骼可视化（调试/展示用）
 *   AnimationMixer    —— 兼容 Three.js 标准动画剪辑（keyframes → bone transforms）
 *
 * 身体几何由若干胶囊段合并而成；蒙皮权重按“顶点到骨骼线段的距离”做 2 骨平滑混合，
 * 这样关节处会自然过渡，不会出现硬穿模或脱节。
 */
import * as THREE from 'three';

/* ---------------- 骨骼定义 ---------------- */

// 骨骼定义：name, parent, localPosition
// 坐标约定：Y 向上，Z 向前；肢体段沿 -Y 悬挂（与原 avatar 一致）
const BONE_DEFS = [
  { name: 'hips',       parent: null,         pos: [0, 0, 0] },
  { name: 'spine',      parent: 'hips',       pos: [0, 0.20, 0] },
  { name: 'chest',      parent: 'spine',      pos: [0, 0.25, 0] },
  { name: 'neck',       parent: 'chest',      pos: [0, 0.15, 0] },
  { name: 'head',       parent: 'neck',       pos: [0, 0.12, 0] },
  // 左臂
  { name: 'shoulderL',  parent: 'chest',      pos: [-0.14, 0.00, 0] },
  { name: 'upperArmL',  parent: 'shoulderL',  pos: [0, -0.42, 0] },
  { name: 'lowerArmL',  parent: 'upperArmL',  pos: [0, -0.36, 0] },
  { name: 'handL',      parent: 'lowerArmL',  pos: [0, -0.15, 0] },
  // 右臂
  { name: 'shoulderR',  parent: 'chest',      pos: [0.14, 0.00, 0] },
  { name: 'upperArmR',  parent: 'shoulderR',  pos: [0, -0.42, 0] },
  { name: 'lowerArmR',  parent: 'upperArmR',  pos: [0, -0.36, 0] },
  { name: 'handR',      parent: 'lowerArmR',  pos: [0, -0.15, 0] },
  // 左腿
  { name: 'thighL',     parent: 'hips',       pos: [-0.11, 0, 0] },
  { name: 'calfL',      parent: 'thighL',     pos: [0, -0.50, 0] },
  { name: 'footL',      parent: 'calfL',      pos: [0, -0.45, 0.05] },
  // 右腿
  { name: 'thighR',     parent: 'hips',       pos: [0.11, 0, 0] },
  { name: 'calfR',      parent: 'thighR',     pos: [0, -0.50, 0] },
  { name: 'footR',      parent: 'calfR',      pos: [0, -0.45, 0.05] },
];

export const BONE_NAMES = BONE_DEFS.map((b) => b.name);

/* ---------------- 身体段（胶囊）定义 ---------------- */

// 每个身体段 = 两个端点骨骼间的胶囊
const SEGMENT_DEFS = [
  { a: 'hips',      b: 'chest',    radius: 0.14 }, // 躯干（腰→胸，包含 spine）
  { a: 'chest',     b: 'neck',     radius: 0.11 }, // 上胸
  { a: 'neck',      b: 'head',     radius: 0.05 }, // 脖子
  { a: 'shoulderL', b: 'upperArmL',radius: 0.06 }, // 左上臂
  { a: 'upperArmL', b: 'lowerArmL',radius: 0.055 },// 左前臂
  { a: 'lowerArmL', b: 'handL',    radius: 0.045 },// 左手
  { a: 'shoulderR', b: 'upperArmR',radius: 0.06 },
  { a: 'upperArmR', b: 'lowerArmR',radius: 0.055 },
  { a: 'lowerArmR', b: 'handR',    radius: 0.045 },
  { a: 'thighL',    b: 'calfL',    radius: 0.075 },// 左大腿
  { a: 'calfL',     b: 'footL',    radius: 0.062 },// 左小腿
  { a: 'thighR',    b: 'calfR',    radius: 0.075 },
  { a: 'calfR',     b: 'footR',    radius: 0.062 },
];

export class RiggedBody {
  constructor({ showSkeleton = false } = {}) {
    this.bones = {};        // name -> THREE.Bone
    this.boneList = [];     // 与 skeleton.bones 顺序一致
    this.bindPose = {};     // name -> {pos, quat, scale}
    this.skeleton = null;
    this.skinnedMesh = null;
    this.skeletonHelper = null;
    this.mixer = null;
    this.clock = new THREE.Clock(false);

    this._buildBones();
    this._buildSkinnedMesh();
    this._captureBindPose();

    this.skeletonHelper = new THREE.SkeletonHelper(this.skinnedMesh);
    this.skeletonHelper.visible = showSkeleton;
    this.skeletonHelper.material.linewidth = 2;

    this.mixer = new THREE.AnimationMixer(this.rootBone);
  }

  /* ---------- 1. 构建骨骼层级 ---------- */

  _buildBones() {
    // 先全部创建
    for (const def of BONE_DEFS) {
      const bone = new THREE.Bone();
      bone.name = def.name;
      bone.position.set(...def.pos);
      this.bones[def.name] = bone;
    }
    // 再挂父子
    for (const def of BONE_DEFS) {
      if (def.parent) this.bones[def.parent].add(this.bones[def.name]);
    }
    this.rootBone = this.bones.hips;
    // 顺序（层级遍历，与 skeleton 数组对应）
    this.rootBone.traverse((b) => {
      if (b.isBone) this.boneList.push(b);
    });
  }

  /* ---------- 2. 构建蒙皮身体网格 ---------- */

  _buildSkinnedMesh() {
    const geometry = this._buildBodyGeometry();
    const material = new THREE.MeshStandardMaterial({
      color: 0x5f9be6,
      roughness: 0.7,
      metalness: 0.05,
    });
    const mesh = new THREE.SkinnedMesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    // 把骨骼挂到 mesh 下（保证 world matrix 与 mesh 一致）
    mesh.add(this.rootBone);
    this.skeleton = new THREE.Skeleton(this.boneList);
    mesh.bind(this.skeleton);

    this.skinnedMesh = mesh;
  }

  /** 合并各段胶囊为单一几何，并计算 skinIndex/skinWeight。 */
  _buildBodyGeometry() {
    const positions = [];
    const indices = [];
    let baseIndex = 0;

    // 计算每根骨骼的世界坐标 bind 位置（root=hips 在原点）
    const boneWorld = {};
    this.rootBone.updateMatrixWorld(true);
    const tmp = new THREE.Vector3();
    for (const b of this.boneList) {
      b.getWorldPosition(tmp);
      boneWorld[b.name] = tmp.clone();
    }

    for (const seg of SEGMENT_DEFS) {
      const a = boneWorld[seg.a];
      const b = boneWorld[seg.b];
      const geo = this._capsuleBetween(a, b, seg.radius);
      const posAttr = geo.attributes.position;
      for (let i = 0; i < posAttr.count; i++) {
        positions.push(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i));
      }
      const idxAttr = geo.index;
      for (let i = 0; i < idxAttr.count; i++) {
        indices.push(idxAttr.getX(i) + baseIndex);
      }
      baseIndex += posAttr.count;
      geo.dispose();
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    this._computeSkinWeights(geometry, boneWorld);
    geometry.computeVertexNormals();
    return geometry;
  }

  /** 在 a、b 两点之间生成一个胶囊（轴线沿 a→b，半径 r）。 */
  _capsuleBetween(a, b, r) {
    const dir = new THREE.Vector3().subVectors(b, a);
    const len = dir.length() || 0.0001;
    const geo = new THREE.CapsuleGeometry(r, Math.max(0.0001, len - r * 2), 6, 14);
    // CapsuleGeometry 默认沿 Y 轴，中心在原点；把它放到 a→b 中点并朝向 b
    const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
    const quat = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      dir.clone().normalize()
    );
    geo.translate(mid.x, mid.y, mid.z);
    geo.applyQuaternion(quat);
    return geo;
  }

  /**
   * 程序化蒙皮权重：对每个顶点，取到骨骼线段距离最近的 2 根骨骼，
   * 按 1/d² 归一化分配权重（关节处自然平滑过渡）。
   */
  _computeSkinWeights(geometry, boneWorld) {
    const pos = geometry.attributes.position;
    const count = pos.count;
    const skinIndex = new Float32Array(count * 4);
    const skinWeight = new Float32Array(count * 4);

    // 骨骼线段：head = boneWorld[name], tail = 第一个子骨骼的位置（若无则沿 -Y 延伸）
    const segments = {};
    for (const b of this.boneList) {
      const head = boneWorld[b.name];
      let tail;
      if (b.children.length) {
        const firstChild = b.children.find((c) => c.isBone) || b.children[0];
        tail = boneWorld[firstChild.name] || head.clone().add(new THREE.Vector3(0, -0.1, 0));
      } else {
        // 叶子骨骼：沿父到自身方向继续延伸一点
        tail = head.clone().add(new THREE.Vector3(0, -0.12, 0));
      }
      segments[b.name] = { head, tail };
    }

    const v = new THREE.Vector3();
    const distances = [];

    for (let i = 0; i < count; i++) {
      v.fromBufferAttribute(pos, i);
      // 计算到每根骨骼线段的距离
      distances.length = 0;
      for (const b of this.boneList) {
        const seg = segments[b.name];
        const d = pointToSegmentDistance(v, seg.head, seg.tail);
        distances.push({ name: b.name, d });
      }
      distances.sort((x, y) => x.d - y.d);
      const top = distances.slice(0, 2);
      // 1/d² 权重，加个 epsilon 避免除零
      const w0 = 1 / (top[0].d * top[0].d + 1e-6);
      const w1 = top[1] ? 1 / (top[1].d * top[1].d + 1e-6) : 0;
      const sum = w0 + w1 || 1;
      const i0 = this.boneList.indexOf(this.bones[top[0].name]);
      const i1 = top[1] ? this.boneList.indexOf(this.bones[top[1].name]) : 0;
      skinIndex[i * 4 + 0] = i0;
      skinIndex[i * 4 + 1] = i1;
      skinIndex[i * 4 + 2] = 0;
      skinIndex[i * 4 + 3] = 0;
      skinWeight[i * 4 + 0] = w0 / sum;
      skinWeight[i * 4 + 1] = w1 / sum;
      skinWeight[i * 4 + 2] = 0;
      skinWeight[i * 4 + 3] = 0;
    }

    geometry.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndex, 4));
    geometry.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));
  }

  /* ---------- 3. bind / rest pose ---------- */

  _captureBindPose() {
    for (const b of this.boneList) {
      this.bindPose[b.name] = {
        position: b.position.clone(),
        quaternion: b.quaternion.clone(),
        scale: b.scale.clone(),
      };
    }
  }

  /** 恢复到绑定姿态（rest pose）。 */
  resetToBindPose() {
    for (const b of this.boneList) {
      const bp = this.bindPose[b.name];
      b.position.copy(bp.position);
      b.quaternion.copy(bp.quaternion);
      b.scale.copy(bp.scale);
    }
  }

  /* ---------- 4. 外部接口 ---------- */

  /** 显示/隐藏骨骼可视化。 */
  showSkeleton(v) {
    if (this.skeletonHelper) this.skeletonHelper.visible = !!v;
  }

  /** 直接设置某根骨骼的旋转（欧拉角，弧度）。 */
  setBoneRotation(name, x, y, z) {
    const bone = this.bones[name];
    if (bone) bone.rotation.set(x, y, z);
  }

  /** 批量设置（name -> [x,y,z]）。 */
  setBoneRotations(map) {
    for (const [name, r] of Object.entries(map)) {
      this.setBoneRotation(name, r[0], r[1], r[2]);
    }
  }

  /** 播放一个 AnimationClip（会接管对应骨骼）。 */
  playClip(clip, { loop = THREE.LoopRepeat } = {}) {
    const action = this.mixer.clipAction(clip);
    action.setLoop(loop);
    action.reset().play();
    return action;
  }

  /** 每帧更新（动画混合器 + 骨骼可视化）。 */
  update(dt) {
    if (this.mixer) this.mixer.update(dt);
  }

  dispose() {
    if (this.mixer) this.mixer.stopAllAction();
    if (this.skinnedMesh) {
      this.skinnedMesh.geometry.dispose();
      this.skinnedMesh.material.dispose();
    }
    if (this.skeletonHelper) this.skeletonHelper.dispose();
  }
}

/* ---------------- 工具：点到线段距离 ---------------- */
function pointToSegmentDistance(p, a, b) {
  const ab = new THREE.Vector3().subVectors(b, a);
  const lenSq = ab.lengthSq() || 1e-6;
  let t = new THREE.Vector3().subVectors(p, a).dot(ab) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const proj = a.clone().add(ab.multiplyScalar(t));
  return p.distanceTo(proj);
}