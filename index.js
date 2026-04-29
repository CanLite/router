const express = require("express");
const { createClient } = require("redis");
const { Pool } = require("pg");
const httpProxy = require("http-proxy");
const path = require("path");
const http = require("http");
const rateLimit = require("express-rate-limit");
require("dotenv").config();

const PORT = Number(process.env.PORT) || 9091;
const REDIS_ROUTE_PREFIX = "routes:";
const ROUTE_TTL_SECONDS = 60 * 60 * 24;
const INTERNAL_ROUTES = {
  "/canlite": "http://127.0.0.1:9909",
  "/brunyixl": "http://127.0.0.1:6457"
};
const BLOCKED_PATHS = [
  "/wp-admin",
  "/phpmyadmin",
  "/.env",
  "/.git",
  "/xmlrpc.php"
];
const NEW_SITE_PAGE = path.join(__dirname, "new.html");

const redis = createClient();
redis.on("error", (err) => {
  console.error("Redis error:", err.message);
});

redis.connect().catch((err) => {
  console.error("Redis connect error:", err.message);
});

const pg = new Pool({
  user: process.env.PGUSER || "postgres",
  host: process.env.PGHOST || "localhost",
  database: process.env.PGDATABASE || "routes",
  password: process.env.PASSWORD,
  port: Number(process.env.PGPORT) || 5432
});

pg.on("error", (err) => {
  console.error("Postgres pool error:", err.message);
});

const app = express();
app.set("trust proxy", 1);

const proxy = httpProxy.createProxyServer({
  ws: true,
  changeOrigin: true,
  xfwd: true,
  proxyTimeout: 15000,
  timeout: 15000
});

function normalizeHostHeader(hostHeader) {
  if (!hostHeader || typeof hostHeader !== "string") {
    return null;
  }

  const trimmed = hostHeader.trim().toLowerCase();

  if (!trimmed || trimmed.length > 255) {
    return null;
  }

  let normalized = trimmed;

  if (normalized.startsWith("[")) {
    const closingIndex = normalized.indexOf("]");

    if (closingIndex === -1) {
      return null;
    }

    normalized = normalized.slice(1, closingIndex);
  } else {
    const colonIndex = normalized.indexOf(":");

    if (colonIndex !== -1) {
      normalized = normalized.slice(0, colonIndex);
    }
  }

  normalized = normalized.replace(/\.$/, "");

  if (!normalized || !normalized.includes(".")) {
    return null;
  }

  if (!/^[a-z0-9.-]+$/.test(normalized)) {
    return null;
  }

  return normalized;
}

function rewriteRequestUrl(req, newPath) {
  const queryIndex = req.url.indexOf("?");
  const query = queryIndex === -1 ? "" : req.url.slice(queryIndex);
  req.url = newPath + query;
}

async function safeRedisGet(key) {
  if (!redis.isReady) {
    return null;
  }

  try {
    return await redis.get(key);
  } catch (err) {
    console.error("Redis get error:", err.message);
    return null;
  }
}

async function safeRedisExpire(key, ttlSeconds) {
  if (!redis.isReady) {
    return;
  }

  try {
    await redis.expire(key, ttlSeconds);
  } catch (err) {
    console.error("Redis expire error:", err.message);
  }
}

async function safeRedisSet(key, value, ttlSeconds) {
  if (!redis.isReady) {
    return;
  }

  try {
    await redis.set(key, value, { EX: ttlSeconds });
  } catch (err) {
    console.error("Redis set error:", err.message);
  }
}

async function persistRoute(host, target) {
  const results = await Promise.allSettled([
    safeRedisSet(REDIS_ROUTE_PREFIX + host, target, ROUTE_TTL_SECONDS),
    pg.query(
      "INSERT INTO routestable (url, target_route) VALUES ($1, $2) ON CONFLICT (url) DO NOTHING",
      ["https://" + host, target]
    )
  ]);

  if (results[1].status === "rejected") {
    console.error("Route persistence error:", results[1].reason);
  }
}

