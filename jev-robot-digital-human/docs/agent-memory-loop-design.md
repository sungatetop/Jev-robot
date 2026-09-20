# 设计文档：感知-决策-执行闭环 与 机器人记忆系统

> 状态：**已实施**（P1 感知入环 / P2 记忆存储 / P3 idle 整理 全部完成并验证）
> 范围：jev-robot-digital-human
> 日期：2026-09-20
>
> ⚠️ **实施演进说明**（2026-09-20 定稿）：本文写于设计阶段，最终实施时长期记忆方案有调整——
> 由「服务端 weight 淘汰的 `data/long-term-memory.json`」演进为**「记忆即工具」**：
> 记忆文件存于 `data/memory/*.md`，Agent 经 `read_memory`/`write_memory`/`read_recent_episodes`
> 工具自主读写与组织；服务端（`memory-store.ts`）只提供存储与索引，`/api/agent/consolidate`
> 不再接收 `{since}` 参数（回看范围由 Agent 自主决定）。本文其余内容（P1 感知入环、consolidate
> 动作化、防抖/防重入）均按原设计落地。当前实态以 [architecture.md](./architecture.md) §8 为准。

---

## 1. 现状回答

### 1.1 当前状态是否进入决策判断？

**部分进入。**

| 感知源 | 是否进入决策 | 说明 |
|---|---|---|
| env（intent / userProximity / energy / obstacle） | ✅ | 感知循环每 3.2s → `Simulation.step` → `engine.decide(env)` → Jev |
| 用户消息（刺激） | ❌ | 只走旁路：`decideMessage` → 直接执行，**不写入 env**，循环对"正在对话"无感知 |
| Pi 智能体的动作/事件 | ❌ | `applyCommand` 直接驱动渲染层，不回流到 env |
| 对话发生这一事实本身 | ❌ | `userProximity` 是模拟漂移值，不会因用户说话而变化 |

### 1.2 感知-决策-执行循环现状

闭环骨架已存在：

```
感知(模拟env) → 决策(Jev) → 执行(avatar) → 展示(panel)
       ↑______________________________________|
              （但反馈不回流：执行结果不改变感知）
```

问题：**感知源贫乏且单向**。真实刺激（用户消息、对话、Pi 行为）不进入循环，机器人"健忘"且"无自觉"。

### 1.3 对话历史与记忆现状

- **Pi（慢思考）**：服务端单例 Agent（`agentPromise`），`agent.state.messages` 保留对话历史（>60 条截断为首 2 + 尾 50）。**仅内存**：刷新页面不丢（服务端持有），但**服务重启即失**，且无结构化存储、无长期记忆提取。
- **Jev（快思考）**：完全无状态，每次决策只看当前 env 快照，不知道"刚才聊过什么"。
- **磁盘持久化**：无任何形式。

### 1.4 idle 自整理记忆现状

不存在。idle 只是一个待机动画（AnimationClip），无整理行为。

---

## 2. 目标架构

```
                     ┌──────────────────────────────────────────┐
                     │              记忆系统（服务端）              │
                     │  工作记忆(热) / 情景记忆(全) / 长期记忆(炼)    │
                     └───────────┬──────────────────▲───────────┘
                                 │ 注入              │ 整理写入
┌──────────┐   刺激事件   ┌───────▼──────┐   决策   ┌────┴─────┐   执行   ┌────────┐
│ 用户消息   │──────────▶│  感知层       │────────▶│ 决策层     │────────▶│ 执行层  │
│ Pi 行为   │           │ Perception   │  Jev/Pi │ 决策+路由  │         │ avatar │
│ 场景事件   │           │ Queue + Env  │         │          │         │        │
└──────────┘           └──────────────┘         └──────────┘         └────────┘
                              ▲                                        │
                              └────────── 执行结果回流（反馈）────────────┘
```

核心原则（延续现有设计哲学）：

1. **一切刺激皆感知事件**：用户消息、Pi 行为、场景事件统一进感知层，更新 env。
2. **决策即行为**：说话（reply）、整理记忆（consolidate）都是动作，与身体动作同台打分。
3. **快慢分工**：Jev 高频小决策（无状态 + 工作记忆摘要）；Pi 低频深加工（有完整历史 + 长期记忆）。

