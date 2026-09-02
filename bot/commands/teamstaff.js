"use strict";

const { randomInt } = require("crypto");
const { SlashCommandBuilder } = require("discord.js");
const { loadData, saveData, getRosterLimit } = require("./database.js");
const { createErrorEmbed, createSuccessEmbed, createStatusEmbed } = require("./embeds.js");
const {
    getConfiguredManagerRole,
    assignManagerRoles,
    removeFormerManagerRoles,
    removeManagerRoleIfUnused
} = require("./managerrole.js");
const {
    assignAssistantManagerRoles,
    removeAssistantManagerRoleIfUnused
} = require("./assistantmanagerrole.js");
const {
    assignPlayerManagerRoles,
    removePlayerManagerRoleIfUnused
} = require("./playermanagerrole.js");
const { getTeamThumbnail, sendTransactionRecord } = require("./teamembeds.js");
const { canRunLeagueAdmin } = require("./permissions.js");
const { ensureGuildMembers, isRosterFull } = require("./rosterutils.js");

const POSITION_LABELS = {
    assistant_manager: "Assistant Manager",
    player_manager: "Player Manager"
};

function positionOptions(builder) {
    return builder.addStringOption(option => option
        .setName("position")
        .setDescription("The team staff position.")
        .setRequired(true)
        .addChoices(
            { name: "Assistant Manager", value: "assistant_manager" },
            { name: "Player Manager", value: "player_manager" }
        ));
}

function getPosition(interaction) {
    return interaction.options.getString("position", true);
}

function findExistingLeadershipRole(data, userId) {
    for (const [teamRoleId, team] of Object.entries(data.teams)) {
        if (team.managerid === userId) return { teamRoleId, label: "Manager" };
        for (const [position, staffId] of Object.entries(team.staff)) {
            if (staffId === userId) return { teamRoleId, label: POSITION_LABELS[position] };
        }
    }
    return null;
}

function findTeamAccess(data, userId) {
    for (const [teamRoleId, team] of Object.entries(data.teams)) {
        if (team.managerid === userId) return { teamRoleId, team, authority: "manager" };
        for (const [position, staffId] of Object.entries(team.staff)) {
            if (staffId === userId) return { teamRoleId, team, authority: position };
        }
    }
    return null;
}

function isTeamStaffMember(team, userId) {
    return Object.values(team.staff).includes(userId);
}

function canPromote(authority, position) {
    return authority === "manager" ||
        (authority === "assistant_manager" && position === "player_manager");
}

function canDemote(authority) {
    return authority === "manager";
}

async function sendTransactionLog(interaction, embed) {
    if (!interaction.guild) return;
    const data = loadData();
    await sendTransactionRecord(interaction.guild, data, embed);
}

async function rollbackRoles(member, roleIds, reason) {
    const roles = roleIds
        .map(id => member.guild.roles.cache.get(id))
        .filter(Boolean);
    if (!roles.length) return;
    await member.roles.remove(roles, reason).catch(console.error);
}

const setCandidateRoleCommand = {
    data: new SlashCommandBuilder()
        .setName("setcandidaterole")
        .setDescription("Set the role used as the manager lottery pool.")
        .addRoleOption(option => option
            .setName("role")
            .setDescription("Members of this role can be selected as managers.")
            .setRequired(true)),

    async execute(interaction) {
        if (!interaction.guild) {
            return interaction.reply({ embeds: [createErrorEmbed("This command can only be used inside a server.")], ephemeral: true });
        }

        const data = loadData();
        if (!canRunLeagueAdmin(interaction, data)) {
            return interaction.reply({ embeds: [createErrorEmbed("You do not have permission to set the candidate role.")], ephemeral: true });
        }

        const role = interaction.guild.roles.cache.get(interaction.options.getRole("role", true).id);
        if (!role || role.id === interaction.guild.id) {
            return interaction.reply({ embeds: [createErrorEmbed("The @everyone role cannot be used as the candidate pool.")], ephemeral: true });
        }
        if (getConfiguredManagerRole(data, interaction.guild)?.id === role.id) {
            return interaction.reply({ embeds: [createErrorEmbed("The candidate and manager roles must be different.")], ephemeral: true });
        }
        if (!role.editable) {
            return interaction.reply({ embeds: [createErrorEmbed(`I cannot remove ${role} after a manager is selected. Place my bot role above it and try again.`)], ephemeral: true });
        }

        data.settings.candidateRoles[interaction.guild.id] = role.id;
        saveData(data);

        await interaction.reply({
            embeds: [createSuccessEmbed(interaction.guild, "Candidate Role Set", `${role} is now the manager lottery pool for this server.`)],
            ephemeral: true
        });
    }
};

