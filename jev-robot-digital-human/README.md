# Jev · 数字人决策控制模拟

基于 **双系统决策架构** 的 3D 数字人控制演示：

- **System One（快思考）**：[Jev（TypeSafe）](https://api.typesafe.ai) 决策模型以固定频率把环境感知状态转为类型化决策（动作 / 表情 / 强度 / 朝向），经置信度门控后驱动 Three.js 真实 GLB 数字人实时表演
- **System Two（慢思考）**：[Pi Agent](https://github.com/badlogic/pi-mono) 服务端智能体（默认接入 DeepSeek），用户通过对话界面用自然语言指挥机器人，智能体调用机器人工具完成规划并下发指令

核心思想：**决策层与执行层解耦，快慢双系统分工** —— Jev 负责"高频类型化决策"，Pi 负责"低频自然语言规划与工具调用"，外围代码负责环境模拟、安全门控与动画执行。

## 功能特性

- **双系统架构**：Jev 快思考（~3.2s 决策循环）+ Pi 慢思考（对话式规划，工具调用）
- **真实 Jev 决策引擎**：全部决策走真实 TypeSafe Jev；感知循环失败用 `idle` 安全动作兜底，消息响应失败默认转交慢思考
- **置信度门控**：决策置信度低于阈值时强制回退到安全的 `idle` 动作
- **类型化决策 schema**：动作(choice) + 表情(choice) + 强度(score) + 朝向(noul)，输出概率分布与置信度
- **Pi 智能体工具集**：4 个身体能力（`get_robot_state` / `set_robot_intent` / `command_robot` / `trigger_scene_event`）+ 3 个记忆能力（`read_memory` / `write_memory` / `read_recent_episodes`），指令经浏览器侧安全应用
- **对话界面（主交互）**：右侧面板对话区，SSE 流式回复逐字显示、工具轨迹实时追加、指令边说边动；参数配置收入弹出窗口
- **记忆自整理**：情景记忆持久化 + Agent 自主管理的记忆文件（`data/memory/*.md`），闲时自主 consolidate 整理，重启后对话无缝续聊
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
# System One：Jev 决策模型（.env 配置 TYPESAFE_API_KEY）
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
│  自然语言输入 → /api/agent/chat → SSE 流式回复 + 工具轨迹 + 指令  │
├──────────────────────────────────────────────────────────────┤
│  智能体层（System Two · 服务端）  server/pi-agent-server.ts     │
│  Pi Agent 单例 + DeepSeek · 7 个工具（4 身体 + 3 记忆）· 请求串行化│
│  GET  /api/agent/health       健康检查（模型是否可用）           │
│  POST /api/agent/chat         对话（SSE 流式：delta/tool/command）│
│  POST /api/agent/consolidate  记忆整理（发起 Agent 自主整理内心活动）│
│  GET  /api/agent/memory       记忆查看（调试：记忆索引 + 最近情景） │
├──────────────────────────────────────────────────────────────┤
│  UI 层  ui/panel.ts + index.html                              │
│  面板绑定 · 决策可视化(概率/历史) · 场景事件按钮                  │
├──────────────────────────────────────────────────────────────┤
│  控制层  loop.ts (Simulation)                                 │
│  决策循环 → 置信度门控 → 安全回退 → 下发执行                     │
├──────────────────────────────────────────────────────────────┤
│  决策层（System One · 浏览器侧）  jev/                          │
│  decision-engine.ts   真实 Jev 引擎 (RealJevEngine)             │
│    └ jev-client.ts (HTTP, 超时控制；失败上抛由调用方兜底)          │
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

**架构定位：Jev 快决策是外层循环（宿主），慢思考是内层循环（被消息触发）；内层的一切行为统一回流外层状态。**

**外层循环（System One · Jev 快思考，浏览器内永续）：**

```
场景事件 / 环境漂移 / 行为回流 → env {intent, userProximity, obstacleAhead, energy,
                                      currentAction, recentActions, socialDrive, ...}
  → engine.decide(env)                     [真实 Jev，失败 idle 兜底]
     state 含 currentMotion/actionSource/actionElapsedSec：
     Jev 知道"我此刻在做什么、做了多久、谁发起的"，不会无脑打断内层行为
  → 置信度门控 (confidence < gate → motion 强制 idle)
  → panel.setDecision()                    [概率条 / 置信度 / 历史]
  → avatar.setDecision({motion, expression, intensity})
  → sim.noteAction(applied, 'jev-loop')    [行为回流：下一轮决策可见]
```

**内层循环（消息触发，输出回流外层）：**

```
用户消息 → engine.decideMessage(env, message)
  每个动作（含 reply「说话」）独立 noul 打分（instructions 注入当前动作状态），
  阈值(0.5)以上同时执行：
  → 舞动 68%✓ + 回复 67%✓ → 边跳舞边唤醒 Pi 生成语言回复
  → 仅动作触发（如舞动 98%）→ 快反射直接执行，零 LLM 调用
  → 仅回复触发 → 纯慢思考对话
  → 执行后 sim.perceive(agent_action/agent_reply) 回流外层 env
```

**System Two（Pi 慢思考，服务端智能体）：**

```
用户对话 → POST /api/agent/chat {message, env, lastDecision}
  → Pi Agent (DeepSeek) 慢思考，按需调用工具：
     get_robot_state     读取当前环境/决策/行为状态
     set_robot_intent    修改机器人意图（patchEnv）
     command_robot       直接下发动作/表情/强度/朝向
     trigger_scene_event 注入场景事件（走 Jev 快思考响应）
  → SSE 流式响应（浏览器手动读流解析，边生成边显示、边执行）：
     meta    {model}                                    模型标识
     delta   {text}                                     文本增量 → 气泡逐字追加
     tool    {tool, args}                               工具开始 → 轨迹实时追加
     command {AgentCommand}                             工具执行即下发 → 边说边动
     error   {error}                                    异常
     done    {reply, commands, tools, model}            收尾（最终全文 + 指令汇总）
  → 浏览器按序应用并回流外层：
     set_intent → sim.patchEnv()          [意图入 env]
     command   → 合成 decision → avatar 执行 → perceive(agent_action)
                 → sim.noteAction(motion, expression, 'pi')  [行为状态入 env]
     trigger_event → sim.triggerEvent()   [事件入 env]
     回复文本 → perceive(agent_reply)      [交互摘要入 env]
```

**行为回环（状态账本统一）**：无论行为来自外层 Jev 决策（`jev-loop`）、消息快反射（`jev-route`）还是慢思考指令（`pi`），执行后都经 `sim.noteAction()` 写入 `env.currentAction`（当前动作/表情/来源/起始时间）与 `env.recentActions`（最近 5 条历史）。外层循环每轮决策都能看到"我此刻在做什么、做了多久、谁发起的"，实现真正的持续感知-决策-执行链。

### 记忆回环（记忆即工具 + idle 自整理）

**整理也是动作**：`consolidate`（整理记忆）作为动作选项进入 Jev 决策空间，与身体动作、说话同台打分。
**记忆即工具**：记忆文件（`data/memory/*.md`）由 Agent 自己读写、自己组织——服务端只提供存储与索引，没有写死的提炼流程。

```
感知入环：对话/动作/情景 → sim.perceive() → env（socialDrive / recentInteraction /
          memoryDirty / recentDialogue 最近3轮工作记忆）
    │
    ├─ 服务端情景记忆（data/episodes.jsonl，追加写）
    │    用户消息 / Pi 回复 / 身体动作 / 场景事件 自动入档
    │    服务重启 → 近 30 条对话回放为 Agent 消息（Pi 无缝续聊）
    │
    ├─ 记忆文件（data/memory/*.md，Agent 自管）
    │    system prompt 预加载记忆索引（文件名 + 标题 + 更新时间）
    │    read_memory 按需细读 · write_memory 自主增写（读写后索引自动刷新）
    │
    └─ memoryDirty=true + intent=idle + 没在对话中
         → Jev 决策 consolidate（60s 防抖 + 防重入 + 对话优先）
         → 机器人静立沉思（idle + 0 强度）
         → POST /api/agent/consolidate：向主 Agent 发起"独处整理"内心活动
              Agent 自主：read_recent_episodes 回顾经历 → read_memory 对照旧记忆
              → write_memory 增量写入合适的记忆文件（记什么/记哪/怎么组织由它决定）
         → env.memoryDirty=false · 💭 气泡展示 Agent 自己的整理小结
```

效果：与机器人聊几句后等它闲下来，它会"自己想一想"，把值得记的东西写进自己的记忆文件；重启服务后它仍然记得你的偏好（例如"用户最喜欢的音乐是电子舞曲"），并在后续对话中自然体现。

### 模块说明

| 模块 | 职责 |
|---|---|
| `src/main.ts` | 装配根：场景/相机/渲染循环，panel ↔ sim ↔ avatar 接线，智能体指令应用，数字人切换（GLB 按包围盒归一化身高、脚底贴地） |
| `src/loop.ts` | `Simulation`：环境状态、能量漂移、定时步进决策、置信度门控、`patchEnv` 意图修正、感知入环 `perceive`、行为回流 `noteAction`（内/外层行为统一账本）、整理执行链 `handleConsolidate` |
| `src/jev/decision-engine.ts` | 唯一真实引擎 `RealJevEngine`（LocalMockEngine 已移除）；失败上抛，由调用方以 `idle` 兜底 |
| `src/jev/semantics.ts` | 核心抽象：`buildQuestions` / `buildState` / `normalizeDecision`，两种引擎共用同一 schema |
| `src/jev/jev-client.ts` | 纯 HTTP 客户端，超时与错误处理，不含 UI 逻辑 |
| `src/ui/panel.ts` | 纯 DOM 组件：事件绑定、回调上抛、决策可视化 |
| `src/ui/chat.ts` | 对话舱组件：健康检查、消息收发、SSE 流式解析（逐字显示 + 实时指令）、工具轨迹渲染 |
| `src/avatar/gltf-avatar.ts` | 执行器：GLB 加载、动画剪辑模糊匹配、crossfade 切换、morph 表情 |
| `server/pi-agent-server.ts` | Pi Agent 单例 + Vite 插件：模型解析（DeepSeek 优先）、请求串行化、SSE 流式对话、记忆整理端点（发起"独处整理"内心活动） |
| `server/tools.ts` | Agent 工具集（第一人称）：4 个身体能力（感知/立心意/表演/设情景）+ 3 个记忆能力（读记忆/写记忆/回顾情景流水） |
| `server/memory-store.ts` | 记忆存储：情景记忆（episodes.jsonl，追加写）+ 记忆文件目录（data/memory/*.md）+ 记忆索引 |

## 使用说明

1. **启动循环**：点击右上角 `▶ 启动循环`，数字人开始按决策间隔自主决策（System One）
2. **对话指挥（主交互）**：右侧面板对话区用自然语言和机器人聊天，例如：
   - "欢迎一下我" → Pi 调用 `command_robot(wave, happy)` 直接执行
   - "跳个舞庆祝一下" → `command_robot(dance, happy)` + `trigger_scene_event(celebrate)`
   - "前方有障碍物怎么办" → `set_robot_intent(避障)`，后续 Jev 循环自主决策避让
   - "记住哦，我最喜欢的音乐是电子舞曲" → 对话入情景记忆，闲时自动整理为长期记忆
   - "休息一下吧，把刚才的事记一下" → 消息路由可触发 `consolidate` 整理记忆
3. **记忆自整理**：启动循环后，机器人闲下来（idle + 有未整理记忆）会自主 `consolidate`——
   静立沉思、提炼长期记忆，对话面板以 💭 气泡展示整理结果；重启 dev server 后对话无缝续聊
4. **参数设置**：点击右上角 `⚙ 参数设置` 打开弹窗——
   决策间隔（800–6000ms）、置信度门控阈值（0–0.95）、数字人类型、骨骼调试
5. **决策 · 状态总览**：面板底部紧凑展示引擎/置信度/门控/朝向 + 动作概率条 +
   意图/距离/能量/障碍；`感知状态与决策历史` 可展开查看原始 JSON 与历史
6. **切换数字人**：设置弹窗中 `真实·机器人`（RobotExpressive）/ `真实·Xbot`
7. **骨骼调试**：设置弹窗中 `显示骨骼` 叠加 SkeletonHelper；`重置绑定姿态` 复位动画

## 目录结构

```
jev-robot-digital-human/
├── index.html              # 页面骨架 + 控制面板 + 对话舱
├── vite.config.ts          # Vite 配置 + Jev 代理 + Pi 智能体插件
├── tsconfig.json           # TypeScript 配置（bundler 解析）
├── .env                    # TYPESAFE_API_KEY / LLM_API_KEY 等
├── public/models/          # RobotExpressive.glb / Xbot.glb
├── server/
│   ├── pi-agent-server.ts  # Pi 智能体（System Two · DeepSeek）+ 记忆整理端点
│   ├── tools.ts            # Agent 工具集（4 身体能力 + 3 记忆能力，第一人称）
│   └── memory-store.ts     # 记忆存储（episodes.jsonl / memory/*.md / 记忆索引）
├── data/                   # 记忆持久化（.gitignore，运行时自动创建）
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