---

## 3. 感知层扩展：用户刺激入环

### 3.1 感知事件队列（浏览器端 Simulation）

```ts
// loop.ts 新增
type PerceptionEvent =
  | { type: 'user_message'; text: string; ts: number }     // 用户发言
  | { type: 'agent_action'; motion: string; by: string }   // Pi/Jev 路由执行的动作
  | { type: 'agent_reply'; summary: string; ts: number }   // Pi 说了话
  | { type: 'scene_event'; name: string };                 // 已有场景事件

class Simulation {
  perceive(evt: PerceptionEvent): void   // 入队，下一步 step 前消费
  private applyPerception(evt): void     // 更新 env
}
```

### 3.2 env 扩展（感知状态新增字段）

| 字段 | 含义 | 更新规则 |
|---|---|---|
| `socialDrive: 0..1` | 社交驱动（对话热度） | 用户消息 +0.6，随时间指数衰减（半衰期 ~20s） |
| `userProximity` | 用户距离 | 用户消息时强制拉到 0.2（很近），之后缓慢漂移回模拟值 |
| `recentInteraction` | 最近交互摘要（一句话） | "用户刚问了 X / 我刚跳了舞"，供 Jev 快速理解上下文 |
| `memoryDirty: boolean` | 有未整理的新记忆 | 有新对话/动作后置 true，整理后清除 |

**接入点**（各一处）：

- `chat.ts send()`：发消息时 `sim.perceive({type:'user_message'})`；Pi 回复后 `perceive({type:'agent_reply'})`
- `main.ts applyAgentCommand`：执行 command 后 `sim.perceive({type:'agent_action'})`
- 感知循环下一次 `decide(env)` 自然包含这些刺激 → **对话期间循环决策会主动配合社交情境**（如 proximity 近 → wave/lookAtUser 倾向）

---

## 4. 记忆系统（三层）

### 4.1 分层模型

| 层 | 内容 | 存储 | 生命周期 | 消费者 |
|---|---|---|---|---|
| **工作记忆**（热） | env 快照 + `recentInteraction` + 最近 3 轮对话摘要 | 内存（浏览器 env + 服务端 Agent messages） | 分钟级 | Jev（每次决策）、Pi（每轮对话） |
| **情景记忆**（全量） | 结构化事件流：`{ts, kind, text, actions[], decision?}` | 服务端 `data/episodes.jsonl`（追加写） | 永久（可截断归档） | Pi（整理时读取）、调试面板 |
| **长期记忆**（提炼） | Pi 整理产出：用户偏好、事实、性格塑造条目 `{id, kind: fact/preference/episode, content, weight, ts}` | 服务端 `data/long-term-memory.json` | 永久（weight 衰减淘汰） | Pi system prompt 注入；Jev 经 `recentInteraction` 间接感知 |

### 4.2 服务端记忆模块（新文件 `server/memory-store.ts`）

```ts
// 情景记忆：JSONL 追加，启动时加载近 500 条进内存
appendEpisode(ep: Episode): void
listEpisodes(limit): Episode[]

// 长期记忆：JSON 文件，整理时整体重写
getLongTermMemories(): LongTermMemory[]
mergeLongTermMemories(items: LongTermMemory[]): void   // 按 content 相似去重、weight 更新
```

> 存储选型：**JSON/JSONL 文件**（无数据库依赖，贴合演示项目体量；目录 `jev-robot-digital-human/data/`，加入 .gitignore）。

### 4.3 Pi 会话持久化与记忆注入

- **重启恢复**：服务启动时把 `episodes.jsonl` 中近 30 条对话回放为 `messages`（user/assistant 交替），Agent 无缝续聊。
- **system prompt 注入**：每次构建 systemPrompt 时拼入长期记忆 Top-N（按 weight 排序），Pi"记得"用户偏好与共同经历。
- **截断策略保留**：现有 `transformContext`（首2+尾50）不变，作为硬上限。

---

## 5. idle 自整理记忆（记忆固化行为）

