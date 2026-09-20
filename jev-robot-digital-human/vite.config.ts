import { defineConfig, loadEnv } from 'vite';
import { piAgentPlugin } from './server/pi-agent-server';

/**
 * Vite 配置：
 * 1. /api/systemone —— TypeSafe Jev 代理（API Key 只在服务端读取，规避 CORS）
 * 2. /api/agent/*   —— Pi 慢思考智能体（System Two），DeepSeek 驱动
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  // Vite 不会把 .env 注入 process.env，这里手动注入，供服务端模块（pi-agent 等）读取
  const ENV_KEYS = [
    'TYPESAFE_API_KEY', 'TYPESAFE_BASE_URL',
    'LLM_API_KEY', 'LLM_API_BASE',
    'DEEPSEEK_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_OAUTH_TOKEN',
    'OPENAI_API_KEY', 'GEMINI_API_KEY', 'PI_AGENT_MODEL',
  ];
  for (const k of ENV_KEYS) {
    if (env[k] && !process.env[k]) process.env[k] = env[k];
  }
  const apiKey = env.TYPESAFE_API_KEY || '';
  const upstream = env.TYPESAFE_BASE_URL || 'https://api.typesafe.ai';

  const jevProxy = {
    name: 'jev-proxy',
    configureServer(server: import('vite').ViteDevServer) {
      server.middlewares.use('/api/systemone', async (req, res) => {
        // 仅处理 POST /api/systemone，其余交给 Vite 继续处理
        if (req.method !== 'POST') return;
        try {
          let body = '';
          for await (const chunk of req) body += chunk;
          const upstreamRes = await fetch(`${upstream}/v1/systemone`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
            },
            body,
          });
          const text = await upstreamRes.text();
          res.statusCode = upstreamRes.status;
          res.setHeader('Content-Type', 'application/json');
          res.end(text);
        } catch (err) {
          res.statusCode = 502;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: `proxy_error: ${err instanceof Error ? err.message : String(err)}` }));
        }
      });
    },
  };

  return {
    plugins: [jevProxy, piAgentPlugin()],
    server: { host: true, port: 5173 },
  };
});
