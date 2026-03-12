const express = require("express");
const { createClient } = require("redis");
const { RedisStore } = require("connect-redis");
const { Pool } = require("pg");
const httpProxy = require("http-proxy");
const fileURLToPath = require("url");
const path = require("path");
const http = require("http"); // Use http unless you have SSL certs for https
const session = require("express-session");
require("dotenv").config();

const redis = createClient();
redis.connect().catch(console.error);

const pg = new Pool({
  user: "postgres",
  host: "localhost",
  database: "routes",
  password: process.env.PASSWORD,
  port: 5432,
});

const app = express();

let redisStore = new RedisStore({
  client: redis,
  prefix: "router:",
});

app.use(
    session({
      store: redisStore,
      secret: process.env.EXPRESSJS_SECRET,
      resave: false,
      saveUninitialized: false,
      cookie: { secure: true },
    })
);

const proxy = httpProxy.createProxyServer({ ws: true, changeOrigin: true });

app.use(async (req, res) => {
  const host = req.get("host");
  try {
    if (req.session.target) {
      let e = 'e'
    } else {
      let target = await redis.get("routes:" + host);

      if (target) {
        await redis.expire("routes:" + host, 60 * 60 * 24);
      }

      if (!target) {
        const result = await pg.query(
            "SELECT target_route FROM routestable WHERE url = $1",
            ["https://" + host]
        );

        if (result.rowCount === 0) {
          if (req.path === "/canlite") {
            target = "http://127.0.0.1:9909";
          } else if (req.path === "/brunyixl") {
            target = "http://127.0.0.1:6457";
          } else {
            return res.sendFile(path.join(__dirname + "/new.html"));
          }
        } else {
          target = result.rows[0].target_route;
        }

        await Promise.all([
          redis.set("routes:" + host, target, {
            EX: 60 * 60 * 24
          }),
          pg.query(
              "INSERT INTO routestable (url, target_route) VALUES ($1, $2) ON CONFLICT (url) DO NOTHING",
              ["https://" + host, target]
          )
        ]);
      }
      req.session.target = target;
    }
    let targ = req.session.target;
    proxy.web(req, res, { target: targ });

  } catch (err) {
    console.error(err)
    res.status(500).send("Internal server error");
  }
});

// Create the HTTP server
const server = http.createServer(app);

// WebSocket proxying
server.on("upgrade", async (req, socket, head) => {
  const host = req.headers.host;
  try {
    let target = await redis.get("routes:" + host);

    if (!target) {
      const result = await pg.query(
          "SELECT target_route FROM routestable WHERE url = $1",
          ["https://" + host]
      );

      if (result.rowCount === 0) {
        socket.destroy(); // No route = close the socket
        return;
      }

      target = result.rows[0].target_route;
      await redis.set("routes:" + host, target);
    }

    proxy.ws(req, socket, head, { target });
  } catch (err) {
    console.error("WebSocket proxy error:", err);
    socket.destroy();
  }
});

proxy.on('error', (err, req, res) => {
  console.error('Proxy error:', err.message);
  if (res && typeof res.writeHead === 'function') {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
    }
    res.end('Bad Gateway: Unable to reach target server');
  } else if (res && typeof res.end === 'function') {
    res.end();
  } else {
    // If res is undefined or something else, nothing to do
  }
});

server.on('error', (err, req, res) => {
  console.error('Proxy error:', err.message);
  if (res && typeof res.writeHead === 'function') {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
    }
    res.end('Bad Gateway: Unable to reach target server');
  } else if (res && typeof res.end === 'function') {
    res.end();
  } else {
    // If res is undefined or something else, nothing to do
  }
});

server.listen(9091, () => {
  console.log("Proxy forwarding server (HTTP + WebSocket) listening on port 9091");
});
