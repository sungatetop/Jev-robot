/**
 * Avatar25D —— 2.5D 数字人（分层 billboard + 程序化 canvas 表情）。
 *
 * 原理：把身体各部位（头发/躯干/手臂/头/手）画在独立 Plane 上，按 z 深度分层
 * 排列，每层始终朝向相机（billboard），从而用 2D 素材营造出 3D 纵深视差感。
 * 表情通过 canvas 实时重绘面部纹理；运动通过层的位移/缩放/旋转模拟。
 */
import * as THREE from 'three';

// 表情配色
const PALETTE = {
  skin: '#f2c9a8',
  skinShadow: '#d9a87e',
  hair: '#3b2b20',
  body: '#5f9be6',
  bodyDark: '#3f6fb0',
  lip: '#d95f4e',
  eye: '#ffffff',
  pupil: '#1d2633',
  brow: '#3b2b20',
};

export class Avatar25D extends THREE.Group {
  constructor({ scale = 1.8 } = {}) {
    super();
    this.scale.setScalar(scale);
    this.exp = 'neutral';
    this.motion = 'idle';
    this.intensity = 1;
    this._t = 0;

    // 面部 canvas 纹理（每帧表情变化时重绘）
    this._faceCanvas = document.createElement('canvas');
    this._faceCanvas.width = 256;
    this._faceCanvas.height = 256;
    this._faceCtx = this._faceCanvas.getContext('2d');
    this._faceTex = new THREE.CanvasTexture(this._faceCanvas);
    this._faceTex.colorSpace = THREE.SRGBColorSpace;

    this._buildLayers();
    this._drawFace();
  }

  /* ---------- 构建分层 billboard ---------- */

  _plane(w, h, color, opacity = 1) {
    const geo = new THREE.PlaneGeometry(w, h);
    const mat = new THREE.MeshBasicMaterial({
      color, transparent: opacity < 1, opacity,
      side: THREE.DoubleSide, depthWrite: false,
    });
    return new THREE.Mesh(geo, mat);
  }

  _buildLayers() {
    // 从后到前：shadow → hair back → torso → arms → head(face) → hands
    this.shadow = this._plane(1.4, 0.25, 0x000000, 0.18);
    this.shadow.position.set(0, -0.92, -0.3);
    this.add(this.shadow);

    // 头发后层
    this.hairBack = this._plane(0.7, 0.9, PALETTE.hair);
    this.hairBack.position.set(0, 0.15, -0.12);
    this.add(this.hairBack);

    // 躯干
    this.torso = this._plane(0.85, 1.1, PALETTE.body);
    this.torso.position.set(0, -0.35, 0);
    this.add(this.torso);

    // 左臂（后）
    this.armL = this._plane(0.22, 0.75, PALETTE.skin);
    this.armL.position.set(-0.55, -0.35, -0.05);
    this.add(this.armL);

    // 右臂（前）
    this.armR = this._plane(0.22, 0.75, PALETTE.skin);
    this.armR.position.set(0.55, -0.35, 0.05);
    this.add(this.armR);

    // 头部（含面部纹理）
    this.head = this._plane(0.72, 0.72, 0xffffff);
    this.head.position.set(0, 0.42, 0.1);
    this.head.material.map = this._faceTex;
    this.add(this.head);

    // 头发前层（刘海）
    this.hairFront = this._plane(0.74, 0.42, PALETTE.hair);
    this.hairFront.position.set(0, 0.66, 0.12);
    this.add(this.hairFront);

    // 手
    this.handL = this._plane(0.22, 0.22, PALETTE.skin);
    this.handL.position.set(-0.62, -0.72, 0.08);
    this.add(this.handL);

    this.handR = this._plane(0.22, 0.22, PALETTE.skin);
    this.handR.position.set(0.62, -0.72, 0.08);
    this.add(this.handR);

    this.layers = [this.shadow, this.hairBack, this.torso, this.armL, this.armR,
      this.head, this.hairFront, this.handL, this.handR];
  }

  /* ---------- 面部绘制 ---------- */

