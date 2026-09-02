"use strict";

const { SlashCommandBuilder } = require("discord.js");
const { loadData, getRosterLimit } = require("./database.js");
const { createErrorEmbed, createStatusEmbed } = require("./embeds.js");
const { ensureGuildMembers, getRosterPlayers } = require("./rosterutils.js");

function chunkLines(lines, maxLength = 3800) {
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
        .setName("teamlist")
        .setDescription("View every registered team in this server."),

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
            await interaction.editReply({ embeds: [createErrorEmbed("I could not load the team list. Make sure Server Members Intent is enabled.", interaction.guild)] });
            return;
        }

        const teams = Object.entries(data.teams)
            .map(([roleId, team]) => ({ role: interaction.guild.roles.cache.get(roleId), team }))
            .filter(entry => entry.role);

        if (!teams.length) {
            await interaction.editReply({
                embeds: [createStatusEmbed({ guild: interaction.guild, title: "No Registered Teams", description: "There are no registered teams in this server yet." })]
            });
            return;
        }

        const rosterLimit = getRosterLimit(data, interaction.guild.id);
        const lines = teams.map(({ role, team }) =>
            `${role} — ${team.managerid ? `<@${team.managerid}>` : "Vacant"} — ${getRosterPlayers(role, team).length}/${rosterLimit} players`
        );
        const pages = chunkLines(lines);

        const embeds = pages.slice(0, 10).map((description, index) =>
            createStatusEmbed({
                guild: interaction.guild,
                title: pages.length > 1 ? `Registered Teams (${index + 1}/${pages.length})` : "Registered Teams",
                description
            })
        );

        if (pages.length > 10) {
            embeds[9].setFooter({ text: `Showing first 10 pages of ${pages.length}.` });
        }

        await interaction.editReply({ embeds });
    }
};

module.exports = { command };
