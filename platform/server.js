"use strict";

require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = Number(process.env.PORT || 3100);
const ROOT = path.join(__dirname, "public");
const DATA = path.join(__dirname, "data");
const BANNER = path.resolve(__dirname, "..", "..", "docs", "SLBANNER.png");
const startedAt = Date.now();
const dbPath = process.env.SL_DB_PATH || path.resolve(__dirname, "../bot/users.json");
const auditPath = process.env.SL_AUDIT_LOG_PATH || path.join(DATA, "audit.jsonl");
const applicationsPath = process.env.SL_APPLICATIONS_PATH || path.join(DATA, "applications.json");

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(express.json({ limit: "32kb" }));
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  next();
});

function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } }
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function loadDb() { return readJson(dbPath, { teams: {}, settings: { robloxLinks: {}, applications: {}, activeApplications: {}, applicationReviews: {} } }); }
function externalData(name) {
  const configured = process.env[`SL_${name.toUpperCase()}_FILE`];
  return readJson(configured || path.join(DATA, `${name}.json`), []);
}
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const aa = Buffer.from(a), bb = Buffer.from(b);
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function auth(req, res, next) {
  if (process.env.SL_PRIVATE_UI_ENABLED !== "true") return res.status(503).send("Private Super League UI is disabled.");
  const user = process.env.SL_ADMIN_USERNAME;
  const pass = process.env.SL_ADMIN_PASSWORD;
  if (!user || !pass) return res.status(503).send("Admin authentication is not configured.");
  const header = req.headers.authorization || "";
  const encoded = header.startsWith("Basic ") ? header.slice(6) : "";
  let suppliedUser = "", suppliedPass = "";
  try { const decoded = Buffer.from(encoded, "base64").toString("utf8"); const i = decoded.indexOf(":"); if (i >= 0) { suppliedUser = decoded.slice(0, i); suppliedPass = decoded.slice(i + 1); } } catch {}
  if (!safeEqual(suppliedUser, user) || !safeEqual(suppliedPass, pass)) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Super League Admin", charset="UTF-8"');
    return res.status(401).send("Authentication required.");
  }
  next();
}
function appendAudit(event) {
  fs.mkdirSync(path.dirname(auditPath), { recursive: true });
  fs.appendFileSync(auditPath, `${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`, { mode: 0o600 });
}
async function discordRequest(pathname, options = {}) {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) throw new Error("Discord adapter is not configured");
  const response = await fetch(`https://discord.com/api/v10${pathname}`, { ...options, headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json", ...(options.headers || {}) } });
  if (!response.ok) throw new Error(`Discord API ${response.status}`);
  return response.json();
}
let discordCache = { expires: 0, roles: [], members: [] };
async function discordGuildData() {
  const guildId = process.env.SL_DISCORD_GUILD_ID;
  if (!guildId || !process.env.DISCORD_BOT_TOKEN) return null;
  if (discordCache.expires > Date.now()) return discordCache;
  const roles = await discordRequest(`/guilds/${guildId}/roles`);
  const members = [];
  let after = "0";
  for (let page = 0; page < 10; page++) {
    const batch = await discordRequest(`/guilds/${guildId}/members?limit=1000&after=${after}`);
    members.push(...batch);
    if (batch.length < 1000) break;
    after = batch[batch.length - 1].user.id;
  }
  discordCache = { expires: Date.now() + 30_000, roles, members };
  return discordCache;
}
function findRobloxLinks(db, discordId) {
  const result = [];
  for (const [guildId, links] of Object.entries(db.settings?.robloxLinks || {})) {
    if (discordId && links?.[discordId]) result.push({ guildId, ...links[discordId] });
    else for (const [userId, link] of Object.entries(links || {})) if (link?.robloxId === discordId || link?.roblox_id === discordId || link?.id === discordId) result.push({ guildId, discordId: userId, ...link });
  }
  return result;
}
async function buildTeams() {
  const db = loadDb();
  const guild = await discordGuildData().catch(() => null);
  const roles = guild?.roles || [];
  const members = guild?.members || [];
  return Object.entries(db.teams || {}).map(([roleId, team]) => {
    const role = roles.find(r => r.id === roleId);
    const roster = members.filter(m => Array.isArray(m.roles) && m.roles.includes(roleId)).map(m => ({ id: m.user.id, username: m.user.username, globalName: m.user.global_name || null }));
    return { id: roleId, name: role?.name || `Team ${roleId}`, color: role?.color || 0, managerId: team.managerid || null, staff: team.staff || {}, roster, rosterCount: roster.length, status: team.managerid ? "active" : "frozen" };
  });
}

function sendPage(name, res) {
  const file = path.join(ROOT, name);
  let html;
  try { html = fs.readFileSync(file, "utf8"); } catch { return res.status(404).send("Page not found."); }
  if (!html.includes('href="/theme.css"')) html = html.replace("</head>", '<link rel="stylesheet" href="/theme.css"></head>');
  return res.type("html").send(html);
}

app.get("/SLBANNER.png", (_req, res) => res.sendFile(BANNER));
app.get("/theme.css", (_req, res) => res.sendFile(path.join(ROOT, "theme.css")));

app.get("/health", (_req, res) => res.json({ ok: true, service: "superleague-platform", uptime: Math.floor((Date.now() - startedAt) / 1000) }));
app.get("/api/v1", (_req, res) => res.json({ name: "Super League API", version: "v1", status: "live", endpoints: ["/api/v1/teams", "/api/v1/players", "/api/v1/matches", "/api/v1/standings", "/api/v1/roblox/:id", "/api/v1/discord/:id", "/api/v1/health"] }));
app.get("/api/v1/health", (_req, res) => res.json({ ok: true, version: "v1", dataSource: fs.existsSync(dbPath) ? "bot-database" : "configured-files" }));
app.get("/api/v1/teams", async (_req, res) => { try { res.json({ data: await buildTeams(), meta: { source: "discord+bot-database", wired: true } }); } catch (error) { console.error(error); res.status(503).json({ error: "data_unavailable" }); } });
app.get("/api/v1/players", async (_req, res) => { try { const teams = await buildTeams(); const players = teams.flatMap(t => t.roster.map(p => ({ ...p, teamId: t.id, teamName: t.name, role: p.id === t.managerId ? "manager" : "player" }))); res.json({ data: players, meta: { source: "discord+bot-database", wired: true } }); } catch { res.json({ data: externalData("players"), meta: { source: "configured-file", wired: false } }); } });
app.get("/api/v1/matches", (_req, res) => res.json({ data: externalData("matches"), meta: { source: "configured-file", wired: process.env.SL_MATCHES_FILE ? true : false } }));
app.get("/api/v1/standings", (_req, res) => res.json({ data: externalData("standings"), meta: { source: "configured-file", wired: process.env.SL_STANDINGS_FILE ? true : false } }));
app.get("/api/v1/roblox/:id", (req, res) => { const links = findRobloxLinks(loadDb(), req.params.id); if (!links.length) return res.status(404).json({ error: "not_found" }); res.json({ data: links }); });
app.get("/api/v1/discord/:id", async (req, res) => { try { const guild = await discordGuildData(); const member = guild?.members.find(m => m.user.id === req.params.id); const links = findRobloxLinks(loadDb(), req.params.id); if (!member && !links.length) return res.status(404).json({ error: "not_found" }); res.json({ data: { discord: member ? { id: member.user.id, username: member.user.username, globalName: member.user.global_name || null } : null, roblox: links } }); } catch { res.status(503).json({ error: "discord_unavailable" }); } });

const rate = new Map();
function limited(ip) { const now = Date.now(); const row = rate.get(ip) || { at: now, count: 0 }; if (now - row.at > 60_000) { row.at = now; row.count = 0; } row.count++; rate.set(ip, row); return row.count > 5; }
app.post("/api/v1/applications", async (req, res) => {
  if (limited(req.ip)) return res.status(429).json({ error: "rate_limited" });
  const body = req.body || {};
  if (body.website) return res.status(400).json({ error: "invalid_submission" });
  const type = typeof body.type === "string" ? body.type.trim().toLowerCase() : "";
  const allowed = new Set(["player", "team", "staff", "manager"]);
  if (!allowed.has(type)) return res.status(400).json({ error: "invalid_type" });
  const answers = body.answers && typeof body.answers === "object" ? body.answers : {};
  const submission = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), type, discordId: String(body.discordId || "").slice(0, 32), robloxId: String(body.robloxId || "").slice(0, 32), name: String(body.name || "").slice(0, 100), answers: Object.fromEntries(Object.entries(answers).slice(0, 20).map(([k,v]) => [String(k).slice(0,50), String(v).slice(0,2000)])) };
  const current = readJson(applicationsPath, []); current.push(submission); writeJson(applicationsPath, current.slice(-5000));
  appendAudit({ event: "application.submitted", id: submission.id, type, discordId: submission.discordId || null });
  if (process.env.SL_APPLICATION_WEBHOOK_URL) {
    await fetch(process.env.SL_APPLICATION_WEBHOOK_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: `New ${type} application: ${submission.name || "Unnamed"}${submission.discordId ? ` (<@${submission.discordId}>)` : ""}`, allowed_mentions: { parse: [] }, embeds: [{ title: `${type[0].toUpperCase()}${type.slice(1)} application`, description: Object.entries(submission.answers).map(([k,v]) => `**${k}**\n${v}`).join("\n\n").slice(0, 5500), footer: { text: submission.id } }] }) }).catch(error => console.error("Application webhook failed:", error));
  }
  res.status(201).json({ ok: true, id: submission.id });
});

