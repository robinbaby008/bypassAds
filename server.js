// Render-compatible Web Service (also runs anywhere with Node 18+).
// Serves the static site (index.html, ShortlinkBypass.user.js) and mounts
// the existing Vercel-style handler in api/bypass.js at /api/bypass,
// so the same repo deploys to Vercel (serverless) or Render (persistent).
//
// Render notes:
// - Bind 0.0.0.0:$PORT (defaults to 10000).
// - keepAliveTimeout > Render proxy idle window (120s) to avoid stalled sockets.

const path = require("path");
const express = require("express");

const bypassHandler = require("./api/bypass.js");

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "16kb" }));

// Health check (use as Render healthCheckPath).
app.get("/health", (req, res) => res.status(200).json({ ok: true }));

// Bypass API — same contract as Vercel: POST { url } / GET ?url=
app.all("/api/bypass", (req, res) => bypassHandler(req, res));

// Static site.
app.use(
  express.static(path.join(__dirname), {
    extensions: ["html"],
    setHeaders(res, filePath) {
      if (filePath.endsWith("ShortlinkBypass.user.js")) {
        res.setHeader("Content-Type", "application/javascript; charset=utf-8");
        res.setHeader("Cache-Control", "public, max-age=3600");
      }
    },
  })
);

const PORT = parseInt(process.env.PORT || "10000", 10);
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`bypassads listening on 0.0.0.0:${PORT}`);
});

// Render proxy guidance: keep-alive longer than the LB idle window.
server.keepAliveTimeout = 120000;
server.headersTimeout = 121000;
