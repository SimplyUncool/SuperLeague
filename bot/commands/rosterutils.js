"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getTeamLeadershipIds = getTeamLeadershipIds;
exports.getRosterPlayers = getRosterPlayers;
exports.isRosterFull = isRosterFull;
exports.ensureGuildMembers = ensureGuildMembers;

const pendingFetches = new Map();
const lastFetchAt = new Map();
const FETCH_COOLDOWN_MS = 45000;

function getTeamLeadershipIds(team) {
    return new Set([team.managerid, ...Object.values(team.staff)].filter((id) => Boolean(id)));
}

function getRosterPlayers(teamRole, team) {
    return [...teamRole.members.values()].filter(member => !member.user.bot);
}

function isRosterFull(teamRole, team, rosterLimit) {
    return getRosterPlayers(teamRole, team).length >= rosterLimit;
}

async function ensureGuildMembers(guild) {
    const now = Date.now();
    const last = lastFetchAt.get(guild.id) ?? 0;
    if (guild.members.cache.size > 0 && now - last < FETCH_COOLDOWN_MS) {
        return;
    }
    const existing = pendingFetches.get(guild.id);
    if (existing) {
        await existing;
        return;
    }
    const promise = guild.members.fetch()
        .then(() => {
            lastFetchAt.set(guild.id, Date.now());
        })
        .catch((error) => {
            console.error(error);
            throw error;
        })
        .finally(() => {
            pendingFetches.delete(guild.id);
        });
    pendingFetches.set(guild.id, promise);
    await promise;
}
