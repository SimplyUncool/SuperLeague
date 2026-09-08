"use strict";

require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = Number(process.env.PORT || 3100);
const ROOT = path.join(__dirname, "public");
const startedAt = Date.now();

app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Cache-Control", "no-store");
  next();
});

const services = {
  website: process.env.SL_WEBSITE_URL || "https://superleague.site",
  verification: process.env.SL_VERIFY_HEALTH_URL || "https://verify.superleague.site/health",
  minecraft: process.env.SL_MC_HEALTH_URL || "",
  api: process.env.SL_API_HEALTH_URL || "",
  discord: process.env.SL_DISCORD_HEALTH_URL || ""
};

function jsonFile(name, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, "data", name), "utf8")); }
  catch { return fallback; }
}

app.get("/health", (_req, res) => res.json({ ok: true, service: "superleague-platform", uptime: Math.floor((Date.now() - startedAt) / 1000) }));
app.get("/api/v1", (_req, res) => res.json({ name: "Super League API", version: "v1", status: "scaffold", endpoints: ["/api/v1/teams", "/api/v1/players", "/api/v1/matches", "/api/v1/standings", "/api/v1/health"] }));
app.get("/api/v1/health", (_req, res) => res.json({ ok: true, version: "v1", dataSource: "not wired" }));

for (const resource of ["teams", "players", "matches", "standings"]) {
  app.get(`/api/v1/${resource}`, (_req, res) => {
    const data = jsonFile(`${resource}.json`, []);
    res.json({ data, meta: { source: "placeholder", wired: false } });
  });
}

app.get("/api/v1/roblox/:id", (req, res) => res.status(501).json({ error: "not_wired", message: "Roblox data adapter has not been connected yet.", id: req.params.id }));
app.get("/api/v1/discord/:id", (req, res) => res.status(501).json({ error: "not_wired", message: "Discord data adapter has not been connected yet.", id: req.params.id }));

app.get("/status.json", (_req, res) => res.json({ generatedAt: new Date().toISOString(), services }));

const redirects = (() => {
  try { return JSON.parse(process.env.SL_REDIRECTS_JSON || "{}"); }
  catch { return {}; }
})();
app.get("/go/:key", (req, res) => {
  const target = redirects[req.params.key];
  if (typeof target !== "string" || !/^https:\/\//i.test(target)) return res.status(404).sendFile(path.join(ROOT, "404.html"));
  res.redirect(302, target);
});

function privatePage(name, res) {
  if (process.env.SL_PRIVATE_UI_ENABLED !== "true") return res.status(503).send("Private Super League UI is not enabled. Configure authentication before enabling it.");
  res.sendFile(path.join(ROOT, `${name}.html`));
}

app.get("/admin", (_req, res) => privatePage("admin", res));
app.get("/logs", (_req, res) => privatePage("logs", res));
app.use(express.static(ROOT, { extensions: ["html"] }));
app.use((req, res) => res.status(404).sendFile(path.join(ROOT, "404.html")));
app.listen(PORT, "0.0.0.0", () => console.log(`Super League platform listening on ${PORT}`));