const fofillCommand = {
    data: new SlashCommandBuilder()
        .setName("fofill")
        .setDescription("Randomly select a manager for a team from the candidate role.")
        .addRoleOption(option => option
            .setName("team")
            .setDescription("The team whose manager will be selected.")
            .setRequired(true)),

    async execute(interaction) {
        if (!interaction.guild) return interaction.reply({ embeds: [createErrorEmbed("This command can only be used inside a server.")], ephemeral: true });

        const data = loadData();
        if (!canRunLeagueAdmin(interaction, data)) return interaction.reply({ embeds: [createErrorEmbed("You do not have permission to run the manager lottery.")], ephemeral: true });

        await interaction.deferReply({ ephemeral: true });

        const teamRole = interaction.guild.roles.cache.get(interaction.options.getRole("team", true).id);
        if (!teamRole) return interaction.editReply({ embeds: [createErrorEmbed("That team role could not be found in this server.")] });

        const team = data.teams[teamRole.id];
        if (!team) return interaction.editReply({ embeds: [createErrorEmbed(`${teamRole} is not a registered team.`)] });

        const managerRole = getConfiguredManagerRole(data, interaction.guild);
        const candidateRoleId = data.settings.candidateRoles[interaction.guild.id];
        if (!managerRole) return interaction.editReply({ embeds: [createErrorEmbed("Set a manager role first with `/managerrole`.")] });
        if (!candidateRoleId) return interaction.editReply({ embeds: [createErrorEmbed("Set a candidate role first with `/setcandidaterole`.")] });

        try {
            await ensureGuildMembers(interaction.guild);
        } catch (error) {
            console.error(error);
            return interaction.editReply({ embeds: [createErrorEmbed("I could not load the full candidate list. Enable Server Members Intent for the bot and try again.")] });
        }

        const candidateRole = interaction.guild.roles.cache.get(candidateRoleId);
        if (!candidateRole) return interaction.editReply({ embeds: [createErrorEmbed("The saved candidate role no longer exists. Run `/setcandidaterole` again.")] });
        if (candidateRole.id === teamRole.id || candidateRole.id === managerRole.id) {
            return interaction.editReply({ embeds: [createErrorEmbed("The candidate role must be different from the team and manager roles.")] });
        }
        if (!candidateRole.editable) return interaction.editReply({ embeds: [createErrorEmbed(`I cannot remove ${candidateRole} from the selected candidate. Place my bot role above it and try again.`)] });

        const eligible = candidateRole.members.filter(member =>
            !member.user.bot &&
            member.manageable &&
            !Object.keys(data.teams).some(roleId => roleId !== teamRole.id && member.roles.cache.has(roleId)) &&
            !findExistingLeadershipRole(data, member.id)
        );

        if (!eligible.size) return interaction.editReply({ embeds: [createErrorEmbed(`${candidateRole} has no eligible candidates.`)] });

        const candidates = [...eligible.values()];
        const winner = candidates[randomInt(candidates.length)];
        const previousManagerId = team.managerid;
        const originalRoles = new Set(winner.roles.cache.keys());

        try {
            await assignManagerRoles(winner, teamRole, data, `Selected by ${interaction.user.tag} in /fofill`);
            await winner.roles.remove(candidateRole, `Appointed manager by ${interaction.user.tag}`);
        } catch (error) {
            await rollbackRoles(winner, [...winner.roles.cache.keys()].filter(id => !originalRoles.has(id)), "Rolling back incomplete manager appointment");
            await interaction.editReply({ embeds: [createErrorEmbed(error instanceof Error ? error.message : "I could not complete the manager appointment.")] });
            return;
        }

        team.managerid = winner.id;
        try {
            saveData(data);
        } catch (error) {
            console.error(error);
            await rollbackRoles(winner, [...winner.roles.cache.keys()].filter(id => !originalRoles.has(id)), "Rolling back failed manager appointment");
            await winner.roles.add(candidateRole, "Restoring candidate role after failed database commit").catch(console.error);
            team.managerid = previousManagerId;
            await interaction.editReply({ embeds: [createErrorEmbed("I couldn't save the manager appointment, so the Discord roles were rolled back.")] });
            return;
        }

        const oldRoleRemoved = previousManagerId
            ? await removeFormerManagerRoles(interaction.guild, previousManagerId, teamRole, data, `Replaced by /fofill run by ${interaction.user.tag}`)
            : true;

        const notified = await winner.send({
            embeds: [createStatusEmbed({
                guild: interaction.guild,
                title: "Team Manager Appointment",
                description: `You’ve been appointed Team Manager of **${teamRole.name}**!`,
                color: teamRole.color || 0x5865f2
            }).setThumbnail(getTeamThumbnail(teamRole, interaction.guild))]
        }).then(() => true, error => {
            console.error(error);
            return false;
        });

        const resultEmbed = createStatusEmbed({
            guild: interaction.guild,
            title: oldRoleRemoved && notified ? "Manager Appointment Complete" : "Manager Appointment Complete with a Warning",
            description: !notified
                ? "The appointment is complete, but I could not send the candidate a direct message."
                : !oldRoleRemoved
                    ? "The candidate has been notified, but the previous manager's roles need manual removal."
                    : "The appointment is complete and the candidate has been notified.",
            fields: [
                { name: "Team", value: `${teamRole}`, inline: true },
                { name: "Eligible Candidates", value: String(candidates.length), inline: true }
            ],
            color: oldRoleRemoved && notified ? 0x57f287 : 0xfee75c
        }).setThumbnail(getTeamThumbnail(teamRole, interaction.guild));

        await interaction.editReply({ embeds: [resultEmbed] });
    }
};

