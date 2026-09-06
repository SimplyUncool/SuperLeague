"use strict";

const fs = require("fs");
const path = require("path");
const { EmbedBuilder } = require("discord.js");

const dbPath = path.resolve(process.env.SUPER_LEAGUE_DB_PATH || path.join(__dirname, "users.json"));
const configPath = path.join(path.dirname(dbPath), "invites.json");
const guildLocks = new Map();

function loadStore() {
    try {
        if (!fs.existsSync(configPath)) return { guilds: {} };
        const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
        if (!parsed || typeof parsed !== "object") return { guilds: {} };
        parsed.guilds ??= {};
        return parsed;
    } catch (error) {
        console.error("Failed to load invite tracking data:", error);
        return { guilds: {} };
    }
}

function saveStore(store) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const tempPath = `${configPath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tempPath, JSON.stringify(store, null, 2), { mode: 0o600 });
    fs.renameSync(tempPath, configPath);
}

function ensureGuild(store, guildId) {
    store.guilds ??= {};
    store.guilds[guildId] ??= { logChannelId: null, invites: {}, members: {} };
    const guild = store.guilds[guildId];
    guild.invites ??= {};
    guild.members ??= {};
    return guild;
}

function withGuildLock(guildId, task) {
    const previous = guildLocks.get(guildId) || Promise.resolve();
    const current = previous.catch(() => {}).then(task);
    const tracked = current.finally(() => {
        if (guildLocks.get(guildId) === tracked) guildLocks.delete(guildId);
    });
    guildLocks.set(guildId, tracked);
    return current;
}

async function fetchInviteSnapshot(guild) {
    const invites = await guild.invites.fetch();
    const snapshot = {};
    for (const invite of invites.values()) {
        snapshot[invite.code] = {
            uses: invite.uses ?? 0,
            inviterId: invite.inviterId ?? invite.inviter?.id ?? null
        };
    }
    return snapshot;
}

function findUsedInvite(previous, current) {
    const candidates = [];
    for (const [code, invite] of Object.entries(current)) {
        const before = previous[code]?.uses ?? 0;
        const after = invite.uses ?? 0;
        if (after > before) candidates.push({ code, delta: after - before, inviterId: invite.inviterId });
    }
    candidates.sort((a, b) => b.delta - a.delta);
    return candidates[0] ?? null;
}

async function refreshGuild(guild) {
    return withGuildLock(guild.id, async () => {
        const snapshot = await fetchInviteSnapshot(guild);
        const store = loadStore();
        const config = ensureGuild(store, guild.id);
        config.invites = snapshot;
        saveStore(store);
        return snapshot;
    });
}

function totalInvites(config, userId) {
    return Object.values(config.members).filter(entry => entry.inviterId === userId).length;
}

async function logJoin(guild, member, attribution, inviterTotal) {
    const store = loadStore();
    const config = ensureGuild(store, guild.id);
    if (!config.logChannelId) return;
    const channel = guild.channels.cache.get(config.logChannelId) || await guild.channels.fetch(config.logChannelId).catch(() => null);
    if (!channel?.isTextBased?.()) return;

    const inviter = attribution?.inviterId ? `<@${attribution.inviterId}>` : "Unknown / vanity / unavailable";
    const invite = attribution?.code ? `\`${attribution.code}\`` : "Unknown";
    const created = `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`;

    const embed = new EmbedBuilder()
        .setTitle("Member Joined")
        .setDescription(`${member} **${member.user.tag}** joined the server.`)
        .addFields(
            { name: "Invited by", value: inviter, inline: true },
            { name: "Invite", value: invite, inline: true },
            { name: "Inviter total", value: attribution?.inviterId ? `**${inviterTotal}**` : "—", inline: true },
            { name: "Account created", value: created, inline: true },
            { name: "Member count", value: `**${guild.memberCount}**`, inline: true }
        )
        .setThumbnail(member.displayAvatarURL({ size: 128 }))
        .setTimestamp();

    await channel.send({ embeds: [embed] }).catch(error => console.error("Failed to send invite join log:", error));
}

async function handleMemberAdd(member) {
    if (!member.guild) return;
    return withGuildLock(member.guild.id, async () => {
        const store = loadStore();
        const config = ensureGuild(store, member.guild.id);
        let current;
        try {
            current = await fetchInviteSnapshot(member.guild);
        } catch (error) {
            console.error(`Failed to fetch invites for ${member.guild.name}:`, error);
            saveStore(store);
            return;
        }

        const attribution = findUsedInvite(config.invites, current);
        config.invites = current;
        config.members[member.id] = {
            inviterId: attribution?.inviterId ?? null,
            code: attribution?.code ?? null,
            joinedAt: new Date().toISOString()
        };
        saveStore(store);

        const inviterTotal = attribution?.inviterId ? totalInvites(config, attribution.inviterId) : 0;
        await logJoin(member.guild, member, attribution, inviterTotal);
    });
}

async function handleMemberRemove(member) {
    if (!member.guild) return;
    const store = loadStore();
    const config = ensureGuild(store, member.guild.id);
    const entry = config.members[member.id];
    if (entry) {
        entry.leftAt = new Date().toISOString();
        saveStore(store);
    }
}

async function initialize(client) {
    for (const guild of client.guilds.cache.values()) {
        try {
            await refreshGuild(guild);
        } catch (error) {
            console.error(`Failed to initialize invite tracking for ${guild.name}:`, error);
        }
    }
}

function getStats(guild, userId) {
    const store = loadStore();
    const config = ensureGuild(store, guild.id);
    const entries = Object.entries(config.members).filter(([, entry]) => entry.inviterId === userId);
    const total = entries.length;
    const active = entries.filter(([memberId]) => guild.members.cache.has(memberId)).length;
    return { total, active, left: total - active };
}

module.exports = {
    initialize,
    refreshGuild,
    handleMemberAdd,
    handleMemberRemove,
    getStats
};
