"use strict";

const fs = require("fs");
const path = require("path");
const { AuditLogEvent, ChannelType, PermissionsBitField } = require("discord.js");
const { loadData, getLogChannelId } = require("./commands/database.js");

const WINDOW_MS = 10_000;
const RAID_WINDOW_MS = 10_000;
const RAID_IDLE_MS = 120_000;
const RAID_JOIN_THRESHOLD = 8;
const NUKE_SCORE_THRESHOLD = 5;
const BOT_AUDIT_LOOKBACK_MS = 10 * 60_000;
const AUDIT_DEDUPE_MS = 15_000;
const MSC_TOKEN = "msc";
const SECURITY_FILE = path.resolve(path.dirname(process.env.SUPER_LEAGUE_DB_PATH || path.join(__dirname, "users.json")), "security.json");
const trackedActions = new Map();
const auditSeen = new Map();
const joinTimes = new Map();
const raidState = new Map();
const channelSnapshots = new Map();
const roleSnapshots = new Map();
const pendingChannelRefresh = new Map();
const pendingRoleRefresh = new Map();
const manualLockdowns = new Map();
const enforcementLocks = new Set();

const DANGEROUS_PERMISSIONS = [
    PermissionsBitField.Flags.Administrator,
    PermissionsBitField.Flags.ManageGuild,
    PermissionsBitField.Flags.ManageRoles,
    PermissionsBitField.Flags.ManageChannels,
    PermissionsBitField.Flags.BanMembers,
    PermissionsBitField.Flags.KickMembers,
    PermissionsBitField.Flags.ManageWebhooks
];