const promoteCommand = {
    data: positionOptions(
        new SlashCommandBuilder()
            .setName("promote")
            .setDescription("Promote a member of your team to a staff position.")
    ).addUserOption(option => option
        .setName("member")
        .setDescription("The team member to promote.")
        .setRequired(true)),

    async execute(interaction) {
        if (!interaction.guild) return interaction.reply({ embeds: [createErrorEmbed("This command can only be used inside a server.")], ephemeral: true });

        const data = loadData();
        const access = findTeamAccess(data, interaction.user.id);
        const position = getPosition(interaction);
        if (!access || !canPromote(access.authority, position)) return interaction.reply({ embeds: [createErrorEmbed(position === "assistant_manager" ? "Only the team manager can appoint an assistant manager." : "Only a team manager or assistant manager can promote a player manager.")], ephemeral: true });
        if (!access.team.managerid) return interaction.reply({ embeds: [createErrorEmbed("This team is frozen until a new manager is appointed.")], ephemeral: true });

        await interaction.deferReply({ ephemeral: true });

        const selectedMember = interaction.options.getUser("member", true);
        const member = await interaction.guild.members.fetch(selectedMember.id).catch(() => null);
        if (!member) return interaction.editReply({ embeds: [createErrorEmbed("That member could not be found in this server.")] });

        const teamRole = interaction.guild.roles.cache.get(access.teamRoleId);
        if (!teamRole) return interaction.editReply({ embeds: [createErrorEmbed("Your team's Discord role no longer exists.")] });
        if (member.user.bot) return interaction.editReply({ embeds: [createErrorEmbed("Bots cannot hold team staff positions.")] });
        if (access.authority === "assistant_manager" && member.id === interaction.user.id) return interaction.editReply({ embeds: [createErrorEmbed("Assistant managers cannot promote themselves.")] });

        const otherTeamId = Object.keys(data.teams).find(roleId => roleId !== teamRole.id && member.roles.cache.has(roleId));
        if (otherTeamId) return interaction.editReply({ embeds: [createErrorEmbed(`${member} is already on another registered team.`)] });

        const existingRole = findExistingLeadershipRole(data, member.id);
        if (existingRole) return interaction.editReply({ embeds: [createErrorEmbed(`${member} is already a ${existingRole.label}. Demote them from that position first.`)] });

        if (access.team.staff[position]) return interaction.editReply({ embeds: [createErrorEmbed(`${POSITION_LABELS[position]} is already held by <@${access.team.staff[position]}>. Demote them first.`)] });

        if (!member.roles.cache.has(teamRole.id) && isRosterFull(teamRole, access.team, getRosterLimit(data, interaction.guild.id))) {
            return interaction.editReply({ embeds: [createErrorEmbed(`${teamRole} has reached its roster limit. Release a player before promoting someone who is not already on the team.`)] });
        }

        const originalRoles = new Set(member.roles.cache.keys());
        try {
            if (position === "assistant_manager") {
                await assignAssistantManagerRoles(member, teamRole, data, `Promoted by ${interaction.user.tag}`);
            } else {
                await assignPlayerManagerRoles(member, teamRole, data, `Promoted by ${interaction.user.tag}`);
            }
        } catch (error) {
            return interaction.editReply({ embeds: [createErrorEmbed(error instanceof Error ? error.message : "I could not assign the required roles.")] });
        }

        access.team.staff[position] = member.id;
        try {
            saveData(data);
        } catch (error) {
            console.error(error);
            await rollbackRoles(member, [...member.roles.cache.keys()].filter(id => !originalRoles.has(id)), "Rolling back failed staff promotion");
            access.team.staff[position] = null;
            await interaction.editReply({ embeds: [createErrorEmbed("I couldn't save the promotion, so the Discord roles were rolled back.")] });
            return;
        }

        const embed = createSuccessEmbed(
            interaction.guild,
            "Team Staff Promotion",
            `${member} has been promoted to **${POSITION_LABELS[position]}** for ${teamRole}.`,
            [{ name: "Promoted By", value: `${interaction.user}`, inline: true }]
        ).setThumbnail(getTeamThumbnail(teamRole, interaction.guild));

        await interaction.editReply({ embeds: [embed] });
        await sendTransactionLog(interaction, embed);
    }
};

