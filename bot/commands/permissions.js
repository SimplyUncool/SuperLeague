"use strict";

const { PermissionFlagsBits } = require("discord.js");

function isOwner(data, userId) {
    return Boolean(userId) && data?.settings?.owner_id === userId;
}

function hasAccess(data, userId, scope) {
    if (isOwner(data, userId)) return true;

    const whitelist = data?.settings?.whitelists?.[scope];
    return Array.isArray(whitelist) && whitelist.includes(userId);
}

function canRunLeagueAdmin(interaction, data) {
    return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) === true ||
        hasAccess(data, interaction.user.id, "league_admin");
}

module.exports = {
    isOwner,
    hasAccess,
    canRunLeagueAdmin
};
