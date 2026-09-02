"use strict";

const { EmbedBuilder } = require("discord.js");
const { getTransactionChannelId, getLogChannelId, getRosterLimit } = require("./database.js");
const { getRosterPlayers } = require("./rosterutils.js");

function getTeamEmoji(role) {
    const match = role.name.match(/<a?:\w+:\d+>/);
    return match?.[0] ?? "⚽";
}

function getTeamEmojiUrl(role) {
    const match = role.name.match(/<a?:(\w+):(\d+)>/);
    if (!match) return null;
    return `https://cdn.discordapp.com/emojis/${match[2]}.${role.name.includes("<a:") ? "gif" : "png"}`;
}

function getTeamThumbnail(role, guild) {
    return getTeamEmojiUrl(role) ?? role.iconURL({ size: 128 }) ?? guild.iconURL({ size: 128 });
}

function createTeamTransactionEmbed(options) {
    const guildIcon = options.guild.iconURL({ size: 128 }) ?? undefined;
    const manager = options.team.managerid ? `<@${options.team.managerid}>` : "Vacant";
    const rosterSize = getRosterPlayers(options.teamRole, options.team).length;
    const rosterLimit = getRosterLimit(options.data, options.guild.id);

    return new EmbedBuilder()
        .setColor(options.color ?? (options.teamRole.color || 0x5865f2))
        .setAuthor({ name: options.guild.name, iconURL: guildIcon })
        .setTitle(options.title)
        .setDescription(options.description)
        .addFields(
            { name: "📊 Roster", value: `\`${rosterSize}/${rosterLimit}\``, inline: true },
            { name: "💼 Manager", value: manager, inline: true },
            ...(options.extraFields ?? [])
        )
        .setThumbnail(getTeamThumbnail(options.teamRole, options.guild))
        .setFooter({ text: `${options.guild.name} • Transactions`, iconURL: guildIcon })
        .setTimestamp();
}

async function sendTransactionEmbed(guild, channelId, embed) {
    if (!channelId) return true;

    const channel = guild.channels.cache.get(channelId);
    if (!channel?.isTextBased()) {
        console.warn(`Transaction log channel ${channelId} was not found or is not text based.`);
        return false;
    }

    try {
        await channel.send({ embeds: [embed] });
        return true;
    } catch (error) {
        console.error(`Failed to send transaction log to ${channelId}:`, error);
        return false;
    }
}

async function sendTransactionRecord(guild, data, embed) {
    const channelIds = new Set([
        getTransactionChannelId(data, guild.id),
        getLogChannelId(data, guild.id)
    ]);

    let success = true;
    for (const channelId of channelIds) {
        if (!channelId) continue;
        if (!(await sendTransactionEmbed(guild, channelId, embed))) success = false;
    }

    return success;
}

module.exports = {
    getTeamEmoji,
    getTeamThumbnail,
    createTeamTransactionEmbed,
    sendTransactionEmbed,
    sendTransactionRecord
};
