"use strict";

const http = require("http");
const crypto = require("crypto");
const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require("discord.js");
const { loadData, saveData } = require("./database.js");

const AUTHORIZE_URL = "https://apis.roblox.com/oauth/v1/authorize";
const TOKEN_URL = "https://apis.roblox.com/oauth/v1/token";
const USERINFO_URL = "https://apis.roblox.com/oauth/v1/userinfo";
const STATE_TTL_MS = 10 * 60 * 1000;
const pending = new Map();

function required(name) {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is required for Roblox verification.`);
    return value;
}

function config() {
    return {
        clientId: required("ROBLOX_CLIENT_ID"),
        clientSecret: required("ROBLOX_CLIENT_SECRET"),
        redirectUri: required("ROBLOX_REDIRECT_URI"),
        guildId: required("ROBLOX_GUILD_ID"),
        verifiedRoleId: required("ROBLOX_VERIFIED_ROLE_ID")
    };
}

function base64url(buffer) {
    return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function randomString(bytes = 32) {
    return base64url(crypto.randomBytes(bytes));
}

function pkceChallenge(verifier) {
    return base64url(crypto.createHash("sha256").update(verifier).digest());
}

function authorizationUrl(discordId) {
    const cfg = config();
    const state = randomString(32);
    const codeVerifier = randomString(64);
    const nonce = randomString(32);

    pending.set(state, {
        discordId,
        guildId: cfg.guildId,
        codeVerifier,
        nonce,
        createdAt: Date.now()
    });

    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set("client_id", cfg.clientId);
    url.searchParams.set("redirect_uri", cfg.redirectUri);
    url.searchParams.set("scope", "openid profile");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("state", state);
    url.searchParams.set("nonce", nonce);
    url.searchParams.set("code_challenge", pkceChallenge(codeVerifier));
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
}

function cleanupPending() {
    const cutoff = Date.now() - STATE_TTL_MS;
    for (const [state, value] of pending) {
        if (value.createdAt < cutoff) pending.delete(state);
    }
}

async function exchangeCode(code, codeVerifier) {
    const cfg = config();
    const body = new URLSearchParams({
        code,
        code_verifier: codeVerifier,
        grant_type: "authorization_code",
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret
    });

    const response = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Roblox token exchange failed (${response.status}): ${text.slice(0, 500)}`);
    }

    return response.json();
}

