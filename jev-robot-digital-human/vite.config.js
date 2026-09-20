import { defineConfig, loadEnv } from 'vite';

/**
 * Vite 配置：提供一个 /api/systemone 的服务端代理，把请求转发到
 * TypeSafe 官方端点。API Key 只在服务端读取（.env），不会暴露给浏览器，
 * 同时规避浏览器端跨域(CORS)问题。
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiKey = env.TYPESAFE_API_KEY || '';
  const upstream = env.TYPESAFE_BASE_URL || 'https://api.typesafe.ai';

  const jevProxy = {
    name: 'jev-proxy',
    configureServer(server) {
      server.middlewares.use('/api/systemone', async (req, res) => {
        // 仅处理 POST /api/systemone，其余交给 Vite 继续处理
        if (req.method !== 'POST') return server.middlewares;
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
          res.end(JSON.stringify({ error: `proxy_error: ${err.message}` }));
        }
      });
    },
  };

  return {
    plugins: [jevProxy],
    server: { host: true, port: 5173 },
  };
});