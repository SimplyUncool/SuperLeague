"use strict";

const { AuditLogEvent, ChannelType, PermissionsBitField } = require("discord.js");
const { loadData, getLogChannelId } = require("./commands/database.js");

const WINDOW_MS = 10_000;
const RAID_WINDOW_MS = 10_000;
const RAID_IDLE_MS = 120_000;
const RAID_JOIN_THRESHOLD = 8;
const NUKE_SCORE_THRESHOLD = 5;
const BOT_ADD_LOOKBACK_MS = 10 * 60_000;
const MSC_TOKEN = "msc";

const trackedActions = new Map();
const joinTimes = new Map();
const raidState = new Map();
const channelSnapshots = new Map();
const roleSnapshots = new Map();
const lockdownSnapshots = new Map();
const enforcementLocks = new Set();

function now() { return Date.now(); }

function isGuildChannel(channel) {
    return channel && channel.guild && !channel.isThread?.();
}

function snapshotChannel(channel) {
    if (!isGuildChannel(channel)) return;
    channelSnapshots.set(channel.id, {
        id: channel.id,
        name: channel.name,
        type: channel.type,
        parentId: channel.parentId,
        position: channel.rawPosition ?? channel.position ?? 0,
        topic: "topic" in channel ? channel.topic : undefined,
        nsfw: "nsfw" in channel ? channel.nsfw : undefined,
        rateLimitPerUser: "rateLimitPerUser" in channel ? channel.rateLimitPerUser : undefined,
        bitrate: "bitrate" in channel ? channel.bitrate : undefined,
        userLimit: "userLimit" in channel ? channel.userLimit : undefined,
        rtcRegion: "rtcRegion" in channel ? channel.rtcRegion : undefined,
        permissionOverwrites: [...channel.permissionOverwrites.cache.values()].map(overwrite => ({
            id: overwrite.id,
            type: overwrite.type,
            allow: overwrite.allow.bitfield,
            deny: overwrite.deny.bitfield
        }))
    });
}

function snapshotRole(role) {
    if (!role?.guild) return;
    roleSnapshots.set(role.id, {
        id: role.id,
        name: role.name,
        color: role.color,
        hoist: role.hoist,
        mentionable: role.mentionable,
        permissions: role.permissions.bitfield,
        position: role.position
    });
}

function snapshotGuild(guild) {
    for (const channel of guild.channels.cache.values()) snapshotChannel(channel);
    for (const role of guild.roles.cache.values()) snapshotRole(role);
}

function isTrusted(guild, userId, client) {
    if (!userId || userId === client.user.id) return true;
    const trusted = (process.env.ANTI_NUKE_TRUSTED_IDS || "").split(",").map(v => v.trim()).filter(Boolean);
    return trusted.includes(userId);
}

async function logSecurity(guild, message) {
    try {
        const data = loadData();
        const channelId = getLogChannelId(data, guild.id);
        const channel = channelId ? guild.channels.cache.get(channelId) : null;
        if (channel?.isTextBased()) await channel.send({ content: `**Security:** ${message}` });
    } catch (error) {
        console.error("Security log error:", error);
    }
}

function prune(map, key, cutoff) {
    const values = map.get(key) || [];
    const fresh = values.filter(value => value.timestamp >= cutoff);
    if (fresh.length) map.set(key, fresh);
    else map.delete(key);
    return fresh;
}

function recordAction(executorId, action) {
    const cutoff = now() - WINDOW_MS;
    const entries = prune(trackedActions, executorId, cutoff);
    entries.push({ timestamp: now(), action, weight: action.weight });
    trackedActions.set(executorId, entries);
    return {
        count: entries.length,
        score: entries.reduce((total, entry) => total + entry.weight, 0)
    };
}

function actionWeight(action) {
    if ([
        AuditLogEvent.ChannelDelete,
        AuditLogEvent.RoleDelete,
        AuditLogEvent.MemberBanAdd,
        AuditLogEvent.MemberKick,
        AuditLogEvent.WebhookDelete,
        AuditLogEvent.EmojiDelete,
        AuditLogEvent.StickerDelete,
        AuditLogEvent.GuildUpdate,
        AuditLogEvent.ApplicationCommandPermissionUpdate
    ].includes(action)) return 2;
    if ([
        AuditLogEvent.ChannelCreate,
        AuditLogEvent.ChannelUpdate,
        AuditLogEvent.RoleCreate,
        AuditLogEvent.RoleUpdate,
        AuditLogEvent.ChannelOverwriteCreate,
        AuditLogEvent.ChannelOverwriteUpdate,
        AuditLogEvent.ChannelOverwriteDelete,
        AuditLogEvent.WebhookCreate,
        AuditLogEvent.WebhookUpdate,
        AuditLogEvent.EmojiCreate,
        AuditLogEvent.EmojiUpdate,
        AuditLogEvent.StickerCreate,
        AuditLogEvent.StickerUpdate,
        AuditLogEvent.MemberRoleUpdate
    ].includes(action)) return 1;
    return 0;
}

