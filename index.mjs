import express from 'express';
import { createClient } from 'redis';
import { Pool } from 'pg';
import httpProxy from 'http-proxy';
import http from 'http';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

// Constants & Config
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 9091;
const REDIS_TTL = 3600; // seconds
const FALLBACK_HTML = path.join(__dirname, 'new.html');

// Default route overrides (host->path mapping)
const pathOverrides = {
  canlite: 'http://127.0.0.1:6676',
  brunyixl: 'http://127.0.0.1:6457',
};

// Initialize clients
const redisClient = createClient();
redisClient.connect().catch(console.error);

const pgPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
});

const proxy = httpProxy.createProxyServer({ ws: true, changeOrigin: true });

// Express setup
const app = express();
app.disable('x-powered-by');
app.use(helmet());
app.use(compression());
app.use(morgan('combined'));

// Helper: resolve target for host & path
async function resolveTarget(host, requestPath) {
  const cacheKey = `routes:${host}`;
  let target = await redisClient.get(cacheKey);
  if (target) return target;

  // Database lookup
  const url = `https://${host}`;
  const { rows } = await pgPool.query(
    'SELECT target_route FROM routestable WHERE url = $1 LIMIT 1',
    [url]
  );

  if (rows.length) {
    target = rows[0].target_route;
  } else {
    // path-based override
    const key = requestPath.replace(/^\//, '');
    if (pathOverrides[key]) {
      target = pathOverrides[key];
    }
  }

  if (target) {
    await redisClient.setEx(cacheKey, REDIS_TTL, target);
  }
  return target;
}

// Proxy handler for HTTP and WS
async function handleProxy(req, res, isWebSocket = false, socket, head) {
  try {
    const host = req.headers.host;
    const target = await resolveTarget(host, req.path);
    if (!target) {
      if (isWebSocket) {
        return socket.destroy();
      }
      return res.sendFile(FALLBACK_HTML);
    }

    if (isWebSocket) {
      proxy.ws(req, socket, head, { target });
    } else {
      proxy.web(req, res, { target });
    }
  } catch (err) {
    console.error('Proxy error:', err);
    if (isWebSocket) socket.destroy();
    else res.status(502).send('Bad Gateway');
  }
}

// Mount HTTP proxy on all routes
app.use((req, res) => handleProxy(req, res));

// Create HTTP server
const server = http.createServer(app);

// WebSocket upgrade
server.on('upgrade', (req, socket, head) => {
  handleProxy(req, null, true, socket, head);
});

// Start server
server.listen(PORT, () => {
  console.log(`Proxy server listening on port ${PORT}`);
});
