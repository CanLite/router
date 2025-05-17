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

// Create proxy server with timeouts
const proxy = httpProxy.createProxyServer({
  ws: true,
  changeOrigin: true,
  timeout: 30000,        // socket connect timeout
  proxyTimeout: 30000,   // target response timeout
});

// Handle proxy errors without logging
proxy.on('error', (err, req, res) => {
  if (res && !res.headersSent) {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('Bad gateway.');
  } else if (req.socket) {
    req.socket.destroy();
  }
});

// Express setup
const app = express();
app.disable('x-powered-by');
app.use(compression());

// Helper to add a timeout around a promise
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), ms)
    )
  ]);
}

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

  if (target) {
    await redisClient.setEx(cacheKey, REDIS_TTL, target);
  }
  return target;
}

// Proxy handler
async function handleProxy(req, res, isWebSocket = false, socket, head) {
  let target;
  try {
    target = await withTimeout(
        resolveTarget(req.headers.host, req.path),
        2000
    );
  } catch {
    if (res) return res.status(502).end('Bad gateway.');
    if (socket) return socket.destroy();
  }

  if (!target) {
    if (isWebSocket) return socket.destroy();
    return res.sendFile(FALLBACK_HTML);
  }

  if (isWebSocket) {
    proxy.ws(req, socket, head, { target });
  } else {
    proxy.web(req, res, { target });
  }
}

// Mount proxy for HTTP
app.use((req, res) => handleProxy(req, res));

// Create and run server
const server = http.createServer(app);
server.on('upgrade', (req, socket, head) =>
    handleProxy(req, null, true, socket, head)
);
server.listen(PORT);
