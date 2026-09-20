/**
 * 对话界面：用户 ↔ Pi 慢思考智能体（System Two）。
 * 静态嵌入右侧面板（主交互区）。用户消息 POST /api/agent/chat，
 * 服务端 Pi Agent（带机器人能力工具）思考并执行后返回 { reply, commands, tools }；
 * commands 由外部回调应用到 Simulation/Avatar。
 */
import { MOTION_LABEL } from '../jev/semantics.js';
import type { AgentCommand, EnvState, DecisionPayload, RobotDecision } from '../jev/types.js';

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
  /** Jev 消息响应决策：「回复(慢思考)」与直接身体动作同台竞争，选中谁执行谁 */
  decideMessage: (env: EnvState, message: string) => Promise<RobotDecision>;
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

  private _routeTrace(route: RobotDecision, toSlowThinking: boolean): string {
    const label = MOTION_LABEL[route.motion] || route.motion;
    const conf = route.confidence != null ? ` (${(route.confidence * 100).toFixed(0)}%)` : '';
    const engine = route.engine === 'jev' ? '真实 Jev' : '本地 Jev';
    const lines = [`🧭 ${engine} 响应决策: ${label}${conf}`];
    if (route.probabilities) {
      const top = Object.entries(route.probabilities)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([k, v]) => `${(MOTION_LABEL[k] || k).split(' ')[0]} ${(v * 100).toFixed(0)}%`);
      lines.push(`概率: ${top.join(' / ')}`);
    }
    lines.push(toSlowThinking ? '→ 唤醒慢思考（Pi）' : '→ 快反射直接执行，未唤醒慢思考');
    return lines.join('\n');
  }

  private async send(text: string): Promise<void> {
    this.busy = true;
    this._append('user', text);

    // ① Jev 消息响应决策：「回复(说话)」与身体动作同台竞争
    const pending = this._append('assistant', 'Jev 感知中…');
    this.body.scrollTop = this.body.scrollHeight;
    let route: RobotDecision | null = null;
    try {
      route = await this.opts.decideMessage(this.opts.getEnv(), text);
    } catch {
      route = null; // 决策不可用 → 默认走慢思考，保证对话不中断
    }

    // ② 快反射：Jev 选中身体动作 → 直接执行，不调用 LLM
    if (route && route.motion !== 'reply') {
      const label = MOTION_LABEL[route.motion] || route.motion;
      pending.bubble.textContent = `（Jev 快反射 · ${label}）`;
      const t = document.createElement('div');
      t.className = 'chat-trace';
      t.textContent = this._routeTrace(route, false);
      pending.root.appendChild(t);
      this.opts.applyCommand({
        type: 'command',
        motion: route.motion,
        expression: route.expression,
        intensity: route.intensity,
        lookAtUser: route.lookAtUser,
        engine: route.engine,
      });
      this.busy = false;
      this.body.scrollTop = this.body.scrollHeight;
      return;
    }

    // ③ 慢思考：Jev 选中「回复」→ 唤醒 Pi Agent
    pending.bubble.textContent = '思考中…';
    const routeLine = route
      ? this._routeTrace(route, true) + '\n'
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
