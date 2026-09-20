/**
 * 对话界面：用户 ↔ Pi 慢思考智能体（System Two）。
 * 静态嵌入右侧面板（主交互区）。用户消息 POST /api/agent/chat，
 * 服务端 Pi Agent（带机器人能力工具）思考并执行后返回 { reply, commands, tools }；
 * commands 由外部回调应用到 Simulation/Avatar。
 */
import { MOTION_LABEL } from '../jev/semantics.js';
import type { AgentCommand, EnvState, DecisionPayload, MessageResponseDecision } from '../jev/types.js';
import type { PerceptionEvent } from '../loop.js';

export interface ChatPanelOptions {
  getEnv: () => EnvState;
  getLastDecision: () => DecisionPayload | null;
  applyCommand: (cmd: AgentCommand) => void;
  /** Jev 消息响应决策：各动作（含 reply）并行打分，阈值以上同时执行 */
  decideMessage: (env: EnvState, message: string) => Promise<MessageResponseDecision>;
  /** 感知入环：对话中的刺激事件写入感知循环 */
  perceive: (evt: PerceptionEvent) => void;
  /** P3 整理记忆：消息路由选中 consolidate 时触发（返回整理摘要或 null） */
  consolidate: () => Promise<string | null>;
}

interface ChatMessageEl {
  root: HTMLDivElement;
  bubble: HTMLDivElement;
}

export class ChatPanel {
  private opts: ChatPanelOptions;
  private busy = false;
  private body!: HTMLDivElement;
  private input!: HTMLInputElement;
  private status!: HTMLElement;

  constructor(opts: ChatPanelOptions) {
    this.opts = opts;
  }

