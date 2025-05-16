import express from 'express';
import { createClient } from 'redis';
import { Pool } from 'pg';
import httpProxy from 'http-proxy';
import http from 'http';
import compression from 'compression';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

// Configuration
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 9091;
const REDIS_TTL = 3600;
const FALLBACK_HTML = path.join(__dirname, 'new.html');

// Path-based overrides
const pathOverrides = {
  canlite: 'http://127.0.0.1:6676',
  brunyixl: 'http://127.0.0.1:6457',
};

// Initialize Redis and Postgres
const redisClient = createClient();
redisClient.connect().catch(() => {});

const pgPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
});

const proxy = httpProxy.createProxyServer({ ws: true, changeOrigin: true });

// Express setup
const app = express();
app.disable('x-powered-by');
app.use(compression());

// Resolve proxy target
async function resolveTarget(host, requestPath) {
  const cacheKey = `routes:${host}`;
  let target = await redisClient.get(cacheKey);
  if (target) return target;

  const url = `https://${host}`;
  const { rows } = await pgPool.query(
    'SELECT target_route FROM routestable WHERE url = $1 LIMIT 1',
    [url]
  );

  if (rows.length) {
    target = rows[0].target_route;
  } else {
    const key = requestPath.replace(/^\//, '');
    target = pathOverrides[key] || null;
  }

  if (target) await redisClient.setEx(cacheKey, REDIS_TTL, target);
  return target;
}

// Proxy handler
async function handleProxy(req, res, isWebSocket = false, socket, head) {
  try {
    const target = await resolveTarget(req.headers.host, req.path);
    if (!target) {
      if (isWebSocket) return socket.destroy();
      return res.sendFile(FALLBACK_HTML);
    }
    if (isWebSocket) proxy.ws(req, socket, head, { target });
    else proxy.web(req, res, { target });
  } catch {
    if (isWebSocket) socket.destroy();
    else res.status(502).end();
  }
}

// Mount proxy for HTTP
app.use((req, res) => handleProxy(req, res));

// Create and run server
const server = http.createServer(app);
server.on('upgrade', (req, socket, head) => handleProxy(req, null, true, socket, head));
server.listen(PORT);
