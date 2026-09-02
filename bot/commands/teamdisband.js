"use strict";

const {
    SlashCommandBuilder
} = require("discord.js");
const { loadData, saveData } = require("./database.js");
const { createErrorEmbed, createSuccessEmbed, createStatusEmbed } = require("./embeds.js");
const { removeAssistantManagerRoleIfUnused } = require("./assistantmanagerrole.js");
const { removeManagerRoleIfUnused } = require("./managerrole.js");
const { getTeamThumbnail, sendTransactionRecord } = require("./teamembeds.js");
const { canRunLeagueAdmin } = require("./permissions.js");
const { ensureGuildMembers } = require("./rosterutils.js");

const activeDisbands = new Set();

const command = {
    data: new SlashCommandBuilder()
        .setName("teamdisband")
        .setDescription("Disband a registered team.")
        .addRoleOption(option => option
            .setName("team")
            .setDescription("The registered team to disband.")
            .setRequired(true)),

    async execute(interaction) {
        if (!interaction.guild) {
            await interaction.reply({
                embeds: [createErrorEmbed("This command can only be used inside a server.")],
                ephemeral: true
            });
            return;
        }

        const data = loadData();
        if (!canRunLeagueAdmin(interaction, data)) {
            await interaction.reply({
                embeds: [createErrorEmbed("You do not have permission to disband teams.", interaction.guild)],
                ephemeral: true
            });
            return;
        }

        const selectedRole = interaction.options.getRole("team", true);
        const teamRole = interaction.guild.roles.cache.get(selectedRole.id);
        const team = data.teams[selectedRole.id];

        if (!teamRole || !team) {
            await interaction.reply({
                embeds: [createErrorEmbed("The selected role is not a registered team.", interaction.guild)],
                ephemeral: true
            });
            return;
        }

        const lockKey = `${interaction.guild.id}:${teamRole.id}`;
        if (activeDisbands.has(lockKey)) {
            await interaction.reply({
                embeds: [createErrorEmbed("This team is already being disbanded. Please wait a moment.")],
                ephemeral: true
            });
            return;
        }

        activeDisbands.add(lockKey);
        await interaction.deferReply({ ephemeral: true });

        const previousManagerId = team.managerid;
        const previousAssistantId = team.staff.assistant_manager;
        const removedMembers = [];

        try {
            await ensureGuildMembers(interaction.guild);

            const botMember = interaction.guild.members.me;
            if (!botMember || !teamRole.editable || teamRole.position >= botMember.roles.highest.position) {
                await interaction.editReply({
                    embeds: [createErrorEmbed("I cannot remove this team role. Make sure my bot role is above the team role and has Manage Roles permission.")]
                });
                return;
            }

            const membersWithTeamRole = [...teamRole.members.values()].filter(member => !member.user.bot);

            try {
                for (const member of membersWithTeamRole) {
                    await member.roles.remove(teamRole, `Team disbanded by ${interaction.user.tag}`);
                    removedMembers.push(member);
                }
            } catch (error) {
                console.error(error);

                // Restore every role we removed before reporting failure.
                for (const member of removedMembers.reverse()) {
                    await member.roles.add(teamRole, "Rolling back incomplete team disband").catch(console.error);
                }

                await interaction.editReply({
                    embeds: [createErrorEmbed("I couldn't remove the team role from every member, so the team was not disbanded. Any roles removed before the failure were restored.")]
                });
                return;
            }

            // Commit the database only after Discord role cleanup succeeded.
            const teamSnapshot = JSON.parse(JSON.stringify(team));
            delete data.teams[teamRole.id];

            try {
                saveData(data);
            } catch (error) {
                console.error(error);
                for (const member of removedMembers.reverse()) {
                    await member.roles.add(teamRole, "Rolling back failed team-disband database commit").catch(console.error);
                }
                await interaction.editReply({
                    embeds: [createErrorEmbed("I couldn't save the disbanding operation, so the team remains registered and member roles were restored.")]
                });
                return;
            }

            const managerRoleRemoved = await removeManagerRoleIfUnused(
                interaction.guild,
                previousManagerId,
                data,
                `Team disbanded by ${interaction.user.tag}`
            );
            const assistantRoleRemoved = previousAssistantId
                ? await removeAssistantManagerRoleIfUnused(
                    interaction.guild,
                    previousAssistantId,
                    data,
                    `Team disbanded by ${interaction.user.tag}`
                )
                : true;

            const rolesRemoved = managerRoleRemoved && assistantRoleRemoved;
            const description = rolesRemoved
                ? `${teamRole} has been disbanded.`
                : `${teamRole} has been disbanded, but a former leadership role needs manual removal.`;

            const embed = rolesRemoved
                ? createSuccessEmbed(interaction.guild, "Team Disbanded", description, [
                    { name: "Disbanded By", value: `${interaction.user}`, inline: true },
                    { name: "Players Removed", value: String(removedMembers.length), inline: true }
                ])
                : createStatusEmbed({
                    guild: interaction.guild,
                    title: "Team Disbanded with a Warning",
                    description,
                    fields: [
                        { name: "Disbanded By", value: `${interaction.user}`, inline: true },
                        { name: "Players Removed", value: String(removedMembers.length), inline: true }
                    ],
                    color: 0xfee75c
                });

            embed.setThumbnail(getTeamThumbnail(teamRole, interaction.guild));
            await interaction.editReply({ embeds: [embed] });
            await sendTransactionRecord(interaction.guild, data, embed);
        } finally {
            activeDisbands.delete(lockKey);
        }
    }
};

module.exports = { command };