  bind(): void {
    this.body = document.getElementById('chat-body') as HTMLDivElement;
    this.input = document.getElementById('chat-text') as HTMLInputElement;
    this.status = document.getElementById('chat-status')!;
    const form = document.getElementById('chat-form') as HTMLFormElement;

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = this.input.value.trim();
      if (!text || this.busy) return;
      this.input.value = '';
      void this.send(text);
    });

    void this._checkHealth();
  }

  private async _checkHealth(): Promise<void> {
    try {
      const res = await fetch('/api/agent/health');
      const data = (await res.json()) as { ok?: boolean; model?: string; reason?: string };
      if (data.ok && data.model) {
        this.status.textContent = `● ${data.model}`;
        this.status.className = 'chat-status ok';
      } else {
        this.status.textContent = data.reason || '● 未配置模型';
        this.status.className = 'chat-status warn';
      }
    } catch {
      this.status.textContent = '● 服务不可用';
      this.status.className = 'chat-status warn';
    }
  }

  private _append(role: 'user' | 'assistant', text: string, trace?: string): ChatMessageEl {
    const root = document.createElement('div');
    root.className = `chat-msg ${role}`;
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = text;
    root.appendChild(bubble);
    if (trace) {
      const t = document.createElement('div');
      t.className = 'chat-trace';
      t.textContent = trace;
      root.appendChild(t);
    }
    this.body.appendChild(root);
    this.body.scrollTop = this.body.scrollHeight;
    return { root, bubble };
  }

  /** 路由 trace：并行打分一览 + 执行计划 */
  private _routeTrace(route: MessageResponseDecision, executed: string[]): string {
    const engine = route.engine === 'jev' ? '真实 Jev' : 'Jev 决策';
    const lines = [`🧭 ${engine} 响应决策（并行打分）:`];
    lines.push(
      route.actions
        .map((a) => `${(MOTION_LABEL[a.motion] || a.motion).split(' ')[0]} ${(a.score * 100).toFixed(0)}%${a.trigger ? '✓' : ''}`)
        .join(' · '),
    );
    if (executed.length) lines.push(`→ 执行: ${executed.join(' + ')}`);
    else lines.push('→ 执行: (无)');
    if (route.warning) lines.push(`⚠ ${route.warning}`);
    return lines.join('\n');
  }

  /** 整理记忆等系统注记：以机器人自言自语的气泡呈现（💭） */
  appendNote(text: string): void {
    this._append('assistant', text);
    this.body.scrollTop = this.body.scrollHeight;
  }

  private async send(text: string): Promise<void> {
    this.busy = true;
    this._append('user', text);
    // 感知入环：用户发言作为真实刺激进入感知循环
    this.opts.perceive({ type: 'user_message', text, ts: Date.now() });

    // ① Jev 消息响应决策：各动作（含 reply）并行打分，阈值以上同时执行
    const pending = this._append('assistant', 'Jev 感知中…');
    this.body.scrollTop = this.body.scrollHeight;
    let route: MessageResponseDecision | null = null;
    try {
      route = await this.opts.decideMessage(this.opts.getEnv(), text);
    } catch {
      route = null; // 决策不可用 → 默认走慢思考，保证对话不中断
    }

    // ② 并行执行：触发的身体动作立即做（取最高分），触发 reply 则同时唤醒慢思考，
    //    触发 consolidate 则在独处路径上整理记忆（与说话互斥：要说话就不整理）
    let bodyMotion: string | null = null;
    let wantsReply = false;
    let wantsConsolidate = false;
    if (route) {
      const body = route.triggered.filter((m) => m !== 'reply' && m !== 'consolidate');
      wantsReply = route.triggered.includes('reply');
      wantsConsolidate = route.triggered.includes('consolidate') && !wantsReply;
      if (body.length) {
        bodyMotion = body[0]; // triggered 已按分数降序
        this.opts.applyCommand({
          type: 'command',
          motion: bodyMotion,
          expression: route.expression,
          intensity: route.intensity,
          lookAtUser: route.lookAtUser,
          engine: route.engine,
        });
        // 动作回流感知由 applyCommand → applyAgentCommand 统一处理
      }
    } else {
      wantsReply = true;
    }

    const executed: string[] = [];
    if (bodyMotion) executed.push(MOTION_LABEL[bodyMotion] || bodyMotion);
    if (wantsConsolidate) executed.push('整理记忆');
    if (wantsReply) executed.push('唤醒慢思考');

    // ③a 纯快反射：没有任何说话需求，不调用 LLM
    if (route && !wantsReply && (bodyMotion || wantsConsolidate)) {
      pending.bubble.textContent = `（Jev 快反射 · ${executed.join(' + ')}）`;
      const t = document.createElement('div');
      t.className = 'chat-trace';
      t.textContent = this._routeTrace(route, executed);
      pending.root.appendChild(t);
      // 整理记忆：服务端提炼长期记忆，结果经 appendNote 以 💭 气泡展示
      if (wantsConsolidate) void this.opts.consolidate();
      this.busy = false;
      this.body.scrollTop = this.body.scrollHeight;
      return;
    }

    // ③b 唤醒慢思考：Pi Agent 生成语言回复（SSE 流式：边生成边显示，指令实时执行）
    pending.bubble.textContent = bodyMotion ? '边做动作边想…' : '思考中…';
    const routeLine = route
      ? this._routeTrace(route, executed) + '\n'
      : '🧭 Jev 响应决策不可用 → 默认唤醒慢思考\n';
    try {
      const res = await fetch('/api/agent/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          env: this.opts.getEnv(),
          lastDecision: this.opts.getLastDecision(),
        }),
      });
      if (!res.ok || !res.body) {
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(d.error || `HTTP ${res.status}`);
      }

      // 实时 trace 区（路由行 + 工具行随事件追加）
      const t = document.createElement('div');
      t.className = 'chat-trace';
      t.textContent = routeLine;
      pending.root.appendChild(t);
      const toolLines: string[] = [];
      const renderTrace = () => {
        t.textContent = routeLine + (toolLines.length ? toolLines.join('\n') : '');
      };

      let firstDelta = true;
      let finalModel = '';
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      const handleEvent = (ev: string, data: Record<string, unknown>) => {
        switch (ev) {
          case 'meta':
            finalModel = String(data.model || '');
            break;
          case 'delta': {
            if (firstDelta) {
              pending.bubble.textContent = '';
              firstDelta = false;
            }
            pending.bubble.textContent += String(data.text || '');
            this.body.scrollTop = this.body.scrollHeight;
            break;
          }
          case 'tool': {
            const args = JSON.stringify(data.args ?? {});
            toolLines.push(`🔧 ${String(data.tool)} ${args.length > 120 ? args.slice(0, 120) + '…' : args}`);
            renderTrace();
            this.body.scrollTop = this.body.scrollHeight;
            break;
          }
          case 'command':
            // 边说边动：工具执行即应用指令，不等回复结束
            this.opts.applyCommand(data as unknown as AgentCommand);
            break;
          case 'error':
            throw new Error(String(data.error || 'agent_error'));
          default:
            break;
        }
      };

      // 解析 SSE（POST fetch 无 EventSource，手动读流）
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split('\n\n');
        buf = parts.pop() ?? '';
        for (const part of parts) {
          const lines = part.split('\n');
          const ev = lines.find((l) => l.startsWith('event: '))?.slice(7).trim();
          const dataLine = lines.find((l) => l.startsWith('data: '))?.slice(6);
          if (ev && dataLine) handleEvent(ev, JSON.parse(dataLine) as Record<string, unknown>);
        }
      }

      if (firstDelta) pending.bubble.textContent = '(无文本回复)';
      if (finalModel) {
        this.status.textContent = `● ${finalModel}`;
        this.status.className = 'chat-status ok';
      }
      // 感知入环：Pi 的语言回复也是一次行为
      const full = pending.bubble.textContent;
      if (full && full !== '(无文本回复)') this.opts.perceive({ type: 'agent_reply', summary: full, ts: Date.now() });
    } catch (err) {
      pending.bubble.textContent = '⚠️ ' + (err instanceof Error ? err.message : String(err));
      pending.root.classList.add('err');
    } finally {
      this.busy = false;
      this.body.scrollTop = this.body.scrollHeight;
    }
  }
}