app.get("/api/v1/admin/summary", auth, async (_req, res) => { const db = loadDb(); const teams = Object.keys(db.teams || {}).length; const applications = Object.keys(db.settings?.applications || {}).length + readJson(applicationsPath, []).length; const audit = readJsonLines(auditPath, 100).length; res.json({ teams, applications, auditEvents: audit, matches: externalData("matches").length }); });
function readJsonLines(file, limit) { try { const lines = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).slice(-limit); return lines.map(line => JSON.parse(line)).reverse(); } catch { return []; } }
app.get("/api/v1/admin/logs", auth, (_req, res) => res.json({ data: readJsonLines(auditPath, 250) }));
app.post("/api/v1/audit", (req, res) => { const secret = process.env.SL_AUDIT_INGEST_SECRET; if (!secret || !safeEqual(String(req.headers["x-sl-audit-secret"] || ""), secret)) return res.status(401).json({ error: "unauthorized" }); const event = req.body && typeof req.body === "object" ? req.body : {}; appendAudit({ event: String(event.event || "security.event").slice(0, 100), guildId: String(event.guildId || "").slice(0, 32) || null, executorId: String(event.executorId || "").slice(0, 32) || null, details: event.details && typeof event.details === "object" ? event.details : {} }); res.status(204).end(); });

