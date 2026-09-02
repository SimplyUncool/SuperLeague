"use strict";

const { SlashCommandBuilder } = require("discord.js");
const { loadData, getRosterLimit } = require("./database.js");
const { createErrorEmbed, createSuccessEmbed, createStatusEmbed } = require("./embeds.js");
const { ensureGuildMembers, getRosterPlayers } = require("./rosterutils.js");

function chunkLines(lines, maxLength = 3400) {
    const chunks = [];
    let current = "";
    for (const line of lines) {
        if (current && current.length + line.length + 1 > maxLength) {
            chunks.push(current);
            current = "";
        }
        current += (current ? "\n" : "") + line;
    }
    if (current) chunks.push(current);
    return chunks;
}

const command = {
    data: new SlashCommandBuilder()
        .setName("overroster")
        .setDescription("List teams that are at or over their roster limit."),

    async execute(interaction) {
        if (!interaction.guild) {
            await interaction.reply({ embeds: [createErrorEmbed("This command can only be used inside a server.")], ephemeral: true });
            return;
        }

        const data = loadData();
        await interaction.deferReply({ ephemeral: true });

        try {
            await ensureGuildMembers(interaction.guild);
        } catch (error) {
            console.error(error);
            await interaction.editReply({ embeds: [createErrorEmbed("I could not load the team rosters. Make sure Server Members Intent is enabled.", interaction.guild)] });
            return;
        }

        const rosterLimit = getRosterLimit(data, interaction.guild.id);
        const overTeams = Object.entries(data.teams)
            .map(([roleId, team]) => {
                const role = interaction.guild.roles.cache.get(roleId);
                if (!role) return null;
                const count = getRosterPlayers(role, team).length;
                return count < rosterLimit ? null : { role, team, count };
            })
            .filter(Boolean)
            .sort((a, b) => b.count - a.count);

        if (!overTeams.length) {
            await interaction.editReply({ embeds: [createSuccessEmbed(interaction.guild, "No Over-Limit Teams", `No registered teams are at or over the roster limit of **${rosterLimit}**.`)] });
            return;
        }

        const lines = overTeams.map(({ role, team, count }) =>
            `${role} — ${team.managerid ? `<@${team.managerid}>` : "Vacant"} — **${count}/${rosterLimit}** (${count > rosterLimit ? "OVER" : "FULL"})`
        );
        const pages = chunkLines(lines);
        const embeds = pages.slice(0, 10).map((description, index) => createStatusEmbed({
            guild: interaction.guild,
            title: pages.length > 1 ? `Teams At or Over Roster Limit (${index + 1}/${pages.length})` : "Teams At or Over Roster Limit",
            description,
            color: 0xed4245,
            fields: index === 0 ? [
                { name: "Roster Limit", value: String(rosterLimit), inline: true },
                { name: "Teams Listed", value: String(overTeams.length), inline: true }
            ] : []
        }));

        await interaction.editReply({ embeds });
    }
};

module.exports = { command };