async function resolveBotAuthorizer(guild, botId) {
    try {
        const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.BotAdd, limit: 25 });
        const entry = logs.entries.find(item => item.targetId === botId && now() - item.createdTimestamp <= BOT_ADD_LOOKBACK_MS);
        return entry?.executorId || null;
    } catch (error) {
        console.error("Could not resolve bot authorizer:", error);
        return null;
    }
}

async function banUser(guild, userId, reason) {
    if (!userId) return false;
    try {
        const member = guild.members.cache.get(userId) || await guild.members.fetch(userId).catch(() => null);
        if (member) {
            if (!member.bannable) return false;
            await member.ban({ reason });
            return true;
        }
        await guild.members.ban(userId, { reason });
        return true;
    } catch (error) {
        console.error(`Security ban failed for ${userId}:`, error);
        return false;
    }
}

async function punishExecutor(guild, executorId, client, reason) {
    if (!executorId || isTrusted(guild, executorId, client)) return;
    const user = await client.users.fetch(executorId).catch(() => null);
    if (user?.bot) {
        await banUser(guild, executorId, `${reason} (malicious bot)`);
        const authorizerId = await resolveBotAuthorizer(guild, executorId);
        if (authorizerId && authorizerId !== client.user.id) {
            await banUser(guild, authorizerId, `${reason} (authorized malicious bot ${executorId})`);
        }
        await logSecurity(guild, `Banned bot <@${executorId}> and attempted to ban its authorizer <@${authorizerId || "unknown"}>. Reason: ${reason}`);
        return;
    }
    const banned = await banUser(guild, executorId, reason);
    await logSecurity(guild, `${banned ? "Banned" : "Could not ban"} actioner <@${executorId}>. Reason: ${reason}`);
}