### 5.1 设计哲学：整理也是一种动作

延续「回复也是动作」的原则——**「整理记忆」（consolidate）作为动作选项进入决策空间**：

- **消息响应决策**（`decideMessage`）：动作集增加 `consolidate`（noul 打分）。用户说"休息一下吧/记一下这个/想想刚才"→ 可能触发。
- **感知循环决策**（`decide`）：动作集增加 `consolidate`（choice 选项），Jev 可在闲时自主选择。

触发判据由 Jev 综合：`memoryDirty=true`、`intent=idle`、社交热度低（没在对话中）→ consolidate 得分高。

### 5.2 整理流程（执行链）

```
Jev 决策 consolidate (score 0.82✓)
  → 执行层：机器人做"思考"表现（expression: thinking / 动作 idle + 原地小动作）
  → POST /api/agent/consolidate { since: lastConsolidatedTs }
      Pi（慢思考）读取 episodes 增量 → 提炼长期记忆条目 → merge 写入
      返回：{ added: 3, summary: "记住了用户喜欢舞曲、讨厌被打断" }
  → recentInteraction 更新为整理摘要；memoryDirty=false
  → 对话面板可选展示：💭 "我把刚才的事整理了一下…"
```

### 5.3 防抖规则

- 距上次整理 < 60s → Jev 决策时 consolidate 选项附带"刚整理过"语境（分数自然低）
- 整理期间新消息到达 → 打断整理（Pi 请求可中止），优先对话
- 整理由 **感知循环串行队列** 执行，与用户消息响应互斥（同一时刻机器人只做一件事）

---

## 6. 改动清单（按模块）

| 文件 | 改动 |
|---|---|
| `src/jev/semantics.ts` | Motion 增加 `consolidate`（身体动作集排除之，同 reply）；新增 `recentInteraction`/`socialDrive`/`memoryDirty` 进 EnvState；buildQuestions/buildMessageQuestions 增加对应选项与描述 |
| `src/loop.ts` | Simulation 增加 `perceive()` 事件队列与 `applyPerception`；env 漂移逻辑增加 socialDrive 衰减；step 中 consolidate 决策 → 调用整理执行器 |
| `src/ui/chat.ts` | 发送/回复后 `perceive()`；展示整理结果气泡 |
| `src/main.ts` | applyAgentCommand 后 `perceive()`；接线 consolidate 执行器（fetch /api/agent/consolidate） |
| `server/memory-store.ts` | **新增**：情景/长期记忆读写 |
| `server/pi-agent-server.ts` | 新增 `POST /api/agent/consolidate`；systemPrompt 注入长期记忆；启动回放历史 |
| `data/` | **新增目录**：`episodes.jsonl`、`long-term-memory.json`（gitignore） |
| `index.html`/`panel.ts` | 决策面板"感知状态"区展示 socialDrive / memoryDirty；（可选）记忆查看弹窗 |

---

## 7. 分期实施

| 阶段 | 内容 | 交付验证 |
|---|---|---|
| **P1 感知入环** | perceive 队列 + socialDrive/proximity 联动 | 发消息后，感知循环决策的 env 可见变化（state JSON 面板） |
| **P2 记忆存储** | memory-store + episodes 持久化 + Pi 重启续聊 + 工作记忆注入 Jev | 重启 dev server 后继续对话，Pi 仍记得之前内容 |
| **P3 idle 整理** | consolidate 动作化 + /api/agent/consolidate + 长期记忆注入 | 与机器人聊几句后等待 idle → 机器人自行整理并在后续对话中体现记忆 |

每阶段独立可验证、可回退。

---

## 8. 已确认决策（2026-09-20 与用户确认）

| 决策点 | 结论 |
|---|---|
| 存储选型 | **JSON/JSONL 文件**（`data/episodes.jsonl` + `data/long-term-memory.json`） |
| consolidate 触发 | **Jev 动作化**（整理是动作之一，进入决策空间打分） |
| 记忆范围 | **全局共享**（机器人是一个个体，跨浏览器会话） |
| 实施方式 | **按 P1 → P2 → P3 分期实施**，每阶段独立验证 |