async function loadRouteTarget(host, requestPath) {
  const routeCacheKey = REDIS_ROUTE_PREFIX + host;
  const cachedTarget = await safeRedisGet(routeCacheKey);

  if (cachedTarget) {
    void safeRedisExpire(routeCacheKey, ROUTE_TTL_SECONDS);
    return { target: cachedTarget, source: "cache" };
  }

  const result = await pg.query(
    "SELECT target_route FROM routestable WHERE url = $1",
    ["https://" + host]
  );

  if (result.rowCount > 0) {
    const target = result.rows[0].target_route;
    void safeRedisSet(routeCacheKey, target, ROUTE_TTL_SECONDS);
    return { target, source: "database" };
  }

  const internalTarget = INTERNAL_ROUTES[requestPath];

  if (internalTarget) {
    await persistRoute(host, internalTarget);
    return {
      target: internalTarget,
      source: "internal",
      rewritePathToRoot: true
    };
  }

  return null;
}

function sendBadGateway(res) {
  if (!res || res.headersSent) {
    return;
  }

  res.status(502).type("text/plain").send("Bad Gateway: Unable to reach target server");
}

/*
--------------------------------
Rate Limiting
--------------------------------
*/

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false
});

app.use(limiter);

/*
--------------------------------
Basic Bot Filtering
--------------------------------
*/

app.use((req, res, next) => {
  const requestPath = req.path.toLowerCase();

  if (BLOCKED_PATHS.some((blockedPath) => requestPath.startsWith(blockedPath))) {
    return res.status(404).end();
  }

  const userAgent = req.headers["user-agent"];

  if (!userAgent || userAgent.length < 5) {
    return res.status(403).end();
  }

  next();
});

/*
--------------------------------
Router
--------------------------------
*/

app.use(async (req, res) => {
  const host = normalizeHostHeader(req.headers.host);

  if (!host) {
    return res.status(400).end();
  }

  try {
    const route = await loadRouteTarget(host, req.path);

    if (!route) {
      return res.sendFile(NEW_SITE_PAGE);
    }

    if (route.rewritePathToRoot) {
      rewriteRequestUrl(req, "/");
    }

    proxy.web(req, res, { target: route.target });
  } catch (err) {
    console.error("HTTP routing error:", err);
    sendBadGateway(res);
  }
});

/*
--------------------------------
Server
--------------------------------
*/

const server = http.createServer(app);

/*
--------------------------------
WebSocket Proxy
--------------------------------
*/

server.on("upgrade", async (req, socket, head) => {
  const host = normalizeHostHeader(req.headers.host);

  if (!host) {
    socket.destroy();
    return;
  }

  try {
    const route = await loadRouteTarget(host, req.url.split("?")[0]);

    if (!route) {
      socket.destroy();
      return;
    }

    if (route.rewritePathToRoot) {
      rewriteRequestUrl(req, "/");
    }

    proxy.ws(req, socket, head, { target: route.target });
  } catch (err) {
    console.error("WebSocket routing error:", err);
    socket.destroy();
  }
});

/*
--------------------------------
Proxy Errors
--------------------------------
*/

proxy.on("error", (err, req, res) => {
  console.error("Proxy error:", err.message);

  // http-proxy uses the same error event for HTTP and WebSocket flows.
  // For WebSocket failures the third argument is the raw socket, not a
  // ServerResponse, so guard the HTTP response path explicitly.
  if (res && typeof res.writeHead === "function" && !res.headersSent) {
    sendBadGateway(res);
    return;
  }

  if (res && typeof res.destroy === "function") {
    res.destroy();
  }
});

server.on("error", (err) => {
  console.error("Server error:", err.message);
});

/*
--------------------------------
Shutdown
--------------------------------
*/

let isShuttingDown = false;

async function shutdown(signal) {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  console.log(`Received ${signal}, shutting down`);

  server.close(() => {
    console.log("HTTP server closed");
  });

  await Promise.allSettled([
    redis.isOpen ? redis.quit() : Promise.resolve(),
    pg.end()
  ]);

  process.exit(0);
}

["SIGINT", "SIGTERM"].forEach((signal) => {
  process.on(signal, () => {
    void shutdown(signal);
  });
});

process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
});

/*
--------------------------------
Start Server
--------------------------------
*/

server.listen(PORT, () => {
  console.log(`Proxy forwarding server listening on port ${PORT}`);
});