  _drawFace() {
    const ctx = this._faceCtx;
    const W = 256, H = 256;
    ctx.clearRect(0, 0, W, H);

    // 脸
    ctx.fillStyle = PALETTE.skin;
    ctx.beginPath();
    ctx.ellipse(W / 2, H / 2 + 10, 95, 110, 0, 0, Math.PI * 2);
    ctx.fill();

    // 脸颊阴影
    ctx.fillStyle = PALETTE.skinShadow;
    ctx.beginPath();
    ctx.ellipse(W / 2 - 55, H / 2 + 30, 30, 20, 0, 0, Math.PI * 2);
    ctx.ellipse(W / 2 + 55, H / 2 + 30, 30, 20, 0, 0, Math.PI * 2);
    ctx.fill();

    // 眉毛（根据表情）
    ctx.strokeStyle = PALETTE.brow;
    ctx.lineWidth = 6;
    ctx.lineCap = 'round';
    let browBaseY = 150;
    let browTilt = 0;        // 眉内角上挑/下压
    let browRaise = 0;       // 整体抬升
    if (this.exp === 'surprised') { browRaise = -22; }
    else if (this.exp === 'angry') { browTilt = 0.35; browRaise = 12; }
    else if (this.exp === 'sad') { browTilt = -0.3; }
    else if (this.exp === 'happy') { browRaise = -6; }

    const yB = browBaseY + browRaise;
    ctx.beginPath();
    ctx.moveTo(W / 2 - 55, yB);
    ctx.lineTo(W / 2 - 12, yB + browTilt * 25);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(W / 2 + 12, yB + browTilt * 25);
    ctx.lineTo(W / 2 + 55, yB);
    ctx.stroke();

    // 眼睛
    const eyeY = H / 2 - 5;
    const open = this.exp === 'surprised' ? 16 : this.exp === 'happy' ? 4 : 11;
    ctx.fillStyle = PALETTE.eye;
    ctx.beginPath();
    ctx.ellipse(W / 2 - 33, eyeY, 14, open, 0, 0, Math.PI * 2);
    ctx.ellipse(W / 2 + 33, eyeY, 14, open, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = PALETTE.pupil;
    if (open > 3) {
      ctx.beginPath();
      ctx.arc(W / 2 - 33, eyeY, 6, 0, Math.PI * 2);
      ctx.arc(W / 2 + 33, eyeY, 6, 0, Math.PI * 2);
      ctx.fill();
    }

    // 嘴
    const mouthY = H / 2 + 55;
    ctx.strokeStyle = PALETTE.lip;
    ctx.lineWidth = 5;
    ctx.beginPath();
    if (this.exp === 'happy') {
      ctx.arc(W / 2, mouthY - 10, 30, 0.15 * Math.PI, 0.85 * Math.PI);
    } else if (this.exp === 'sad') {
      ctx.arc(W / 2, mouthY + 22, 30, 1.15 * Math.PI, 1.85 * Math.PI);
    } else if (this.exp === 'surprised') {
      ctx.ellipse(W / 2, mouthY, 14, 20, 0, 0, Math.PI * 2);
      ctx.fillStyle = PALETTE.lip;
      ctx.fill();
    } else if (this.exp === 'angry') {
      ctx.moveTo(W / 2 - 28, mouthY + 6);
      ctx.lineTo(W / 2 + 28, mouthY + 6);
    } else {
      ctx.moveTo(W / 2 - 25, mouthY);
      ctx.lineTo(W / 2 + 25, mouthY);
    }
    ctx.stroke();

    this._faceTex.needsUpdate = true;
  }

  /* ---------- 外部接口 ---------- */

  setDecision({ motion = 'idle', expression = 'neutral', intensity = 1, lookAtUser = false }) {
    const newExp = expression || 'neutral';
    if (newExp !== this.exp) {
      this.exp = newExp;
      this._drawFace();
    }
    this.motion = motion;
    this.intensity = Math.max(0, intensity);
  }

  update(dt, t) {
    this._t += dt;
    const s = Math.sin(this._t * 2);
    const amp = 0.6 + this.intensity * 0.5;

    // 整体呼吸 + 运动驱动层位移
    this.torso.position.y = -0.35 + s * 0.015 * amp;
    this.head.position.y = 0.42 + s * 0.02 * amp;
    this.hairFront.position.y = 0.66 + s * 0.02 * amp;

    // 按 motion 调整手臂/手
    switch (this.motion) {
      case 'wave':
        this.armR.position.set(0.5 + s * 0.05, 0.15, 0.05);
        this.armR.rotation.z = -0.5 + s * 0.2;
        this.handR.position.set(0.7, 0.0, 0.08);
        break;
      case 'dance':
        this.armL.position.set(-0.55 + Math.sin(this._t * 4) * 0.1, -0.2, -0.05);
        this.armR.position.set(0.55 + Math.cos(this._t * 4) * 0.1, -0.2, 0.05);
        this.head.position.x = Math.sin(this._t * 2) * 0.05;
        break;
      case 'point':
        this.armR.position.set(0.6, -0.05, 0.05);
        this.armR.rotation.z = -1.3;
        break;
      case 'shrug':
        this.armL.position.y = -0.15 + Math.abs(s) * 0.1;
        this.armR.position.y = -0.15 + Math.abs(s) * 0.1;
        break;
      case 'march':
        this.torso.position.y = -0.35 + Math.abs(s) * 0.08 * amp;
        break;
      default: // idle / walk
        this.armL.position.set(-0.55, -0.35 + s * 0.02, -0.05);
        this.armR.position.set(0.55, -0.35 - s * 0.02, 0.05);
        this.armL.rotation.z = 0; this.armR.rotation.z = 0;
        break;
    }

    // billboard：所有层朝向相机
    const cam = this._camera;
    if (cam) {
      for (const layer of this.layers) {
        layer.lookAt(cam.position);
      }
    }
  }

  /** 由外部每帧注入相机，用于 billboard */
  setCamera(cam) { this._camera = cam; }

  showSkeleton() {} // 2.5D 无骨骼
  resetToBindPose() { this.motion = 'idle'; this.setDecision({ motion: 'idle', expression: 'neutral', intensity: 1 }); }
}