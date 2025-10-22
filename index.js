const express = require('express');
const createClient = require('redis').createClient;
const RedisStore = require('connect-redis')(require('express-session'));
const { Pool } = require('pg');
const httpProxy = require('http-proxy');
const { fileURLToPath } = require('url');
const path = require('path');
const http = require('http');
const session = require('express-session');
require('dotenv').config();

// Redis and Postgres setup
const redis = createClient();
redis.connect().catch(console.error);

const pg = new Pool({
  user: 'postgres',
  host: 'localhost',
  database: 'routes',
  password: process.env.PASSWORD,
  port: 5432,
});

const app = express();
const routeCache = new Map();

// Express-session with Redis
let redisStore = new RedisStore({
  client: redis,
  prefix: 'router:',
});

app.use(
  session({
    store: redisStore,
    secret: process.env.EXPRESSJSSECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { secure: true },
  })
);

// Cleanup handler for aborted requests
app.use((req, res, next) => {
  req.on('aborted', () => {
    if (!res.writableEnded) res.end();
    if (req.socket && !req.socket.destroyed) req.socket.destroy();
  });
  next();
});

// Proxy setup
const proxy = httpProxy.createProxyServer({
  ws: true,
  changeOrigin: true,
});

// Proxy error and timeout handling
proxy.on('error', (err, req, res) => {
  console.error('Proxy error:', err.message);
  if (res && typeof res.writeHead === 'function' && !res.headersSent) {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('Bad Gateway: Unable to reach target server');
  } else if (res && typeof res.end === 'function') {
    res.end();
  }
});

proxy.on('proxyReq', (pReq) => {
  pReq.setTimeout(10000, () => {
    try {
      pReq.destroy();
    } catch (e) {}
  });
});

// Main router logic
app.use(async (req, res) => {
  const host = req.get('host');

  try {
    let target;
    if (req.session.target) {
      target = req.session.target;
    } else {
      target = routeCache.get(host) || (await redis.get(`routes:${host}`));
      if (target) {
        routeCache.set(host, target);
        await redis.expire(`routes:${host}`, 60 * 60 * 24);
      } else {
        const result = await pg.query(
          'SELECT targetroute FROM routes WHERE domain=$1 LIMIT 1',
          [host]
        );
        if (result.rows.length > 0) {
          target = result.rows[0].targetroute;
          routeCache.set(host, target);
          await redis.set(`routes:${host}`, target, { EX: 60 * 60 * 24 });
        }
      }
    }

    if (!target) {
      res.status(404).send('Domain not found');
      return;
    }

    req.session.target = target;

    proxy.web(req, res, { target });
  } catch (err) {
    console.error('Router error:', err);
    if (!res.headersSent) res.status(500).send('Internal Server Error');
  }
});

// WebSocket upgrade handler
const server = http.createServer(app);

server.on('upgrade', async (req, socket, head) => {
  try {
    const host = req.headers.host;
    let target = routeCache.get(host) || (await redis.get(`routes:${host}`));

    if (!target) {
      const result = await pg.query(
        'SELECT targetroute FROM routes WHERE domain=$1 LIMIT 1',
        [host]
      );
      if (result.rows.length > 0) {
        target = result.rows[0].targetroute;
        routeCache.set(host, target);
        await redis.set(`routes:${host}`, target, { EX: 60 * 60 * 24 });
      }
    }

    if (!target) {
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
      return;
    }

    proxy.ws(req, socket, head, { target });
  } catch (err) {
    console.error('Upgrade error:', err);
    if (!socket.destroyed) socket.destroy();
  }
});

server.listen(8080, () => console.log('Router listening on port 8080'));