async function probe(url) { if (!url) return { configured: false, ok: false, latencyMs: null }; const started = Date.now(); try { const response = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: "manual" }); return { configured: true, ok: response.ok || (response.status >= 300 && response.status < 400), status: response.status, latencyMs: Date.now() - started }; } catch { return { configured: true, ok: false, status: null, latencyMs: Date.now() - started }; } }
async function statusSnapshot() { const services = { website: process.env.SL_WEBSITE_URL || "https://superleague.site", verification: process.env.SL_VERIFY_HEALTH_URL || "https://verify.superleague.site/health", minecraft: process.env.SL_MC_HEALTH_URL || "", api: process.env.SL_API_HEALTH_URL || "", discord: process.env.SL_DISCORD_HEALTH_URL || "" }; const result = {}; for (const [key, value] of Object.entries(services)) result[key] = value ? await probe(value) : { configured: false, ok: false, latencyMs: null }; if (process.env.DISCORD_BOT_TOKEN) { try { await discordRequest("/users/@me"); result.discord = { configured: true, ok: true, latencyMs: result.discord.latencyMs ?? null }; } catch { result.discord = { configured: true, ok: false, latencyMs: null }; } } return { generatedAt: new Date().toISOString(), services: result }; }
app.get("/status.json", async (_req, res) => res.json(await statusSnapshot()));

const redirects = (() => { try { return JSON.parse(process.env.SL_REDIRECTS_JSON || "{}"); } catch { return {}; } })();
app.get("/go/:key", (req, res) => { const target = redirects[req.params.key]; if (typeof target !== "string" || !/^https:\/\//i.test(target)) return res.status(404).sendFile(path.join(ROOT, "404.html")); res.redirect(302, target); });

app.get("/admin", auth, (_req, res) => sendPage("admin.html", res));
app.get("/logs", auth, (_req, res) => sendPage("logs.html", res));

app.get("/", (req, res, next) => {
  const host = String(req.hostname || "").toLowerCase();
  const subdomain = host.split(".")[0];
  const pages = { api: "api.html", status: "status.html", docs: "docs.html", apply: "apply.html", cdn: "landing.html", go: "landing.html" };
  if (subdomain === "admin") return auth(req, res, () => sendPage("admin.html", res));
  if (subdomain === "logs") return auth(req, res, () => sendPage("logs.html", res));
  if (pages[subdomain]) return sendPage(pages[subdomain], res);
  return next();
});

app.use(express.static(ROOT, { extensions: ["html"] }));
app.use((req, res) => res.status(404).sendFile(path.join(ROOT, "404.html")));
app.use((error, _req, res, _next) => { console.error(error); res.status(500).json({ error: "internal_error" }); });

app.listen(PORT, "0.0.0.0", () => console.log(`Super League platform listening on ${PORT}`));
