const express = require("express");
const { createClient } = require("redis");
const { Pool } = require("pg");
const httpProxy = require("http-proxy");
const path = require("path");
const http = require("http");
const rateLimit = require("express-rate-limit");
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

const proxy = httpProxy.createProxyServer({ ws: true, changeOrigin: true });

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

const blockedPaths = [
  "/wp-admin",
  "/phpmyadmin",
  "/.env",
  "/.git",
  "/xmlrpc.php"
];

app.use((req, res, next) => {

  // Block common scan paths
  if (blockedPaths.some(p => req.path.startsWith(p))) {
    return res.status(404).end();
  }

  // Require user agent
  const ua = req.headers["user-agent"];
  if (!ua || ua.length < 5) {
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

  const host = req.headers.host;

  if (!host || host.length > 255 || !host.includes(".")) {
    return res.status(400).end();
  }

  try {

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
          req.path = "/"
        }
        else if (req.path === "/brunyixl") {
          target = "http://127.0.0.1:6457";
          req.path = "/"
        }
        else {
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

    proxy.web(req, res, { target });

  } catch (err) {

    console.error(err);
    res.status(500).send("Internal server error");

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

  const host = req.headers.host;

  if (!host || !host.includes(".")) {
    socket.destroy();
    return;
  }

  try {

    let target = await redis.get("routes:" + host);

    if (!target) {

      const result = await pg.query(
          "SELECT target_route FROM routestable WHERE url = $1",
          ["https://" + host]
      );

      if (result.rowCount === 0) {
        socket.destroy();
        return;
      }

      target = result.rows[0].target_route;

      await redis.set("routes:" + host, target, {
        EX: 60 * 60 * 24
      });

    }

    proxy.ws(req, socket, head, { target });

  } catch (err) {

    console.error("WebSocket proxy error:", err);
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

  if (res && !res.headersSent) {
    res.writeHead(502, { "Content-Type": "text/plain" });
    res.end("Bad Gateway: Unable to reach target server");
  }

});

server.on("error", (err) => {
  console.error("Server error:", err.message);
});

/*
--------------------------------
Start Server
--------------------------------
*/

server.listen(9091, () => {
  console.log("Proxy forwarding server listening on port 9091");
});