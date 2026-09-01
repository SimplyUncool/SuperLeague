"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.command = void 0;
exports.isPlayerManagerInGuild = isPlayerManagerInGuild;
exports.getConfiguredPlayerManagerRole = getConfiguredPlayerManagerRole;
exports.assignPlayerManagerRoles = assignPlayerManagerRoles;
exports.syncPlayerManagerMemberRoles = syncPlayerManagerMemberRoles;
exports.removePlayerManagerRoleIfUnused = removePlayerManagerRoleIfUnused;
exports.syncAllPlayerManagerRoles = syncAllPlayerManagerRoles;

const discord_js_1 = require("discord.js");
const database_js_1 = require("./database.js");
const embeds_js_1 = require("./embeds.js");
const managerrole_js_1 = require("./managerrole.js");
const assistantmanagerrole_js_1 = require("./assistantmanagerrole.js");
const permissions_js_1 = require("./permissions.js");

function getPlayerManagerTeamRoles(data, guild, userId) {
    return Object.entries(data.teams)
        .filter(([, team]) => team.staff.player_manager === userId)
        .map(([roleId]) => guild.roles.cache.get(roleId))
        .filter((role) => Boolean(role));
}

function isPlayerManagerInGuild(data, guild, userId) {
    return getPlayerManagerTeamRoles(data, guild, userId).length > 0;
}

function getConfiguredPlayerManagerRole(data, guild) {
    const roleId = data.settings.playerManagerRoles[guild.id];
    return roleId ? guild.roles.cache.get(roleId) ?? null : null;
}

function ensureRoleCanBeAssigned(role, label) {
    if (!role.editable) {
        throw new Error(`I cannot assign the ${label}. Place my bot role above ${role} and make sure I have Manage Roles.`);
    }
}

async function assignPlayerManagerRoles(member, teamRole, data, reason) {
    const playerManagerRole = getConfiguredPlayerManagerRole(data, member.guild);
    if (!playerManagerRole) {
        throw new Error("Set a player manager role first with `/playermanagerrole`.");
    }
    if (!member.manageable) {
        throw new Error(`I cannot manage ${member}. Place my bot role above their highest role and try again.`);
    }

    ensureRoleCanBeAssigned(playerManagerRole, "configured player manager role");
    ensureRoleCanBeAssigned(teamRole, "team role");

    const missingRoles = [playerManagerRole, teamRole].filter(role => !member.roles.cache.has(role.id));
    if (missingRoles.length) {
        await member.roles.add(missingRoles, reason);
    }
}

async function syncPlayerManagerMemberRoles(member, data, reason) {
    const teamRoles = getPlayerManagerTeamRoles(data, member.guild, member.id);
    if (!teamRoles.length) return 0;

    const playerManagerRole = getConfiguredPlayerManagerRole(data, member.guild);
    if (!playerManagerRole) return 0;

    if (!member.manageable) {
        throw new Error(`Cannot manage ${member.user.tag}.`);
    }

    ensureRoleCanBeAssigned(playerManagerRole, "configured player manager role");
    for (const teamRole of teamRoles) {
        ensureRoleCanBeAssigned(teamRole, "team role");
    }

    const missingRoles = [playerManagerRole, ...teamRoles].filter(role => !member.roles.cache.has(role.id));
    if (missingRoles.length) {
        await member.roles.add(missingRoles, reason);
    }

    return missingRoles.length;
}

async function removePlayerManagerRoleIfUnused(guild, userId, data, reason) {
    if (isPlayerManagerInGuild(data, guild, userId)) return true;

    const playerManagerRole = getConfiguredPlayerManagerRole(data, guild);
    if (!playerManagerRole) return true;

    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member || !member.roles.cache.has(playerManagerRole.id)) return true;
    if (!member.manageable || !playerManagerRole.editable) return false;

    return member.roles.remove(playerManagerRole, reason).then(() => true, error => {
        console.error(error);
        return false;
    });
}

async function syncAllPlayerManagerRoles(client) {
    const data = (0, database_js_1.loadData)();

    for (const guild of client.guilds.cache.values()) {
        if (!getConfiguredPlayerManagerRole(data, guild)) continue;

        const playerManagerIds = new Set(
            Object.entries(data.teams)
                .filter(([roleId]) => guild.roles.cache.has(roleId))
                .map(([, team]) => team.staff.player_manager)
                .filter((id) => Boolean(id))
        );

        for (const playerManagerId of playerManagerIds) {
            const member = await guild.members.fetch(playerManagerId).catch(() => null);
            if (!member) continue;

            await syncPlayerManagerMemberRoles(member, data, "Restoring configured player manager and team roles")
                .catch(console.error);

            await new Promise(r => setTimeout(r, 400));
        }
    }
}

