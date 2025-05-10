const express = require("express");
const { createProxyMiddleware } = require("http-proxy-middleware");
const { createClient } = require("redis");
const { Pool } = require("pg");
const fs = require("fs");
const https = require("https");

const redis = createClient();
redis.connect().catch(console.error);

const pg = new Pool({
    user: "postgres",
    host: "localhost",
    database: "routes",
    password: process.env.PASSWORD,
    port: 5432,
});

console.log(pg)

const app = express();

app.use(async (req, res, next) => {
    const path = req.path;
    console.log(path);

    try {
        let target = await redis.get("routes:" + path);

        if (!target) {
            const result = await pg.query(
                "SELECT target_route FROM routes WHERE url = $1",
                [path]
            );

            if (result.rowCount === 0) {
                return res.status(404).send("Not found");
            }

            target = result.rows[0].target_route;

            await redis.set("routes:" + path, target);
        }

        return createProxyMiddleware({
            target,
            changeOrigin: true,
            pathRewrite: (pathReq) => pathReq,
        })(req, res, next);
    } catch (err) {
        console.error("Proxy error:", err);
        res.status(500).send("Internal server error");
    }
});

https.createServer(app).listen(9090, () => {
    console.log("Proxy forwarding server listening on port 9090");
});
