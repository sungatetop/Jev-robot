# SystemOneModel · 给 AI 一个身体

让大模型拥有一个真实可动的"身体"：以 **双系统决策架构** 驱动 3D 数字人，快思考负责秒级自主行动，慢思考负责自然语言规划与工具调用。

> 本仓库目前包含演示项目 [jev-robot-digital-human](./jev-robot-digital-human)。

## 原理

核心理念：**决策层与执行层彻底解耦，快慢双系统分工**。

```
                 ┌─────────────────────────────┐
   用户对话 ───▶ │  System Two · 慢思考          │
  （自然语言）    │  Pi Agent（DeepSeek）         │
                 │  规划 · 工具调用 · 意图修正      │
                 └──────────────┬──────────────┘
                                │ 低频指令（set_intent / command / event）
                                ▼
                 ┌─────────────────────────────┐
                 │  System One · 快思考          │
                 │  Jev 决策模型（TypeSafe）      │
                 │  感知状态 → 类型化决策          │
                 └──────────────┬──────────────┘
                                │ 高频决策（动作/表情/强度/朝向 + 置信度）
                                ▼
                 ┌─────────────────────────────┐
                 │  执行层 · 3D 数字人            │
                 │  Three.js + GLB 骨骼动画       │
                 └─────────────────────────────┘
```

### 1. System One：Jev 快思考（高频自主决策）

- 决策循环以固定间隔（默认 ~3.2s，可配 800–6000ms）运行：把环境感知状态（意图、用户距离、前方障碍、能量）交给 **Jev 决策模型**，输出**类型化决策**——动作(choice) + 表情(choice) + 强度(score) + 朝向(noul)，附带概率分布与置信度。
- **置信度门控**：置信度低于阈值时强制回退到安全的 `idle` 动作，杜绝低把握的乱动。
- **感知失败兜底**：决策请求失败时以 `idle` 安全动作继续循环，身体永不"卡死"。
- **消息响应也是决策**：收到用户消息时，Jev 对"回复"与各动作并行打分——动作与回复可同时触发（边跳舞边说话），纯动作反射零 LLM 调用。

### 2. System Two：Pi 智能体慢思考（自然语言规划）

- 用户通过对话界面用自然语言指挥机器人，服务端 Pi Agent（默认接入 DeepSeek）按需调用四个机器人工具：
  - `get_robot_state`——读取当前环境/决策状态
  - `set_robot_intent`——修改机器人意图，交由快思考循环自主执行
  - `command_robot`——直接下发动作/表情/强度/朝向
  - `trigger_scene_event`——注入场景事件，触发 Jev 快思考响应
- 指令回到浏览器侧按序安全应用，全程留有工具调用轨迹。

### 3. 关键设计

- **Schema 即契约**：决策的问题/答案/归一化统一在 `semantics.ts` 中定义，决策层只依赖 schema，与渲染完全解耦。
- **Key 安全**：所有 API Key 仅存服务端（Vite 中间件代理），浏览器零接触。
- **执行器归一化**：GLB 模型按包围盒归一化身高、脚底贴地，动画 crossfade 平滑切换、morph 表情，可插拔更换数字人。

## 快速开始

环境要求：Node.js 18+。

```bash
cd jev-robot-digital-human
npm install
npm run dev        # 打开 http://localhost:5173
```

在 `jev-robot-digital-human/.env` 配置密钥：

```bash
# System One：Jev 决策模型
TYPESAFE_API_KEY=your_key

# System Two：Pi 智能体（默认 DeepSeek）
LLM_API_KEY=sk-xxx
LLM_API_BASE=https://api.deepseek.com/v1
```

常用脚本：

```bash
npm run dev         # 开发服务器（含 API 代理与智能体端点）
npm run build       # 生产构建
npm run typecheck   # tsc --noEmit 类型校验
```

## 体验路径

1. 点击右上角 `▶ 启动循环`——数字人开始按 Jev 决策自主行动（System One）。
2. 在右侧对话区用自然语言指挥，例如：
   - "欢迎一下我" → `command_robot(wave, happy)` 直接执行
   - "跳个舞庆祝一下" → 跳舞指令 + 庆祝场景事件
   - "前方有障碍物怎么办" → `set_robot_intent(避障)`，后续循环自主避让
3. 点击 `⚙ 参数设置` 调整决策间隔、置信度门控阈值、切换数字人（RobotExpressive / Xbot）。

## 目录结构

```
SystemOneModel/
└── jev-robot-digital-human/     # 双系统数字人控制演示
    ├── index.html               # 页面骨架 + 控制面板 + 对话区
    ├── vite.config.ts           # Vite 配置 + Jev 代理 + Pi 智能体插件
    ├── server/pi-agent-server.ts# Pi 智能体（System Two · DeepSeek）
    ├── docs/                    # 设计文档（如记忆闭环设计）
    ├── public/models/           # RobotExpressive.glb / Xbot.glb
    └── src/
        ├── main.ts              # 装配根 + 渲染循环 + 指令应用
        ├── loop.ts              # 决策循环 Simulation（System One 步进 + 门控）
        ├── jev/                 # 决策层：引擎 / HTTP 客户端 / schema
        ├── avatar/              # 执行层：GLB 数字人执行器
        └── ui/                  # 控制面板 + 对话舱
```

## License

[MIT](./LICENSE)