async function restoreDeletedChannel(guild, snapshot) {
    if (!snapshot || guild.channels.cache.has(snapshot.id)) return;
    try {
        const permissionOverwrites = snapshot.permissionOverwrites.map(overwrite => ({
            id: overwrite.id,
            type: overwrite.type,
            allow: overwrite.allow,
            deny: overwrite.deny
        }));
        const options = {
            name: snapshot.name,
            type: snapshot.type,
            reason: "Anti-nuke restoration",
            permissionOverwrites
        };
        if (snapshot.parentId && guild.channels.cache.has(snapshot.parentId)) options.parent = snapshot.parentId;
        if (snapshot.topic !== undefined && [ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(snapshot.type)) options.topic = snapshot.topic;
        if (snapshot.nsfw !== undefined) options.nsfw = snapshot.nsfw;
        if (snapshot.rateLimitPerUser !== undefined) options.rateLimitPerUser = snapshot.rateLimitPerUser;
        if (snapshot.bitrate !== undefined) options.bitrate = snapshot.bitrate;
        if (snapshot.userLimit !== undefined) options.userLimit = snapshot.userLimit;
        if (snapshot.rtcRegion !== undefined) options.rtcRegion = snapshot.rtcRegion;
        const restored = await guild.channels.create(options);
        if (typeof snapshot.position === "number") await restored.setPosition(snapshot.position).catch(() => {});
        snapshotChannel(restored);
        return restored;
    } catch (error) {
        console.error("Channel restoration failed:", error);
        return null;
    }
}

async function restoreDeletedRole(guild, snapshot) {
    if (!snapshot || guild.roles.cache.has(snapshot.id)) return;
    try {
        const role = await guild.roles.create({
            name: snapshot.name,
            color: snapshot.color,
            hoist: snapshot.hoist,
            mentionable: snapshot.mentionable,
            permissions: snapshot.permissions,
            reason: "Anti-nuke restoration"
        });
        if (typeof snapshot.position === "number") await role.setPosition(snapshot.position).catch(() => {});
        snapshotRole(role);
        return role;
    } catch (error) {
        console.error("Role restoration failed:", error);
        return null;
    }
}

function getChange(entry, key) {
    return entry.changes?.find(change => change.key === key) || null;
}

async function restoreChannelUpdate(guild, entry) {
    const channel = guild.channels.cache.get(entry.targetId);
    if (!channel) return;
    const nameChange = getChange(entry, "name");
    if (nameChange?.old) await channel.edit({ name: nameChange.old }, "Anti-nuke restoration").catch(() => {});
    const snapshot = channelSnapshots.get(channel.id);
    if (!snapshot) return;
    const edits = {};
    const parentChange = getChange(entry, "parent_id");
    const topicChange = getChange(entry, "topic");
    const nsfwChange = getChange(entry, "nsfw");
    if (parentChange?.old !== undefined) edits.parent = parentChange.old || null;
    if (topicChange?.old !== undefined && "topic" in channel) edits.topic = topicChange.old || null;
    if (nsfwChange?.old !== undefined && "nsfw" in channel) edits.nsfw = nsfwChange.old;
    if (Object.keys(edits).length) await channel.edit(edits, "Anti-nuke restoration").catch(() => {});
}

async function restoreRoleUpdate(guild, entry) {
    const role = guild.roles.cache.get(entry.targetId);
    const snapshot = roleSnapshots.get(entry.targetId);
    if (!role || !snapshot) return;
    const edits = {};
    for (const key of ["name", "color", "hoist", "mentionable", "permissions"]) {
        const change = getChange(entry, key);
        if (change?.old !== undefined) edits[key] = change.old;
    }
    if (Object.keys(edits).length) await role.edit(edits, "Anti-nuke restoration").catch(() => {});
    await role.setPosition(snapshot.position).catch(() => {});
}

async function restoreGuildUpdate(guild, entry) {
    const edits = {};
    for (const key of ["name", "description", "verification_level", "explicit_content_filter", "default_message_notifications", "afk_timeout"]) {
        const change = getChange(entry, key);
        if (change?.old !== undefined) edits[key] = change.old;
    }
    if (Object.keys(edits).length) await guild.edit(edits, "Anti-nuke restoration").catch(() => {});
}

function rolePermissionEscalation(entry) {
    const change = getChange(entry, "permissions");
    if (!change || change.old === undefined || change.new === undefined) return false;
    const oldPermissions = new PermissionsBitField(BigInt(change.old));
    const newPermissions = new PermissionsBitField(BigInt(change.new));
    const dangerous = [
        PermissionsBitField.Flags.Administrator,
        PermissionsBitField.Flags.ManageGuild,
        PermissionsBitField.Flags.ManageRoles,
        PermissionsBitField.Flags.ManageChannels,
        PermissionsBitField.Flags.BanMembers,
        PermissionsBitField.Flags.KickMembers,
        PermissionsBitField.Flags.ManageWebhooks
    ];
    return dangerous.some(permission => !oldPermissions.has(permission) && newPermissions.has(permission));
}

async function punishRaidJoin(member) {
    try {
        if (member.user.bot) return;
        if (member.moderatable) await member.timeout(10 * 60_000, "Anti-raid protection");
    } catch (error) {
        console.error("Raid member mitigation failed:", error);
    }
}

async function enterRaidMode(guild) {
    if (raidState.get(guild.id)?.active) return;
    raidState.set(guild.id, { active: true, until: now() + RAID_IDLE_MS, joins: [] });
    await logSecurity(guild, "Raid protection activated: rapid-join threshold exceeded. Locking public text channels for 2 minutes and mitigating new joins.");
    for (const channel of guild.channels.cache.values()) {
        if (!isGuildChannel(channel) || channel.isThread?.() || !channel.permissionOverwrites) continue;
        const everyone = guild.roles.everyone;
        const overwrite = channel.permissionOverwrites.cache.get(everyone.id);
        lockdownSnapshots.set(`${guild.id}:${channel.id}`, overwrite ? {
            allow: overwrite.allow.bitfield,
            deny: overwrite.deny.bitfield
        } : null);
        await channel.permissionOverwrites.edit(everyone, { SendMessages: false }, "Anti-raid lockdown").catch(() => {});
    }
    setTimeout(() => exitRaidMode(guild).catch(console.error), RAID_IDLE_MS + 250);
}

async function exitRaidMode(guild) {
    const state = raidState.get(guild.id);
    if (!state?.active || state.until > now()) return;
    raidState.delete(guild.id);
    for (const channel of guild.channels.cache.values()) {
        const key = `${guild.id}:${channel.id}`;
        if (!lockdownSnapshots.has(key) || !channel.permissionOverwrites) continue;
        const snapshot = lockdownSnapshots.get(key);
        lockdownSnapshots.delete(key);
        const everyone = guild.roles.everyone;
        if (!snapshot) await channel.permissionOverwrites.delete(everyone, "Anti-raid lockdown ended").catch(() => {});
        else await channel.permissionOverwrites.edit(everyone, { allow: snapshot.allow, deny: snapshot.deny }, "Anti-raid lockdown ended").catch(() => {});
    }
    await logSecurity(guild, "Raid protection ended; previous public channel permissions were restored where possible.");
}

async function handleMemberAdd(member) {
    const guild = member.guild;
    if (member.user.bot) return;
    const timestamps = prune(joinTimes, guild.id, now() - RAID_WINDOW_MS);
    timestamps.push({ timestamp: now(), userId: member.id });
    joinTimes.set(guild.id, timestamps);
    const state = raidState.get(guild.id);
    if (state?.active) {
        state.until = now() + RAID_IDLE_MS;
        state.joins.push(member.id);
        await punishRaidJoin(member);
        return;
    }
    if (timestamps.length >= RAID_JOIN_THRESHOLD) {
        await enterRaidMode(guild);
        for (const join of timestamps) {
            const joined = guild.members.cache.get(join.userId);
            if (joined) await punishRaidJoin(joined);
        }
    }
}

async function handleAuditEntry(entry, guild, client) {
    if (!entry?.action || !guild || !entry.executorId) return;
    const action = entry.action;
    if (action === AuditLogEvent.BotAdd || entry.executorId === client.user.id) return;

    if (action === AuditLogEvent.ChannelUpdate) {
        const nameChange = getChange(entry, "name");
        const newName = typeof nameChange?.new === "string" ? nameChange.new : null;
        if (newName && newName.toLowerCase().includes(MSC_TOKEN)) {
            await restoreChannelUpdate(guild, entry);
            await punishExecutor(guild, entry.executorId, client, `channel name changed to a name containing "${MSC_TOKEN}"`);
            return;
        }
    }

    if (isTrusted(guild, entry.executorId, client)) return;

    if (action === AuditLogEvent.RoleUpdate && rolePermissionEscalation(entry)) {
        await restoreRoleUpdate(guild, entry);
        await punishExecutor(guild, entry.executorId, client, "dangerous role permissions were escalated");
        return;
    }

    const weight = actionWeight(action);
    if (!weight) return;
    const activity = recordAction(entry.executorId, { weight });

    if (action === AuditLogEvent.ChannelDelete) await restoreDeletedChannel(guild, channelSnapshots.get(entry.targetId));
    if (action === AuditLogEvent.RoleDelete) await restoreDeletedRole(guild, roleSnapshots.get(entry.targetId));

    if (activity.score >= NUKE_SCORE_THRESHOLD) {
        if (enforcementLocks.has(entry.executorId)) return;
        enforcementLocks.add(entry.executorId);
        try {
            if (action === AuditLogEvent.ChannelCreate) await guild.channels.cache.get(entry.targetId)?.delete("Anti-nuke rollback").catch(() => {});
            if (action === AuditLogEvent.RoleCreate) await guild.roles.cache.get(entry.targetId)?.delete("Anti-nuke rollback").catch(() => {});
            if (action === AuditLogEvent.ChannelUpdate) await restoreChannelUpdate(guild, entry);
            if (action === AuditLogEvent.RoleUpdate) await restoreRoleUpdate(guild, entry);
            if (action === AuditLogEvent.GuildUpdate) await restoreGuildUpdate(guild, entry);
            await punishExecutor(guild, entry.executorId, client, `anti-nuke threshold exceeded (${activity.score} destructive score in ${WINDOW_MS / 1000}s)`);
        } finally {
            setTimeout(() => enforcementLocks.delete(entry.executorId), WINDOW_MS);
        }
    }
}

function initializeSecurity(client) {
    client.on("clientReady", readyClient => {
        for (const guild of readyClient.guilds.cache.values()) snapshotGuild(guild);
    });
    client.on("channelCreate", channel => snapshotChannel(channel));
    client.on("channelUpdate", (oldChannel, newChannel) => {
        snapshotChannel(oldChannel);
        if (newChannel) snapshotChannel(newChannel);
    });
    client.on("channelDelete", channel => channelSnapshots.set(channel.id, channelSnapshots.get(channel.id) || {
        id: channel.id,
        name: channel.name,
        type: channel.type,
        parentId: channel.parentId,
        position: channel.rawPosition ?? channel.position ?? 0,
        topic: "topic" in channel ? channel.topic : undefined,
        nsfw: "nsfw" in channel ? channel.nsfw : undefined,
        permissionOverwrites: [...channel.permissionOverwrites.cache.values()].map(overwrite => ({ id: overwrite.id, type: overwrite.type, allow: overwrite.allow.bitfield, deny: overwrite.deny.bitfield }))
    }));
    client.on("roleCreate", role => snapshotRole(role));
    client.on("roleUpdate", (oldRole, newRole) => { snapshotRole(oldRole); snapshotRole(newRole); });
    client.on("roleDelete", role => snapshotRole(role));
    client.on("guildAuditLogEntryCreate", (entry, guild) => handleAuditEntry(entry, guild, client).catch(console.error));
    client.on("guildMemberAdd", member => handleMemberAdd(member).catch(console.error));
    client.on("guildDelete", guild => { raidState.delete(guild.id); joinTimes.delete(guild.id); });
}

module.exports = { initializeSecurity };