exports.command = {
    data: new discord_js_1.SlashCommandBuilder()
        .setName("playermanagerrole")
        .setDescription("Set the Discord role assigned to player managers.")
        .addRoleOption(option => option
            .setName("role")
            .setDescription("The shared player manager role.")
            .setRequired(true)),

    async execute(interaction) {
        if (!interaction.guild) {
            await interaction.reply({
                embeds: [(0, embeds_js_1.createErrorEmbed)("This command can only be used inside a server.")],
                ephemeral: true
            });
            return;
        }

        const data = (0, database_js_1.loadData)();
        if (!(0, permissions_js_1.canRunLeagueAdmin)(interaction, data)) {
            await interaction.reply({
                embeds: [
                    (0, embeds_js_1.createErrorEmbed)("You do not have permission to configure the player manager role.", interaction.guild)
                ],
                ephemeral: true
            });
            return;
        }

        const selectedRole = interaction.options.getRole("role", true);
        const playerManagerRole = interaction.guild.roles.cache.get(selectedRole.id);

        if (!playerManagerRole || playerManagerRole.id === interaction.guild.id) {
            await interaction.reply({
                embeds: [
                    (0, embeds_js_1.createErrorEmbed)("Choose a normal Discord role instead of @everyone.", interaction.guild)
                ],
                ephemeral: true
            });
            return;
        }

        if (data.teams[playerManagerRole.id]) {
            await interaction.reply({
                embeds: [
                    (0, embeds_js_1.createErrorEmbed)("A registered team role cannot also be the player manager role.", interaction.guild)
                ],
                ephemeral: true
            });
            return;
        }

        if ((0, managerrole_js_1.getConfiguredManagerRole)(data, interaction.guild)?.id === playerManagerRole.id) {
            await interaction.reply({
                embeds: [
                    (0, embeds_js_1.createErrorEmbed)("The manager and player manager roles must be different.", interaction.guild)
                ],
                ephemeral: true
            });
            return;
        }

        if ((0, assistantmanagerrole_js_1.getConfiguredAssistantManagerRole)(data, interaction.guild)?.id === playerManagerRole.id) {
            await interaction.reply({
                embeds: [
                    (0, embeds_js_1.createErrorEmbed)("The assistant manager and player manager roles must be different.", interaction.guild)
                ],
                ephemeral: true
            });
            return;
        }

        if (!playerManagerRole.editable) {
            await interaction.reply({
                embeds: [
                    (0, embeds_js_1.createErrorEmbed)(`I cannot assign ${playerManagerRole}. Place my bot role above it and grant Manage Roles.`, interaction.guild)
                ],
                ephemeral: true
            });
            return;
        }

        await interaction.deferReply({ ephemeral: true });

        const previousRoleId = data.settings.playerManagerRoles[interaction.guild.id];
        const previousRole = previousRoleId
            ? interaction.guild.roles.cache.get(previousRoleId)
            : null;

        data.settings.playerManagerRoles[interaction.guild.id] = playerManagerRole.id;
        (0, database_js_1.saveData)(data);

        const playerManagerIds = new Set(
            Object.entries(data.teams)
                .filter(([roleId]) => interaction.guild?.roles.cache.has(roleId))
                .map(([, team]) => team.staff.player_manager)
                .filter((id) => Boolean(id))
        );

        let synced = 0;
        let failed = 0;

        for (const playerManagerId of playerManagerIds) {
            const member = await interaction.guild.members.fetch(playerManagerId).catch(() => null);
            if (!member) {
                failed += 1;
                continue;
            }

            try {
                await syncPlayerManagerMemberRoles(member, data, `Player manager role configured by ${interaction.user.tag}`);

                if (previousRole &&
                    previousRole.id !== playerManagerRole.id &&
                    member.roles.cache.has(previousRole.id)) {
                    await member.roles.remove(previousRole, `Player manager role changed by ${interaction.user.tag}`);
                }

                synced += 1;
            } catch (error) {
                console.error(error);
                failed += 1;
            }

            await new Promise(r => setTimeout(r, 400));
        }

        const embed = failed
            ? (0, embeds_js_1.createStatusEmbed)({
                guild: interaction.guild,
                title: "Player Manager Role Saved with Warnings",
                description: `${playerManagerRole} is now the player manager role. Some existing player managers could not be updated.`,
                color: 0xfee75c,
                fields: [
                    { name: "Player Managers Updated", value: String(synced), inline: true },
                    { name: "Needs Attention", value: String(failed), inline: true }
                ]
            })
            : (0, embeds_js_1.createSuccessEmbed)(
                interaction.guild,
                "Player Manager Role Set",
                `${playerManagerRole} is now the shared player manager role.`,
                [{ name: "Player Managers Updated", value: String(synced), inline: true }]
            );

        await interaction.editReply({ embeds: [embed] });
    }
};
