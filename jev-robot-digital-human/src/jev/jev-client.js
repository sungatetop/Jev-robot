/**
 * 真实 Jev HTTP 客户端。
 *
 * 通过 Vite 服务端代理 /api/systemone 转发到 api.typesafe.ai/v1/systemone，
 * 因此浏览器不持有 API Key，也不需要处理 CORS。
 * 响应结构与官方文档一致：{ model, answers, usage }。
 */

import { normalizeDecision, buildQuestions, buildState } from './semantics.js';

export const DEFAULT_FALLBACK = { motion: 'idle', expression: 'neutral', intensity: 1, lookAtUser: false };
const JSON_HEADERS = { 'Content-Type': 'application/json' };

export async function callJev(statePayload, questionsPayload, { timeout = 12000, signal } = {}) {
  const ctrl = signal ? signal : new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch('/api/systemone', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({
        state: statePayload,
        model: 'jev-latest',
        questions: questionsPayload,
      }),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { error: text.slice(0, 300) }; }
    if (!res.ok) {
      throw new Error(`TypeSafe API ${res.status}: ${json.error || text}`);
    }
    return json;
  } catch (err) {
    if (err && err.name === 'AbortError') throw new Error('TypeSafe API timed out');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** 把 Jev 原始响应转换为标准化决策；失败时抛错由上层回退。 */
export async function decideWithRealJev(env, opts) {
  const questions = buildQuestions(env);
  const state = buildState(env);
  const raw = await callJev(state, questions, opts);
  if (!raw || !raw.answers) throw new Error('Empty answers from TypeSafe API');
  return normalizeDecision(raw.answers, DEFAULT_FALLBACK);
}