async function getUserInfo(accessToken) {
    const response = await fetch(USERINFO_URL, {
        headers: { Authorization: `Bearer ${accessToken}` }
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Roblox userinfo failed (${response.status}): ${text.slice(0, 500)}`);
    }

    return response.json();
}

function ensureLinks(data, guildId) {
    data.settings.robloxLinks ??= {};
    data.settings.robloxLinks[guildId] ??= {};
    return data.settings.robloxLinks[guildId];
}

function successPage(username, discordTag) {
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Super League Verification</title><style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#111827;color:#f9fafb}.card{max-width:520px;padding:32px;border-radius:18px;background:#1f2937;text-align:center;box-shadow:0 12px 40px #0006}h1{margin-top:0}p{color:#d1d5db}</style></head><body><div class="card"><h1>Verification successful</h1><p><strong>${escapeHtml(username)}</strong> is now linked to <strong>${escapeHtml(discordTag)}</strong>.</p><p>You can close this page and return to Discord.</p></div></body></html>`;
}

function errorPage(message) {
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Super League Verification</title><style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#111827;color:#f9fafb}.card{max-width:520px;padding:32px;border-radius:18px;background:#1f2937;text-align:center;box-shadow:0 12px 40px #0006}h1{margin-top:0}p{color:#d1d5db}</style></head><body><div class="card"><h1>Verification failed</h1><p>${escapeHtml(message)}</p><p>Return to Discord and try again.</p></div></body></html>`;
}

function escapeHtml(value) {
    return String(value).replace(/[&<>\"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[character]));
}

async function handleCallback(client, requestUrl, response) {
    const params = new URL(requestUrl, "http://localhost").searchParams;
    const state = params.get("state");
    const code = params.get("code");
    const oauthError = params.get("error");

    if (oauthError) throw new Error(`Roblox authorization was cancelled or denied (${oauthError}).`);
    if (!state || !code) throw new Error("The Roblox authorization response was incomplete.");

    const transaction = pending.get(state);
    pending.delete(state);
    if (!transaction || Date.now() - transaction.createdAt > STATE_TTL_MS) throw new Error("This verification session expired. Start verification again.");

    const cfg = config();
    if (transaction.guildId !== cfg.guildId) throw new Error("Invalid verification server.");

    const tokens = await exchangeCode(code, transaction.codeVerifier);
    if (!tokens.access_token) throw new Error("Roblox did not return an access token.");

    const user = await getUserInfo(tokens.access_token);
    const robloxId = String(user.sub || "");
    const username = String(user.preferred_username || user.name || "Unknown");
    if (!/^\d+$/.test(robloxId)) throw new Error("Roblox returned an invalid user ID.");

    const guild = await client.guilds.fetch(cfg.guildId);
    const member = await guild.members.fetch(transaction.discordId);
    const role = await guild.roles.fetch(cfg.verifiedRoleId);
    if (!role) throw new Error("The configured Verified role does not exist.");
    if (!role.editable) throw new Error("The bot cannot assign the Verified role. Move the bot role above the Verified role and grant Manage Roles.");

    const links = ensureLinks(loadData(), cfg.guildId);
    const existingDiscord = links[robloxId];
    if (existingDiscord && existingDiscord.discordId !== member.id) {
        throw new Error("That Roblox account is already linked to another Discord account in this server.");
    }

    for (const [linkedRobloxId, link] of Object.entries(links)) {
        if (link.discordId === member.id && linkedRobloxId !== robloxId) delete links[linkedRobloxId];
    }

    links[robloxId] = {
        discordId: member.id,
        username,
        displayName: String(user.name || username),
        profile: typeof user.profile === "string" ? user.profile : null,
        verifiedAt: new Date().toISOString()
    };

    const data = loadData();
    const freshLinks = ensureLinks(data, cfg.guildId);
    Object.assign(freshLinks, links);
    saveData(data);

    if (!member.roles.cache.has(role.id)) await member.roles.add(role, "Roblox OAuth verification");

    const discordTag = member.user.tag || member.user.username;
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(successPage(username, discordTag));
}

function startWebServer(client) {
    const port = Number(process.env.PORT || 3000);
    const server = http.createServer(async (request, response) => {
        const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);

        if (url.pathname === "/roblox/callback") {
            try {
                await handleCallback(client, url.toString(), response);
            } catch (error) {
                console.error("Roblox verification callback error:", error);
                if (!response.headersSent) {
                    response.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
                    response.end(errorPage(error.message || "Verification failed."));
                }
            }
            return;
        }

        if (url.pathname === "/health") {
            response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
            response.end("ok");
            return;
        }

        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Not found");
    });

    server.listen(port, "0.0.0.0", () => console.log(`Roblox verification web server listening on port ${port}`));
    setInterval(cleanupPending, 60_000).unref();
    return server;
}

function verificationEmbed() {
    return new EmbedBuilder()
        .setTitle("Roblox Verification")
        .setDescription("Link your Roblox account to your Discord account using Roblox's official OAuth authorization flow.\n\nYou will be redirected to Roblox to sign in and approve the connection. **Never enter your Roblox password, cookie, or 2FA code into Discord or our bot.**")
        .setColor(0x5865f2)
        .setFooter({ text: "Super League • Roblox Verification" });
}

function verifyButton(discordId) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setLabel("Verify with Roblox")
            .setStyle(ButtonStyle.Link)
            .setURL(authorizationUrl(discordId))
    );
}

const command = {
    data: new SlashCommandBuilder()
        .setName("verify")
        .setDescription("Start Roblox account verification."),

    async execute(interaction) {
        if (!interaction.guild) return interaction.reply({ content: "This command can only be used in a server.", ephemeral: true });
        const cfg = config();
        if (interaction.guild.id !== cfg.guildId) return interaction.reply({ content: "Roblox verification is not enabled for this server.", ephemeral: true });
        return interaction.reply({ embeds: [verificationEmbed()], components: [verifyButton(interaction.user.id)], ephemeral: true });
    },

    async handleButton(interaction) {
        if (!interaction.guild || interaction.guild.id !== config().guildId) return interaction.reply({ content: "Roblox verification is not enabled here.", ephemeral: true });
        return interaction.reply({ embeds: [verificationEmbed()], components: [verifyButton(interaction.user.id)], ephemeral: true });
    },

    startWebServer
};

module.exports = { command, startWebServer };
