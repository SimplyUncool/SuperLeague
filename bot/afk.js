"use strict";

const fs = require("fs");
const path = require("path");

const dbPath = path.resolve(process.env.SUPER_LEAGUE_DB_PATH || path.join(__dirname, "users.json"));
const storePath = path.join(path.dirname(dbPath), "afk.json");
const mentionCooldowns = new Map();

function loadStore() {
    try {
        if (!fs.existsSync(storePath)) return { guilds: {} };
        const parsed = JSON.parse(fs.readFileSync(storePath, "utf8"));
        if (!parsed || typeof parsed !== "object") return { guilds: {} };
        parsed.guilds ??= {};
        return parsed;
    } catch (error) {
        console.error("Failed to load AFK data:", error);
        return { guilds: {} };
    }
}

function saveStore(store) {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    const tempPath = `${storePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tempPath, JSON.stringify(store, null, 2), { mode: 0o600 });
    fs.renameSync(tempPath, storePath);
}

function ensureGuild(store, guildId) {
    store.guilds ??= {};
    store.guilds[guildId] ??= { users: {} };
    store.guilds[guildId].users ??= {};
    return store.guilds[guildId];
}

function setAfk(guildId, userId, reason) {
    const store = loadStore();
    const guild = ensureGuild(store, guildId);
    guild.users[userId] = { reason: reason || "AFK", timestamp: Date.now() };
    saveStore(store);
}

function clearAfk(guildId, userId) {
    const store = loadStore();
    const guild = ensureGuild(store, guildId);
    if (!guild.users[userId]) return false;
    delete guild.users[userId];
    saveStore(store);
    return true;
}

function formatDuration(timestamp) {
    const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (days) return `${days}d ${hours}h`;
    if (hours) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
}

async function handleMessage(message) {
    if (!message.guild || message.author?.bot) return;

    const store = loadStore();
    const guild = ensureGuild(store, message.guild.id);
    const ownAfk = guild.users[message.author.id];
    if (ownAfk) {
        delete guild.users[message.author.id];
        saveStore(store);
        await message.reply(`Welcome back, <@${message.author.id}>. You were AFK for **${formatDuration(ownAfk.timestamp)}**.`).catch(() => {});
    }

    const mentioned = [...message.mentions.users.values()]
        .filter(user => user.id !== message.author.id && !user.bot)
        .map(user => [user.id, guild.users[user.id]])
        .filter(([, entry]) => entry);
    if (!mentioned.length) return;

    const lines = [];
    for (const [userId, entry] of mentioned.slice(0, 10)) {
        const key = `${message.guild.id}:${userId}`;
        const last = mentionCooldowns.get(key) || 0;
        if (Date.now() - last < 30000) continue;
        mentionCooldowns.set(key, Date.now());
        lines.push(`<@${userId}> is AFK: **${entry.reason}** — <t:${Math.floor(entry.timestamp / 1000)}:R>`);
    }
    if (lines.length) await message.reply(lines.join("\n")).catch(() => {});

    if (mentionCooldowns.size > 5000) {
        const cutoff = Date.now() - 60000;
        for (const [key, timestamp] of mentionCooldowns) if (timestamp < cutoff) mentionCooldowns.delete(key);
    }
}

module.exports = { setAfk, clearAfk, handleMessage };
