# Jev · 数字人决策控制模拟

基于 **双系统决策架构** 的 3D 数字人控制演示：

- **System One（快思考）**：[Jev（TypeSafe）](https://api.typesafe.ai) 决策模型以固定频率把环境感知状态转为类型化决策（动作 / 表情 / 强度 / 朝向），经置信度门控后驱动 Three.js 真实 GLB 数字人实时表演
- **System Two（慢思考）**：[Pi Agent](https://github.com/badlogic/pi-mono) 服务端智能体（默认接入 DeepSeek），用户通过对话界面用自然语言指挥机器人，智能体调用机器人工具完成规划并下发指令

核心思想：**决策层与执行层解耦，快慢双系统分工** —— Jev 负责"高频类型化决策"，Pi 负责"低频自然语言规划与工具调用"，外围代码负责环境模拟、安全门控与动画执行。

## 功能特性

- **双系统架构**：Jev 快思考（~3.2s 决策循环）+ Pi 慢思考（对话式规划，工具调用）
- **可插拔决策引擎**：真实 Jev / 本地规则引擎，同一接口自动切换、失败自动回退
- **置信度门控**：决策置信度低于阈值时强制回退到安全的 `idle` 动作
- **类型化决策 schema**：动作(choice) + 表情(choice) + 强度(score) + 朝向(noul)，输出概率分布与置信度
- **Pi 智能体工具集**：`get_robot_state` / `set_robot_intent` / `command_robot` / `trigger_scene_event`，指令经浏览器侧安全应用
- **对话界面（主交互）**：右侧面板对话区，展示回复、工具调用轨迹，指令一键应用；参数配置收入弹出窗口
- **真实 GLB 数字人**：RobotExpressive / Xbot，骨骼动画 crossfade 平滑切换，morph 表情
- **实时可视化**：决策概率条、置信度、门控判定、决策历史、感知状态 JSON
- **场景事件模拟**：用户走近 / 前进 / 障碍物 / 指引 / 庆祝 / 不确定 → 触发新一轮决策
- **Key 安全**：API Key 仅存服务端（Vite 中间件），浏览器零接触
- **全 TypeScript**：源码与 Vite 配置均为 TS，`npm run typecheck` 类型校验

## 快速开始

```bash
cd jev-robot-digital-human
npm install
npm run dev        # http://localhost:5173
```

环境配置（项目根目录 `.env`）：

```bash
# System One：Jev 决策模型（不配置时自动走本地引擎）
TYPESAFE_API_KEY=your_key

# System Two：Pi 智能体（默认 DeepSeek）
LLM_API_KEY=sk-xxx
LLM_API_BASE=https://api.deepseek.com/v1
# 可选：显式指定模型，格式 provider/model（默认自动探测 deepseek-v4-pro / deepseek-flash）
# PI_AGENT_MODEL=deepseek/deepseek-flash
```

常用脚本：

```bash
npm run dev         # 开发服务器（含 API 代理与智能体端点）
npm run build       # 生产构建
npm run typecheck   # tsc --noEmit 类型校验
```

## 架构

```
┌──────────────────────────────────────────────────────────────┐
│  对话层  ui/chat.ts + index.html（右侧面板主交互区）           │
│  自然语言输入 → /api/agent/chat → 回复 + 工具轨迹 + 指令应用     │
├──────────────────────────────────────────────────────────────┤
│  智能体层（System Two · 服务端）  server/pi-agent.ts           │
│  Pi Agent 单例 + DeepSeek · 4 个机器人工具 · 请求串行化          │
│  GET  /api/agent/health   健康检查（模型是否可用）               │
│  POST /api/agent/chat     对话（返回 reply + toolTrace + 命令） │
├──────────────────────────────────────────────────────────────┤
│  UI 层  ui/panel.ts + index.html                              │
│  面板绑定 · 决策可视化(概率/历史) · 场景事件按钮                  │
├──────────────────────────────────────────────────────────────┤
│  控制层  loop.ts (Simulation)                                 │
│  决策循环 → 置信度门控 → 安全回退 → 下发执行                     │
├──────────────────────────────────────────────────────────────┤
│  决策层（System One · 浏览器侧）  jev/                          │
│  decision-engine.ts   可插拔引擎 (auto / real / local)         │
│    ├ RealJevEngine ── jev-client.ts (HTTP, 12s 超时)          │
│    └ LocalMockEngine (规则打分 + softmax，离线兜底)              │
│  semantics.ts  统一 schema：questions / answers / 归一化        │
├──────────────────────────────────────────────────────────────┤
│  代理层  vite.config.ts (jev-proxy + pi-agent 插件)            │
│  POST /api/systemone → api.typesafe.ai/v1/systemone           │
│  /api/agent/*        → Pi 智能体（同进程 Vite 中间件）           │
├──────────────────────────────────────────────────────────────┤
│  执行层  main.ts 装配 + avatar/gltf-avatar.ts                  │
│  Three.js 场景 · GLB 模型 · AnimationMixer 动画切换             │
└──────────────────────────────────────────────────────────────┘
```

### 双决策闭环

**System One（Jev 快思考，浏览器内自动循环）：**

```
场景事件 / 环境漂移 → env {intent, userProximity, obstacleAhead, energy}
  → engine.decide(env)                     [真实 Jev 或本地规则]
  → 置信度门控 (confidence < gate → motion 强制 idle)
  → panel.setDecision()                    [概率条 / 置信度 / 历史]
  → avatar.setDecision({motion, expression, intensity})
  → AnimationMixer crossfade 播放
```

**System Two（Pi 慢思考，服务端智能体）：**

```
用户对话 → POST /api/agent/chat {message, env, lastDecision}
  → Pi Agent (DeepSeek) 慢思考，按需调用工具：
     get_robot_state     读取当前环境/决策状态
     set_robot_intent    修改机器人意图（patchEnv）
     command_robot       直接下发动作/表情/强度/朝向
     trigger_scene_event 注入场景事件（走 Jev 快思考响应）
  → 响应 {reply, toolTrace, commands}
  → 浏览器按序应用：set_intent → sim.patchEnv()
                   command → 合成 decision → avatar 执行
                   trigger_event → sim.triggerEvent()
```

### 模块说明

| 模块 | 职责 |
|---|---|
| `src/main.ts` | 装配根：场景/相机/渲染循环，panel ↔ sim ↔ avatar 接线，智能体指令应用，数字人切换（GLB 按包围盒归一化身高、脚底贴地） |
| `src/loop.ts` | `Simulation`：环境状态、能量漂移、定时步进决策、置信度门控、`patchEnv` 意图修正 |
| `src/jev/decision-engine.ts` | 引擎工厂 `createEngine(auto/real/local)`；真实引擎失败自动降级 |
| `src/jev/semantics.ts` | 核心抽象：`buildQuestions` / `buildState` / `normalizeDecision`，两种引擎共用同一 schema |
| `src/jev/jev-client.ts` | 纯 HTTP 客户端，超时与错误处理，不含 UI 逻辑 |
| `src/ui/panel.ts` | 纯 DOM 组件：事件绑定、回调上抛、决策可视化 |
| `src/ui/chat.ts` | 对话舱组件：健康检查、消息收发、工具轨迹渲染、指令应用 |
| `src/avatar/gltf-avatar.ts` | 执行器：GLB 加载、动画剪辑模糊匹配、crossfade 切换、morph 表情 |
| `server/pi-agent.ts` | Pi Agent 单例 + Vite 插件：模型解析（DeepSeek 优先）、4 个机器人工具、请求串行化 |

## 使用说明

1. **启动循环**：点击右上角 `▶ 启动循环`，数字人开始按决策间隔自主决策（System One）
2. **对话指挥（主交互）**：右侧面板对话区用自然语言和机器人聊天，例如：
   - "欢迎一下我" → Pi 调用 `command_robot(wave, happy)` 直接执行
   - "跳个舞庆祝一下" → `command_robot(dance, happy)` + `trigger_scene_event(celebrate)`
   - "前方有障碍物怎么办" → `set_robot_intent(避障)`，后续 Jev 循环自主决策避让
3. **参数设置**：点击右上角 `⚙ 参数设置` 打开弹窗——切换引擎（自动/真实 Jev/本地）、
   决策间隔（800–6000ms）、置信度门控阈值（0–0.95）、数字人类型、骨骼调试
4. **决策 · 状态总览**：面板底部紧凑展示引擎/置信度/门控/朝向 + 动作概率条 +
   意图/距离/能量/障碍；`感知状态与决策历史` 可展开查看原始 JSON 与历史
5. **切换数字人**：设置弹窗中 `真实·机器人`（RobotExpressive）/ `真实·Xbot`
6. **骨骼调试**：设置弹窗中 `显示骨骼` 叠加 SkeletonHelper；`重置绑定姿态` 复位动画

## 目录结构

```
jev-robot-digital-human/
├── index.html              # 页面骨架 + 控制面板 + 对话舱
├── vite.config.ts          # Vite 配置 + Jev 代理 + Pi 智能体插件
├── tsconfig.json           # TypeScript 配置（bundler 解析）
├── .env                    # TYPESAFE_API_KEY / LLM_API_KEY 等
├── public/models/          # RobotExpressive.glb / Xbot.glb
├── server/
│   └── pi-agent.ts         # Pi 智能体（System Two · DeepSeek）
└── src/
    ├── main.ts             # 装配根 + 渲染循环 + 指令应用
    ├── loop.ts             # 决策循环 Simulation
    ├── style.css           # 样式（含对话舱）
    ├── jev/
    │   ├── decision-engine.ts   # 可插拔引擎
    │   ├── jev-client.ts        # Jev HTTP 客户端
    │   ├── semantics.ts         # 决策 schema 与共享类型
    │   └── types.ts             # 类型再导出 + DecisionEngine 接口
    ├── avatar/
    │   └── gltf-avatar.ts       # GLB 数字人执行器
    └── ui/
        ├── panel.ts             # 控制面板
        └── chat.ts              # Pi 对话舱
```

## 技术栈

- [TypeScript](https://www.typescriptlang.org/) ^5.9 —— 全量类型安全（`moduleResolution: bundler`）
- [Three.js](https://threejs.org/) ^0.169 —— 3D 渲染 / 骨骼动画
- [Vite](https://vitejs.dev/) ^5.4 —— 开发服务器 / 构建 / API 代理 / 中间件插件
- [TypeSafe Jev](https://api.typesafe.ai) —— System-One 决策模型（可选）
- [Pi Agent](https://github.com/badlogic/pi-mono)（`@earendil-works/pi-agent-core` + `pi-ai`）—— System-Two 智能体运行时
- [DeepSeek](https://api.deepseek.com) —— Pi 智能体默认大模型
