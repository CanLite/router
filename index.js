const express = require("express");
const { createClient } = require("redis");
const { Pool } = require("pg");
const httpProxy = require("http-proxy");
import { fileURLToPath } from "url";
import { dirname } from "path";
const http = require("http"); // Use http unless you have SSL certs for https
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
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Regular HTTP request proxying
app.use(async (req, res) => {
    const host = req.get("host");
    try {
        let target = await redis.get("routes:" + host);

        if (!target) {
            const result = await pg.query(
                "SELECT target_route FROM routestable WHERE url = $1",
                ["https://" + host]
            );

            if (result.rowCount === 0) {
                if(req.path === "/canlite") {
                    await redis.set("routes:" + host, "http://127.0.0.1:6676");
                } else if (req.path === "/brunyixl") {
                    await redis.set("routes:" + host, "http://127.0.0.1:6457");
                } else {
                    res.sendFile(path.join(__dirname + "app.html"))
                }
            } else {
                target = result.rows[0].target_route;
            }
            await redis.set("routes:" + host, target);
        }

        proxy.web(req, res, { target });
    } catch (err) {
        console.error("Proxy error:", err);
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

server.listen(9091, () => {
    console.log("Proxy forwarding server (HTTP + WebSocket) listening on port 9091");
});
