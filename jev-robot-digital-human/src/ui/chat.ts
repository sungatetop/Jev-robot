/**
 * 对话界面：用户 ↔ Pi 慢思考智能体（System Two）。
 *
 * 用户消息 POST /api/agent/chat，服务端 Pi Agent（带机器人控制工具）
 * 思考并执行工具后返回 { reply, commands, tools }；
 * commands 由外部回调应用到 Simulation/Avatar。
 */
import type { AgentCommand, EnvState, DecisionPayload } from '../jev/types.js';

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
  private dock!: HTMLElement;

  constructor(opts: ChatPanelOptions) {
    this.opts = opts;
  }

  bind(): void {
    this.dock = document.getElementById('chat-dock') as HTMLDivElement;
    this.body = document.getElementById('chat-body') as HTMLDivElement;
    this.input = document.getElementById('chat-text') as HTMLInputElement;
    this.status = document.getElementById('chat-status')!;
    const form = document.getElementById('chat-form') as HTMLFormElement;
    const collapseBtn = document.getElementById('chat-collapse') as HTMLButtonElement;

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = this.input.value.trim();
      if (!text || this.busy) return;
      this.input.value = '';
      void this.send(text);
    });

    collapseBtn.addEventListener('click', () => {
      this.dock.classList.toggle('collapsed');
      collapseBtn.textContent = this.dock.classList.contains('collapsed') ? '▢' : '–';
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

  private async send(text: string): Promise<void> {
    this.busy = true;
    this._append('user', text);
    const pending = this._append('assistant', '思考中…');
    this.body.scrollTop = this.body.scrollHeight;
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
      if (trace) {
        const t = document.createElement('div');
        t.className = 'chat-trace';
        t.textContent = trace;
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
