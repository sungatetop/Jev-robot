/**
 * 对话界面：用户 ↔ Pi 慢思考智能体（System Two）。
 * 静态嵌入右侧面板（主交互区）。用户消息 POST /api/agent/chat，
 * 服务端 Pi Agent（带机器人能力工具）思考并执行后返回 { reply, commands, tools }；
 * commands 由外部回调应用到 Simulation/Avatar。
 */
import { MOTION_LABEL } from '../jev/semantics.js';
import type { AgentCommand, EnvState, DecisionPayload, MessageResponseDecision } from '../jev/types.js';

interface AgentChatResponse {
  reply?: string;
  commands?: AgentCommand[];
  tools?: Array<{ tool: string; args?: unknown }>;
  model?: string;
  error?: string;
}

export interface ChatPanelOptions {
  getEnv: () => EnvState;
  getLastDecision: () => DecisionPayload | null;
  applyCommand: (cmd: AgentCommand) => void;
  /** Jev 消息响应决策：各动作（含 reply）并行打分，阈值以上同时执行 */
  decideMessage: (env: EnvState, message: string) => Promise<MessageResponseDecision>;
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

  private _appendToolTrace(tools: Array<{ tool: string; args?: unknown }>): string {
    if (!tools.length) return '';
    return tools.map((t) => `🔧 ${t.tool} ${JSON.stringify(t.args ?? {})}`).join('\n');
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

  private async send(text: string): Promise<void> {
    this.busy = true;
    this._append('user', text);

    // ① Jev 消息响应决策：各动作（含 reply）并行打分，阈值以上同时执行
    const pending = this._append('assistant', 'Jev 感知中…');
    this.body.scrollTop = this.body.scrollHeight;
    let route: MessageResponseDecision | null = null;
    try {
      route = await this.opts.decideMessage(this.opts.getEnv(), text);
    } catch {
      route = null; // 决策不可用 → 默认走慢思考，保证对话不中断
    }

    // ② 并行执行：触发的身体动作立即做（取最高分），触发 reply 则同时唤醒慢思考
    let bodyMotion: string | null = null;
    let wantsReply = false;
    if (route) {
      const body = route.triggered.filter((m) => m !== 'reply');
      wantsReply = route.triggered.includes('reply');
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
      }
    } else {
      wantsReply = true;
    }

    const executed: string[] = [];
    if (bodyMotion) executed.push(MOTION_LABEL[bodyMotion] || bodyMotion);
    if (wantsReply) executed.push('唤醒慢思考');

    // ③a 纯快反射：没有任何说话需求，不调用 LLM
    if (route && !wantsReply && bodyMotion) {
      pending.bubble.textContent = `（Jev 快反射 · ${executed.join(' + ')}）`;
      const t = document.createElement('div');
      t.className = 'chat-trace';
      t.textContent = this._routeTrace(route, executed);
      pending.root.appendChild(t);
      this.busy = false;
      this.body.scrollTop = this.body.scrollHeight;
      return;
    }

    // ③b 唤醒慢思考：Pi Agent 生成语言回复（动作已并行执行）
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
      const data = (await res.json()) as AgentChatResponse;
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

      pending.bubble.textContent = data.reply || '(无文本回复)';
      const trace = this._appendToolTrace(data.tools || []);
      const fullTrace = routeLine + trace;
      if (fullTrace.trim()) {
        const t = document.createElement('div');
        t.className = 'chat-trace';
        t.textContent = fullTrace;
        pending.root.appendChild(t);
      }
      for (const cmd of data.commands || []) this.opts.applyCommand(cmd);
      if (data.model) {
        this.status.textContent = `● ${data.model}`;
        this.status.className = 'chat-status ok';
      }
    } catch (err) {
      pending.bubble.textContent = '⚠️ ' + (err instanceof Error ? err.message : String(err));
      pending.root.classList.add('err');
    } finally {
      this.busy = false;
      this.body.scrollTop = this.body.scrollHeight;
    }
  }
}
