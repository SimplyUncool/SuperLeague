"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.command = void 0;
const discord_js_1 = require("discord.js");
const database_js_1 = require("./database.js");
const embeds_js_1 = require("./embeds.js");
const rosterutils_js_1 = require("./rosterutils.js");

exports.command = {
    data: new discord_js_1.SlashCommandBuilder()
        .setName("overroster")
        .setDescription("List teams that are at or over their roster limit."),

    async execute(interaction) {
        if (!interaction.guild) {
            await interaction.reply({
                embeds: [(0, embeds_js_1.createErrorEmbed)("This command can only be used inside a server.")],
                ephemeral: true
            });
            return;
        }

        const data = (0, database_js_1.loadData)();
        await interaction.deferReply({ ephemeral: true });

        try {
            await (0, rosterutils_js_1.ensureGuildMembers)(interaction.guild);
        } catch (error) {
            console.error(error);
            await interaction.editReply({
                embeds: [
                    (0, embeds_js_1.createErrorEmbed)(
                        "I could not load the team rosters. Make sure Server Members Intent is enabled.",
                        interaction.guild
                    )
                ]
            });
            return;
        }

        const rosterLimit = (0, database_js_1.getRosterLimit)(data, interaction.guild.id);

        const overTeams = Object.entries(data.teams)
            .map(([roleId, team]) => {
                const role = interaction.guild?.roles.cache.get(roleId);
                if (!role) return null;
                const count = (0, rosterutils_js_1.getRosterPlayers)(role, team).length;
                if (count < rosterLimit) return null;
                return {
                    role,
                    team,
                    count
                };
            })
            .filter(Boolean)
            .sort((a, b) => b.count - a.count);

        if (!overTeams.length) {
            await interaction.editReply({
                embeds: [
                    (0, embeds_js_1.createSuccessEmbed)(
                        interaction.guild,
                        "No Over-Limit Teams",
                        `No registered teams are at or over the roster limit of **${rosterLimit}**.`
                    )
                ]
            });
            return;
        }

        const lines = overTeams.map(({ role, team, count }) => {
            const manager = team.managerid ? `<@${team.managerid}>` : "Vacant";
            const status = count > rosterLimit ? "OVER" : "FULL";
            return `${role} — ${manager} — **${count}/${rosterLimit}** (${status})`;
        });

        const embed = (0, embeds_js_1.createStatusEmbed)({
            guild: interaction.guild,
            title: "Teams At or Over Roster Limit",
            description: lines.join("\n"),
            color: 0xed4245,
            fields: [
                { name: "Roster Limit", value: String(rosterLimit), inline: true },
                { name: "Teams Listed", value: String(overTeams.length), inline: true }
            ]
        });

        await interaction.editReply({ embeds: [embed] });
    }
};