function now() { return Date.now(); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function isGuildChannel(channel) { return Boolean(channel?.guild && !channel.isThread?.()); }
function trustedIds() { return (process.env.ANTI_NUKE_TRUSTED_IDS || "").split(",").map(v => v.trim()).filter(Boolean); }
function isTrusted(guild, userId, client) { return Boolean(userId) && (userId === client.user.id || userId === guild.ownerId || trustedIds().includes(userId)); }
function dangerousRole(role) { return Boolean(role && !role.managed && role.permissions.has(DANGEROUS_PERMISSIONS)); }
function getChange(entry, key) { return entry.changes?.find(change => change.key === key) || null; }

function snapshotChannel(channel) {
    if (!isGuildChannel(channel) || !channel.permissionOverwrites) return;
    channelSnapshots.set(channel.id, {
        id: channel.id,
        guildId: channel.guild.id,
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
        permissionOverwrites: [...channel.permissionOverwrites.cache.values()].map(o => ({ id: o.id, type: o.type, allow: o.allow.bitfield.toString(), deny: o.deny.bitfield.toString() }))
    });
}

function snapshotRole(role) {
    if (!role?.guild) return;
    roleSnapshots.set(role.id, { id: role.id, guildId: role.guild.id, name: role.name, color: role.color, hoist: role.hoist, mentionable: role.mentionable, permissions: role.permissions.bitfield.toString(), position: role.position });
}

function snapshotGuild(guild) {
    for (const channel of guild.channels.cache.values()) snapshotChannel(channel);
    for (const role of guild.roles.cache.values()) snapshotRole(role);
}

function loadSecurityState() {
    try {
        if (!fs.existsSync(SECURITY_FILE)) return { guilds: {} };
        const parsed = JSON.parse(fs.readFileSync(SECURITY_FILE, "utf8"));
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? { guilds: parsed.guilds && typeof parsed.guilds === "object" ? parsed.guilds : {} } : { guilds: {} };
    } catch (error) {
        console.error("Failed to load security state:", error);
        return { guilds: {} };
    }
}

function saveSecurityState(state) {
    fs.mkdirSync(path.dirname(SECURITY_FILE), { recursive: true });
    const tempPath = `${SECURITY_FILE}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tempPath, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(tempPath, SECURITY_FILE);
}

function persistManualLockdown(guild) {
    const state = loadSecurityState();
    const entry = manualLockdowns.get(guild.id);
    if (!entry?.active) delete state.guilds[guild.id];
    else state.guilds[guild.id] = { manualLockdown: true, channels: clone(entry.channels) };
    saveSecurityState(state);
}

async function alertOwner(guild, message) {
    try {
        const owner = await guild.client.users.fetch(guild.ownerId);
        await owner.send(`**Super League Security Alert — ${guild.name}**\n${message}`);
    } catch (error) {
        console.error("Security owner alert failed:", error);
    }
}

async function logSecurity(guild, message, critical = false) {
    try {
        const data = loadData();
        const channelId = getLogChannelId(data, guild.id);
        const channel = channelId ? guild.channels.cache.get(channelId) : null;
        if (channel?.isTextBased()) await channel.send({ content: `**Security:** ${message}` });
        if (critical && !channel?.isTextBased()) await alertOwner(guild, message);
    } catch (error) {
        console.error("Security log error:", error);
        if (critical) await alertOwner(guild, message);
    }
}

function prune(map, key, cutoff) {
    const values = map.get(key) || [];
    const fresh = values.filter(v => v.timestamp >= cutoff);
    if (fresh.length) map.set(key, fresh); else map.delete(key);
    return fresh;
}

function recordAction(executorId, weight, action) {
    const entries = prune(trackedActions, executorId, now() - WINDOW_MS);
    entries.push({ timestamp: now(), action, weight });
    trackedActions.set(executorId, entries);
    return { count: entries.length, score: entries.reduce((n, e) => n + e.weight, 0) };
}

function actionWeight(action) {
    if ([AuditLogEvent.MemberRoleUpdate, AuditLogEvent.ChannelDelete, AuditLogEvent.RoleDelete].includes(action)) return 3;
    if ([AuditLogEvent.MemberBanAdd, AuditLogEvent.MemberKick, AuditLogEvent.WebhookDelete, AuditLogEvent.EmojiDelete, AuditLogEvent.StickerDelete, AuditLogEvent.GuildUpdate, AuditLogEvent.ApplicationCommandPermissionUpdate, AuditLogEvent.ChannelOverwriteCreate, AuditLogEvent.ChannelOverwriteUpdate, AuditLogEvent.ChannelOverwriteDelete, AuditLogEvent.WebhookCreate, AuditLogEvent.WebhookUpdate].includes(action)) return 2;
    if ([AuditLogEvent.ChannelCreate, AuditLogEvent.ChannelUpdate, AuditLogEvent.RoleCreate, AuditLogEvent.RoleUpdate, AuditLogEvent.EmojiCreate, AuditLogEvent.EmojiUpdate, AuditLogEvent.StickerCreate, AuditLogEvent.StickerUpdate].includes(action)) return 1;
    return 0;
}

function markAuditSeen(entry) {
    const key = `${entry.guild?.id || ""}:${entry.id || `${entry.action}:${entry.targetId}:${entry.createdTimestamp}`}`;
    const previous = auditSeen.get(key);
    if (previous && now() - previous < AUDIT_DEDUPE_MS) return false;
    auditSeen.set(key, now());
    for (const [item, timestamp] of auditSeen) if (now() - timestamp > AUDIT_DEDUPE_MS) auditSeen.delete(item);
    return true;
}

function parseSnowflakes(value) {
    if (Array.isArray(value)) return value.flatMap(parseSnowflakes);
    if (value && typeof value === "object") return [value.id, value.role_id, value.target_id].filter(Boolean).flatMap(parseSnowflakes);
    if (typeof value === "string" && /^\d{17,20}$/.test(value)) return [value];
    return [];
}

function rolePermissionEscalation(entry) {
    const change = getChange(entry, "permissions");
    if (!change || change.old === undefined || change.new === undefined) return false;
    try {
        const oldPermissions = new PermissionsBitField(BigInt(change.old));
        const newPermissions = new PermissionsBitField(BigInt(change.new));
        return DANGEROUS_PERMISSIONS.some(permission => !oldPermissions.has(permission) && newPermissions.has(permission));
    } catch { return false; }
}

async function resolveBotAuthorizer(guild, botId) {
    for (let attempt = 0; attempt < 4; attempt++) {
        try {
            const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.BotAdd, limit: 50 });
            const entry = logs.entries.find(item => item.targetId === botId && now() - item.createdTimestamp <= BOT_AUDIT_LOOKBACK_MS);
            if (entry?.executorId) return entry.executorId;
        } catch (error) {
            console.error("Could not resolve bot authorizer:", error);
        }
        await new Promise(resolve => setTimeout(resolve, 300));
    }
    return null;
}

async function kickBotImmediately(member, client) {
    if (!member?.user?.bot || member.id === client.user.id) return false;
    let removed = false;
    try {
        if (member.kickable) {
            await member.kick("Security: bots must be explicitly added by the server owner");
            removed = true;
        }
    } catch (error) {
        console.error(`Failed to kick added bot ${member.id}:`, error);
    }
    void (async () => {
        const authorizerId = await resolveBotAuthorizer(member.guild, member.id);
        const botName = member.user.tag || member.user.username || member.id;
        const instruction = `Please ask the server owner to add **${botName}** instead of acting yourself.`;
        if (authorizerId && authorizerId !== client.user.id) {
            const authorizer = await client.users.fetch(authorizerId).catch(() => null);
            if (authorizer) await authorizer.send(instruction).catch(error => console.error("Bot-add DM failed:", error));
        }
        await logSecurity(member.guild, `${removed ? "Rejected" : "Could not remove"} bot **${botName}** (${member.id}) added by ${authorizerId ? `<@${authorizerId}>` : "unknown user"}.`, true);
    })().catch(error => console.error("Bot-add follow-up failed:", error));
    return removed;
}

async function restoreDeletedChannel(guild, snapshot) {
    if (!snapshot || guild.channels.cache.has(snapshot.id)) return null;
    try {
        const permissionOverwrites = snapshot.permissionOverwrites.map(o => ({ id: o.id, type: o.type, allow: BigInt(o.allow), deny: BigInt(o.deny) }));
        const options = { name: snapshot.name, type: snapshot.type, reason: "Anti-nuke restoration", permissionOverwrites };
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
    if (!snapshot || guild.roles.cache.has(snapshot.id)) return null;
    try {
        const role = await guild.roles.create({ name: snapshot.name, color: snapshot.color, hoist: snapshot.hoist, mentionable: snapshot.mentionable, permissions: BigInt(snapshot.permissions), reason: "Anti-nuke restoration" });
        if (typeof snapshot.position === "number") await role.setPosition(snapshot.position).catch(() => {});
        snapshotRole(role);
        return role;
    } catch (error) {
        console.error("Role restoration failed:", error);
        return null;
    }
}

async function restoreChannelUpdate(guild, entry) {
    const channel = guild.channels.cache.get(entry.targetId);
    if (!channel) return;
    const snapshot = channelSnapshots.get(channel.id);
    const edits = {};
    const name = getChange(entry, "name");
    const parent = getChange(entry, "parent_id");
    const topic = getChange(entry, "topic");
    const nsfw = getChange(entry, "nsfw");
    if (name?.old !== undefined) edits.name = String(name.old); else if (snapshot?.name && channel.name !== snapshot.name) edits.name = snapshot.name;
    if (parent?.old !== undefined) edits.parent = parent.old || null; else if (snapshot?.parentId !== undefined && channel.parentId !== snapshot.parentId) edits.parent = snapshot.parentId;
    if (topic?.old !== undefined && "topic" in channel) edits.topic = topic.old || null; else if (snapshot?.topic !== undefined && "topic" in channel && channel.topic !== snapshot.topic) edits.topic = snapshot.topic || null;
    if (nsfw?.old !== undefined && "nsfw" in channel) edits.nsfw = nsfw.old; else if (snapshot?.nsfw !== undefined && "nsfw" in channel && channel.nsfw !== snapshot.nsfw) edits.nsfw = snapshot.nsfw;
    if (Object.keys(edits).length) await channel.edit(edits, "Anti-nuke restoration").catch(() => {});
}

async function restoreRoleUpdate(guild, entry) {
    const role = guild.roles.cache.get(entry.targetId);
    const snapshot = roleSnapshots.get(entry.targetId);
    if (!role || !snapshot) return;
    const edits = {};
    for (const key of ["name", "color", "hoist", "mentionable", "permissions"]) {
        const change = getChange(entry, key);
        if (change?.old !== undefined) edits[key] = key === "permissions" ? BigInt(change.old) : change.old;
        else if (snapshot[key] !== undefined) edits[key] = key === "permissions" ? BigInt(snapshot[key]) : snapshot[key];
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

async function restoreOverwrite(guild, entry) {
    const channel = guild.channels.cache.get(entry.targetId);
    if (!channel?.permissionOverwrites) return;
    const overwriteId = entry.options?.id || getChange(entry, "id")?.new;
    if (!overwriteId) return;
    const overwrite = channel.permissionOverwrites.cache.get(String(overwriteId));
    const allow = getChange(entry, "allow")?.old;
    const deny = getChange(entry, "deny")?.old;
    if (entry.action === AuditLogEvent.ChannelOverwriteCreate) {
        if (overwrite) await channel.permissionOverwrites.delete(overwrite.id, "Anti-nuke restoration").catch(() => {});
        return;
    }
    if (allow === undefined && deny === undefined) return;
    await channel.permissionOverwrites.edit(overwriteId, { allow: BigInt(allow || 0), deny: BigInt(deny || 0) }, "Anti-nuke restoration").catch(() => {});
}

async function removeWebhook(guild, webhookId) {
    if (!webhookId) return;
    try {
        const webhooks = await guild.fetchWebhooks();
        const webhook = webhooks.get(webhookId);
        if (webhook) await webhook.delete("Anti-nuke webhook protection");
    } catch (error) {
        console.error("Webhook protection failed:", error);
    }
}

function captureOriginalOverwrite(guild, channel) {
    if (!channel?.permissionOverwrites) return null;
    const overwrite = channel.permissionOverwrites.cache.get(guild.roles.everyone.id);
    return overwrite ? { allow: overwrite.allow.bitfield.toString(), deny: overwrite.deny.bitfield.toString() } : null;
}

async function setLockdownChannel(channel, reason, snapshotMap) {
    if (!channel?.permissionOverwrites || !channel.guild) return false;
    const key = `${channel.guild.id}:${channel.id}`;
    if (!snapshotMap.has(key)) snapshotMap.set(key, captureOriginalOverwrite(channel.guild, channel));
    try {
        await channel.permissionOverwrites.edit(channel.guild.roles.everyone, { SendMessages: false, SendMessagesInThreads: false, CreatePublicThreads: false, CreatePrivateThreads: false }, reason);
        return true;
    } catch (error) {
        console.error(`Lockdown failed for ${channel.id}:`, error);
        return false;
    }
}

async function restoreLockdownChannel(channel, snapshot) {
    if (!channel?.permissionOverwrites) return;
    const everyone = channel.guild.roles.everyone;
    if (!snapshot) await channel.permissionOverwrites.delete(everyone, "Emergency lockdown ended").catch(() => {});
    else await channel.permissionOverwrites.edit(everyone, { allow: BigInt(snapshot.allow), deny: BigInt(snapshot.deny) }, "Emergency lockdown ended").catch(() => {});
}

async function enableManualLockdown(guild) {
    if (manualLockdowns.get(guild.id)?.active) return { changed: false, active: true };
    const channels = {};
    const snapshotMap = new Map();
    for (const channel of guild.channels.cache.values()) {
        if (!isGuildChannel(channel)) continue;
        const key = `${guild.id}:${channel.id}`;
        const snapshot = captureOriginalOverwrite(guild, channel);
        snapshotMap.set(key, snapshot);
        channels[channel.id] = snapshot;
    }
    manualLockdowns.set(guild.id, { active: true, channels });
    persistManualLockdown(guild);
    for (const channel of guild.channels.cache.values()) if (isGuildChannel(channel)) await setLockdownChannel(channel, "Emergency lockdown", snapshotMap);
    await logSecurity(guild, "Emergency lockdown enabled by the server owner. Public message and thread creation is blocked.", true);
    return { changed: true, active: true };
}

async function disableManualLockdown(guild) {
    const state = manualLockdowns.get(guild.id);
    if (!state?.active) return { changed: false, active: false };
    for (const channel of guild.channels.cache.values()) if (state.channels[channel.id] !== undefined) await restoreLockdownChannel(channel, state.channels[channel.id]);
    manualLockdowns.delete(guild.id);
    persistManualLockdown(guild);
    await logSecurity(guild, "Emergency lockdown disabled by the server owner; saved public permissions were restored where possible.", true);
    return { changed: true, active: false };
}

function manualLockdownActive(guildId) { return manualLockdowns.get(guildId)?.active === true; }
function getSecurityStatus(guild) {
    const manual = manualLockdowns.get(guild.id);
    const raid = raidState.get(guild.id);
    return { lockdown: Boolean(manual?.active), raidMode: Boolean(raid?.active), protectedChannels: manual?.active ? Object.keys(manual.channels).length : 0, trustedIds: trustedIds().length, botRolePosition: guild.members.me?.roles.highest.position ?? null };
}

function deferChannelSnapshot(channel) {
    if (!isGuildChannel(channel)) return;
    clearTimeout(pendingChannelRefresh.get(channel.id));
    pendingChannelRefresh.set(channel.id, setTimeout(() => { pendingChannelRefresh.delete(channel.id); snapshotChannel(channel); }, AUDIT_DEDUPE_MS));
}

function deferRoleSnapshot(role) {
    if (!role?.guild) return;
    clearTimeout(pendingRoleRefresh.get(role.id));
    pendingRoleRefresh.set(role.id, setTimeout(() => { pendingRoleRefresh.delete(role.id); snapshotRole(role); }, AUDIT_DEDUPE_MS));
}

async function punishRaidJoin(member) {
    try { if (!member.user.bot && member.moderatable) await member.timeout(10 * 60_000, "Anti-raid protection"); }
    catch (error) { console.error("Raid member mitigation failed:", error); }
}

async function enterRaidMode(guild) {
    if (raidState.get(guild.id)?.active) return;
    const snapshots = new Map();
    raidState.set(guild.id, { active: true, until: now() + RAID_IDLE_MS, snapshots });
    await logSecurity(guild, "Raid protection activated: rapid-join threshold exceeded. Locking public channels and mitigating new joins.", true);
    for (const channel of guild.channels.cache.values()) if (isGuildChannel(channel)) await setLockdownChannel(channel, "Anti-raid lockdown", snapshots);
    setTimeout(() => exitRaidMode(guild).catch(console.error), RAID_IDLE_MS + 250).unref();
}

async function exitRaidMode(guild) {
    const state = raidState.get(guild.id);
    if (!state?.active || state.until > now()) return;
    raidState.delete(guild.id);
    for (const channel of guild.channels.cache.values()) {
        const snapshot = state.snapshots.get(`${guild.id}:${channel.id}`);
        if (snapshot !== undefined && !manualLockdownActive(guild.id)) await restoreLockdownChannel(channel, snapshot);
    }
    if (!manualLockdownActive(guild.id)) await logSecurity(guild, "Raid protection ended; previous channel permissions were restored where possible.", true);
}

async function handleMemberAdd(member, client) {
    if (member.user.bot) {
        if (member.id !== client.user.id) await kickBotImmediately(member, client);
        return;
    }
    const timestamps = prune(joinTimes, member.guild.id, now() - RAID_WINDOW_MS);
    timestamps.push({ timestamp: now(), userId: member.id });
    joinTimes.set(member.guild.id, timestamps);
    const state = raidState.get(member.guild.id);
    if (state?.active) {
        state.until = now() + RAID_IDLE_MS;
        await punishRaidJoin(member);
        return;
    }
    if (timestamps.length >= RAID_JOIN_THRESHOLD) {
        await enterRaidMode(member.guild);
        for (const join of timestamps) {
            const joined = member.guild.members.cache.get(join.userId);
            if (joined) await punishRaidJoin(joined);
        }
    }
}

async function handleRoleAssignment(guild, entry, client) {
    const member = await guild.members.fetch(entry.targetId).catch(() => null);
    if (!member) return false;
    const changedRoleIds = [...parseSnowflakes(getChange(entry, "roles")?.new), ...parseSnowflakes(getChange(entry, "roles")?.old)];
    const suspicious = new Set();
    for (const roleId of changedRoleIds) {
        const role = guild.roles.cache.get(roleId);
        if (role && dangerousRole(role) && member.roles.cache.has(role.id) && role.editable) suspicious.add(role.id);
    }
    if (!suspicious.size) for (const role of member.roles.cache.values()) if (dangerousRole(role) && role.editable) suspicious.add(role.id);
    if (!suspicious.size) return false;
    const removed = [];
    for (const roleId of suspicious) if (await member.roles.remove(roleId, "Anti-nuke dangerous role assignment protection").then(() => true, () => false)) removed.push(roleId);
    if (!removed.length) return false;
    if (!isTrusted(guild, entry.executorId, client)) await punishExecutor(guild, entry.executorId, client, `dangerous role assignment detected on <@${member.id}>`);
    await logSecurity(guild, `Removed dangerous role(s) ${removed.map(id => `<@&${id}>`).join(", ")} from <@${member.id}> after action by <@${entry.executorId}>.`, true);
    return true;
}

async function punishExecutor(guild, executorId, client, reason) {
    if (!executorId || isTrusted(guild, executorId, client)) return;
    const user = await client.users.fetch(executorId).catch(() => null);
    if (user?.bot) return;
    const member = guild.members.cache.get(executorId) || await guild.members.fetch(executorId).catch(() => null);
    if (member?.bannable) await member.ban({ reason }).catch(error => console.error(`Security ban failed for ${executorId}:`, error));
    await logSecurity(guild, `${member?.bannable ? "Banned" : "Could not ban"} actioner <@${executorId}>. Reason: ${reason}`, true);
}

async function handleAuditEntry(entry, guild, client) {
    if (!entry?.action || !guild || !entry.executorId || !markAuditSeen(entry)) return;
    const action = entry.action;
    if (entry.executorId === client.user.id) {
        if (action === AuditLogEvent.MemberRoleUpdate) await handleRoleAssignment(guild, entry, client);
        return;
    }
    if (action === AuditLogEvent.BotAdd) {
        const botMember = guild.members.cache.get(entry.targetId) || await guild.members.fetch(entry.targetId).catch(() => null);
        if (botMember?.user?.bot) await kickBotImmediately(botMember, client);
        return;
    }
    if (action === AuditLogEvent.MemberRoleUpdate) await handleRoleAssignment(guild, entry, client);
    if (isTrusted(guild, entry.executorId, client)) return;
    if (action === AuditLogEvent.ChannelUpdate) {
        const newName = getChange(entry, "name")?.new;
        if (typeof newName === "string" && newName.toLowerCase().includes(MSC_TOKEN)) {
            await restoreChannelUpdate(guild, entry);
            await punishExecutor(guild, entry.executorId, client, `channel name changed to a name containing "${MSC_TOKEN}"`);
            deferChannelSnapshot(guild.channels.cache.get(entry.targetId));
            return;
        }
    }
    if (action === AuditLogEvent.RoleUpdate && rolePermissionEscalation(entry)) {
        await restoreRoleUpdate(guild, entry);
        await punishExecutor(guild, entry.executorId, client, "dangerous role permissions were escalated");
        deferRoleSnapshot(guild.roles.cache.get(entry.targetId));
        return;
    }
    if ([AuditLogEvent.ChannelOverwriteCreate, AuditLogEvent.ChannelOverwriteUpdate, AuditLogEvent.ChannelOverwriteDelete].includes(action)) {
        await restoreOverwrite(guild, entry);
        await punishExecutor(guild, entry.executorId, client, "unauthorized channel permission overwrite detected");
    }
    if ([AuditLogEvent.WebhookCreate, AuditLogEvent.WebhookUpdate, AuditLogEvent.WebhookDelete].includes(action)) {
        await removeWebhook(guild, entry.targetId);
        await punishExecutor(guild, entry.executorId, client, "unauthorized webhook activity detected");
    }
    const weight = actionWeight(action);
    if (!weight) return;
    const activity = recordAction(entry.executorId, weight, action);
    if (action === AuditLogEvent.ChannelDelete) await restoreDeletedChannel(guild, channelSnapshots.get(entry.targetId));
    if (action === AuditLogEvent.RoleDelete) await restoreDeletedRole(guild, roleSnapshots.get(entry.targetId));
    if (activity.score < NUKE_SCORE_THRESHOLD || enforcementLocks.has(entry.executorId)) return;
    enforcementLocks.add(entry.executorId);
    try {
        if (action === AuditLogEvent.ChannelCreate) await guild.channels.cache.get(entry.targetId)?.delete("Anti-nuke rollback").catch(() => {});
        if (action === AuditLogEvent.RoleCreate) await guild.roles.cache.get(entry.targetId)?.delete("Anti-nuke rollback").catch(() => {});
        if (action === AuditLogEvent.ChannelUpdate) await restoreChannelUpdate(guild, entry);
        if (action === AuditLogEvent.RoleUpdate) await restoreRoleUpdate(guild, entry);
        if (action === AuditLogEvent.GuildUpdate) await restoreGuildUpdate(guild, entry);
        await punishExecutor(guild, entry.executorId, client, `anti-nuke threshold exceeded (${activity.score} destructive score in ${WINDOW_MS / 1000}s)`);
    } finally {
        setTimeout(() => enforcementLocks.delete(entry.executorId), WINDOW_MS).unref();
    }
}

async function restorePersistedLockdowns(client) {
    const state = loadSecurityState();
    for (const guild of client.guilds.cache.values()) {
        const saved = state.guilds[guild.id];
        if (!saved?.manualLockdown) continue;
        const channels = saved.channels && typeof saved.channels === "object" ? saved.channels : {};
        manualLockdowns.set(guild.id, { active: true, channels });
        const snapshotMap = new Map(Object.entries(channels).map(([id, snapshot]) => [`${guild.id}:${id}`, snapshot]));
        for (const channel of guild.channels.cache.values()) if (isGuildChannel(channel)) await setLockdownChannel(channel, "Persistent emergency lockdown", snapshotMap);
    }
}

function initializeSecurity(client) {
    client.on("clientReady", async readyClient => {
        for (const guild of readyClient.guilds.cache.values()) snapshotGuild(guild);
        await restorePersistedLockdowns(readyClient);
    });
    client.on("channelCreate", channel => snapshotChannel(channel));
    client.on("channelUpdate", (oldChannel, newChannel) => { snapshotChannel(oldChannel); deferChannelSnapshot(newChannel); });
    client.on("channelDelete", channel => snapshotChannel(channel));
    client.on("roleCreate", role => snapshotRole(role));
    client.on("roleUpdate", (oldRole, newRole) => { snapshotRole(oldRole); deferRoleSnapshot(newRole); });
    client.on("roleDelete", role => snapshotRole(role));
    client.on("guildAuditLogEntryCreate", (entry, guild) => handleAuditEntry(entry, guild, client).catch(console.error));
    client.on("guildMemberAdd", member => handleMemberAdd(member, client).catch(console.error));
    client.on("guildDelete", guild => { raidState.delete(guild.id); joinTimes.delete(guild.id); manualLockdowns.delete(guild.id); });
}

module.exports = { initializeSecurity, enableManualLockdown, disableManualLockdown, getSecurityStatus };