const demoteCommand = {
    data: positionOptions(
        new SlashCommandBuilder()
            .setName("demote")
            .setDescription("Remove a member from a team staff position.")
    ).addUserOption(option => option
        .setName("member")
        .setDescription("The team staff member to demote.")
        .setRequired(true)),

    async execute(interaction) {
        if (!interaction.guild) return interaction.reply({ embeds: [createErrorEmbed("This command can only be used inside a server.")], ephemeral: true });

        const data = loadData();
        const access = findTeamAccess(data, interaction.user.id);
        if (!access || !canDemote(access.authority)) return interaction.reply({ embeds: [createErrorEmbed("Only the team manager can demote team staff.")], ephemeral: true });

        const position = getPosition(interaction);
        const member = interaction.options.getUser("member", true);
        const currentHolderId = access.team.staff[position];
        if (currentHolderId !== member.id) return interaction.reply({ embeds: [createErrorEmbed(`${member} is not your team's ${POSITION_LABELS[position]}.`)], ephemeral: true });

        await interaction.deferReply({ ephemeral: true });

        const teamRole = interaction.guild.roles.cache.get(access.teamRoleId);
        access.team.staff[position] = null;

        try {
            saveData(data);
        } catch (error) {
            console.error(error);
            access.team.staff[position] = currentHolderId;
            await interaction.editReply({ embeds: [createErrorEmbed("I couldn't save the demotion, so no change was made.")] });
            return;
        }

        let roleRemoved = true;
        if (position === "assistant_manager") {
            roleRemoved = await removeAssistantManagerRoleIfUnused(interaction.guild, member.id, data, `Demoted by ${interaction.user.tag}`);
        } else {
            roleRemoved = await removePlayerManagerRoleIfUnused(interaction.guild, member.id, data, `Demoted by ${interaction.user.tag}`);
        }

        if (!roleRemoved) {
            // The database is authoritative for the position, but make the mismatch
            // explicit so an operator knows the Discord role needs attention.
            console.warn(`Could not remove ${POSITION_LABELS[position]} role from ${member.id} after demotion.`);
        }

        const embed = createStatusEmbed({
            guild: interaction.guild,
            title: roleRemoved ? "Team Staff Demotion" : "Demotion Completed with a Warning",
            description: roleRemoved
                ? `${member} has been removed as **${POSITION_LABELS[position]}** for ${teamRole ?? "the team"}.`
                : `${member} was demoted in the database, but the staff role needs manual removal.`,
            fields: [{ name: "Demoted By", value: `${interaction.user}`, inline: true }],
            color: roleRemoved ? 0xed4245 : 0xfee75c
        });

        if (teamRole) embed.setThumbnail(getTeamThumbnail(teamRole, interaction.guild));
        await interaction.editReply({ embeds: [embed] });
        await sendTransactionLog(interaction, embed);
    }
};

module.exports = {
    setCandidateRoleCommand,
    fofillCommand,
    promoteCommand,
    demoteCommand,
    findTeamAccess,
    isTeamStaffMember,
    canPromote,
    canDemote
};
