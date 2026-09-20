/**
 * 真实 Jev HTTP 客户端。
 *
 * 通过 Vite 服务端代理 /api/systemone 转发到 api.typesafe.ai/v1/systemone，
 * 因此浏览器不持有 API Key，也不需要处理 CORS。
 * 响应结构与官方文档一致：{ model, answers, usage }。
 */

import { normalizeDecision, normalizeMessageDecision, buildQuestions, buildMessageQuestions, buildState } from './semantics.js';
import type { EnvState, RobotDecision, JevAnswers, MessageResponseDecision } from './semantics.js';

export const DEFAULT_FALLBACK: RobotDecision = {
  motion: 'idle', expression: 'neutral', intensity: 1, lookAtUser: false,
  confidence: 0, probabilities: null, raw: null,
};
const JSON_HEADERS: Record<string, string> = { 'Content-Type': 'application/json' };

export interface CallOptions {
  timeout?: number;
  signal?: AbortSignal;
}

export async function callJev(
  statePayload: unknown,
  questionsPayload: unknown,
  { timeout = 12000, signal }: CallOptions = {},
): Promise<{ model?: string; answers: JevAnswers; usage?: unknown }> {
  const owned = new AbortController();
  const ctrl = signal ?? owned.signal;
  const timer = setTimeout(() => owned.abort(), timeout);
  try {
    const res = await fetch('/api/systemone', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({
        state: statePayload,
        model: 'jev-latest',
        questions: questionsPayload,
      }),
      signal: ctrl,
    });
    const text = await res.text();
    let json: { error?: string; answers?: JevAnswers };
    try { json = JSON.parse(text); } catch { json = { error: text.slice(0, 300) }; }
    if (!res.ok) {
      throw new Error(`TypeSafe API ${res.status}: ${json.error || text}`);
    }
    return json as { answers: JevAnswers };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw new Error('TypeSafe API timed out');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** 把 Jev 原始响应转换为标准化决策；失败时抛错由上层回退。 */
export async function decideWithRealJev(env: EnvState, opts?: CallOptions): Promise<RobotDecision> {
  const questions = buildQuestions(env);
  const state = buildState(env);
  const raw = await callJev(state, questions, opts);
  if (!raw || !raw.answers) throw new Error('Empty answers from TypeSafe API');
  return normalizeDecision(raw.answers, DEFAULT_FALLBACK);
}

/**
 * 用户消息响应决策：每个动作（含 reply「说话」）独立 noul 打分，
 * 阈值以上同时执行（如边挥手边回复）。失败抛错由上层回退本地。
 */
export async function decideMessageWithRealJev(
  env: EnvState,
  message: string,
  opts?: CallOptions,
): Promise<MessageResponseDecision> {
  const questions = buildMessageQuestions(env, message);
  const state = { ...buildState(env), userMessage: message };
  const raw = await callJev(state, questions, opts);
  if (!raw || !raw.answers) throw new Error('Empty answers from TypeSafe API');
  return normalizeMessageDecision(raw.answers as JevAnswers, {
    expression: 'happy',
    intensity: 1,
    lookAtUser: true,
  });
}
