"use strict";

const {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle
} = require("discord.js");

const {
    loadData,
    saveData,
    getRosterLimit
} = require("./database.js");

const { findTeamAccess } = require("./teamstaff.js");
const { createErrorEmbed, createStatusEmbed } = require("./embeds.js");
const {
    getTeamThumbnail,
    getTeamEmoji,
    createTeamTransactionEmbed,
    sendTransactionRecord
} = require("./teamembeds.js");
const { ensureGuildMembers, isRosterFull } = require("./rosterutils.js");

const crypto = require("crypto");
const activeSignings = new Set();
const OFFER_TTL_MS = 24 * 60 * 60 * 1000;

function getOffer(data, offerId) {
    return data.settings.offers?.[offerId] ?? null;
}

function removeOffer(data, offerId) {
    if (data.settings.offers) delete data.settings.offers[offerId];
}

function currentIssuerIsAuthorized(data, offer, guildId) {
    if (offer.guildId !== guildId) return false;
    const access = findTeamAccess(data, offer.issuerId);
    return Boolean(access && access.teamRoleId === offer.teamRoleId);
}

function offerExpired(offer) {
    return !offer || offer.expiresAt <= Date.now();
}

const command = {
    data: new SlashCommandBuilder()
        .setName("offer")
        .setDescription("Offer a player a contract to join your team.")
        .addUserOption(option => option
            .setName("player")
            .setDescription("The player you want to sign.")
            .setRequired(true)),

    async execute(interaction) {
        if (!interaction.guild) {
            await interaction.reply({
                embeds: [createErrorEmbed("This command can only be used inside a server.")],
                ephemeral: true
            });
            return;
        }

        await interaction.deferReply({ ephemeral: true });

        const player = interaction.options.getUser("player", true);
        const data = loadData();
        const access = findTeamAccess(data, interaction.user.id);

        if (!access) {
            await interaction.editReply({
                embeds: [createErrorEmbed("Only a manager, assistant manager, or player manager can send offers.")]
            });
            return;
        }

        if (!access.team.managerid) {
            await interaction.editReply({
                embeds: [createErrorEmbed("This team is frozen until a new manager is appointed.")]
            });
            return;
        }

        const teamRole = interaction.guild.roles.cache.get(access.teamRoleId);
        if (!teamRole) {
            await interaction.editReply({
                embeds: [createErrorEmbed("Your team role could not be found.")]
            });
            return;
        }

        if (player.bot || player.id === interaction.user.id) {
            await interaction.editReply({
                embeds: [createErrorEmbed(player.bot ? "You can't offer contracts to bots." : "You can't offer yourself a contract.")]
            });
            return;
        }

        const member = await interaction.guild.members.fetch(player.id).catch(() => null);
        if (!member) {
            await interaction.editReply({
                embeds: [createErrorEmbed("That player isn't in this server.")]
            });
            return;
        }

        if (findTeamAccess(data, player.id)) {
            await interaction.editReply({
                embeds: [createErrorEmbed("That person already holds a manager or team staff position.")]
            });
            return;
        }

        const teams = data.teams ?? {};
        const alreadyOnTeam = Object.keys(teams).some(roleId => member.roles.cache.has(roleId));
        if (alreadyOnTeam) {
            await interaction.editReply({
                embeds: [createErrorEmbed("That player is already on a team.")]
            });
            return;
        }

        try {
            await ensureGuildMembers(interaction.guild);
        } catch (error) {
            console.error(error);
            await interaction.editReply({
                embeds: [createErrorEmbed("I could not load the current roster. Make sure Server Members Intent is enabled.")]
            });
            return;
        }

        if (isRosterFull(teamRole, access.team, getRosterLimit(data, interaction.guild.id))) {
            await interaction.editReply({
                embeds: [createErrorEmbed(`${teamRole} has reached its roster limit.`)]
            });
            return;
        }

        const offerId = crypto.randomBytes(12).toString("hex");
        const now = Date.now();
        data.settings.offers[offerId] = {
            guildId: interaction.guild.id,
            teamRoleId: access.teamRoleId,
            playerId: player.id,
            issuerId: interaction.user.id,
            createdAt: now,
            expiresAt: now + OFFER_TTL_MS,
            status: "pending"
        };

        try {
            saveData(data);
        } catch (error) {
            console.error(error);
            await interaction.editReply({
                embeds: [createErrorEmbed("I couldn't save the contract offer. No offer was sent.")]
            });
            return;
        }

        const guildIcon = interaction.guild.iconURL({ size: 128 }) ?? undefined;
        const thumbnail = getTeamThumbnail(teamRole, interaction.guild);
        const offerEmbed = new EmbedBuilder()
            .setColor(teamRole.color || 0x5865f2)
            .setAuthor({ name: interaction.guild.name, iconURL: guildIcon })
            .setTitle("⚽ Contract Offer")
            .setDescription(`${player} has received a contract offer to join ${teamRole}.`)
            .addFields(
                { name: "Team", value: `${teamRole}`, inline: true },
                { name: "Offered By", value: `${interaction.user}`, inline: true },
                { name: "Role Offered", value: "`Player`", inline: true },
                { name: "Expires", value: `<t:${Math.floor((now + OFFER_TTL_MS) / 1000)}:R>`, inline: true }
            )
            .setThumbnail(thumbnail)
            .setFooter({ text: `${interaction.guild.name} • Contract Offer` })
            .setTimestamp();

        const buttons = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`offer_accept:${offerId}`)
                .setLabel("Accept")
                .setEmoji("✅")
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId(`offer_decline:${offerId}`)
                .setLabel("Decline")
                .setEmoji("❌")
                .setStyle(ButtonStyle.Danger)
        );

        try {
            await player.send({ embeds: [offerEmbed], components: [buttons] });
        } catch (error) {
            console.error(error);
            removeOffer(data, offerId);
            saveData(data);
            await interaction.editReply({
                embeds: [createErrorEmbed(`I couldn't DM ${player} — they may have DMs disabled for this server.`)]
            });
            return;
        }

        await interaction.editReply({
            embeds: [
                new EmbedBuilder()
                    .setColor(0x57f287)
                    .setAuthor({ name: interaction.guild.name, iconURL: guildIcon })
                    .setTitle("Offer Sent")
                    .setDescription(`Your contract offer has been sent to ${player}.`)
                    .addFields(
                        { name: "Team", value: `${teamRole}`, inline: true },
                        { name: "Player", value: `${player}`, inline: true },
                        { name: "Expires", value: `<t:${Math.floor((now + OFFER_TTL_MS) / 1000)}:R>`, inline: true }
                    )
                    .setThumbnail(thumbnail)
                    .setTimestamp()
            ]
        });
    }
};

async function handleAcceptButton(interaction) {
    const [, offerId] = interaction.customId.split(":");
    const data = loadData();
    const offer = getOffer(data, offerId);

    if (!offer || offer.status !== "pending" || offer.playerId !== interaction.user.id) {
        await interaction.reply({
            embeds: [createErrorEmbed("This offer is no longer valid.")],
            ephemeral: true
        });
        return;
    }

    if (offerExpired(offer)) {
        offer.status = "expired";
        saveData(data);
        await interaction.reply({
            embeds: [createErrorEmbed("This contract offer has expired.")],
            ephemeral: true
        });
        return;
    }

    const modal = new ModalBuilder()
        .setCustomId(`offer_confirm:${offerId}`)
        .setTitle("Accept Contract");

    const confirmation = new TextInputBuilder()
        .setCustomId("confirmation")
        .setLabel("Type YES to accept")
        .setStyle(TextInputStyle.Short)
        .setPlaceholder("YES")
        .setRequired(true)
        .setMaxLength(3);

    modal.addComponents(new ActionRowBuilder().addComponents(confirmation));
    await interaction.showModal(modal);
}

async function handleDeclineButton(interaction) {
    const [, offerId] = interaction.customId.split(":");
    const data = loadData();
    const offer = getOffer(data, offerId);

    if (!offer || offer.status !== "pending" || offer.playerId !== interaction.user.id) {
        await interaction.reply({
            embeds: [createErrorEmbed("This offer is no longer valid.")],
            ephemeral: true
        });
        return;
    }

    offer.status = offerExpired(offer) ? "expired" : "declined";
    saveData(data);

    const guild = interaction.client.guilds.cache.get(offer.guildId);
    const teamRole = guild?.roles.cache.get(offer.teamRoleId);
    const thumbnail = teamRole && guild ? getTeamThumbnail(teamRole, guild) : null;

    await interaction.update({
        embeds: [createStatusEmbed({
            guild,
            color: offer.status === "declined" ? 0xed4245 : 0xfee75c,
            title: offer.status === "declined" ? "Offer Declined" : "Offer Expired",
            description: teamRole
                ? `You ${offer.status === "declined" ? "declined" : "can no longer accept"} the contract offer from ${teamRole}.`
                : "This contract offer is no longer active."
        }).setThumbnail(thumbnail)],
        components: []
    });
}

async function handleOfferModal(interaction) {
    const [, offerId] = interaction.customId.split(":");
    const confirmation = interaction.fields.getTextInputValue("confirmation").trim().toUpperCase();

    if (confirmation !== "YES") {
        await interaction.reply({
            embeds: [createErrorEmbed("The contract wasn't accepted. Type `YES` to confirm.")],
            ephemeral: true
        });
        return;
    }

    const data = loadData();
    const offer = getOffer(data, offerId);

    if (!offer || offer.status !== "pending" || offer.playerId !== interaction.user.id) {
        await interaction.reply({
            embeds: [createErrorEmbed("This offer is no longer valid.")],
            ephemeral: true
        });
        return;
    }

    if (offerExpired(offer)) {
        offer.status = "expired";
        saveData(data);
        await interaction.reply({
            embeds: [createErrorEmbed("This contract offer has expired.")],
            ephemeral: true
        });
        return;
    }

    if (!currentIssuerIsAuthorized(data, offer, offer.guildId)) {
        offer.status = "revoked";
        saveData(data);
        await interaction.reply({
            embeds: [createErrorEmbed("This offer is no longer valid because the person who issued it no longer has authority over that team.")],
            ephemeral: true
        });
        return;
    }

    const guild = interaction.client.guilds.cache.get(offer.guildId) ??
        await interaction.client.guilds.fetch(offer.guildId).catch(() => null);

    if (!guild) {
        await interaction.reply({
            embeds: [createErrorEmbed("I couldn't find the server this offer belongs to.")],
            ephemeral: true
        });
        return;
    }

    const teamData = data.teams[offer.teamRoleId];
    const teamRole = guild.roles.cache.get(offer.teamRoleId);
    const member = await guild.members.fetch(offer.playerId).catch(() => null);

    if (!teamData || !teamRole || !member) {
        await interaction.reply({
            embeds: [createErrorEmbed("The team or player is no longer available.")],
            ephemeral: true
        });
        return;
    }

    if (!teamData.managerid) {
        await interaction.reply({
            embeds: [createErrorEmbed("This team is frozen until a new manager is appointed.")],
            ephemeral: true
        });
        return;
    }

    if (findTeamAccess(data, member.id)) {
        await interaction.reply({
            embeds: [createErrorEmbed("You now hold a manager or team staff position, so this offer cannot be accepted.")],
            ephemeral: true
        });
        return;
    }

    const otherTeam = Object.keys(data.teams).find(
        roleId => roleId !== offer.teamRoleId && member.roles.cache.has(roleId)
    );

    if (otherTeam || member.roles.cache.has(offer.teamRoleId)) {
        await interaction.reply({
            embeds: [createErrorEmbed(otherTeam ? "You are already on another team." : "You are already on this team.")],
            ephemeral: true
        });
        return;
    }

    const signingKey = `${guild.id}:${teamRole.id}`;
    if (activeSignings.has(signingKey)) {
        await interaction.reply({
            embeds: [createErrorEmbed("Another signing is being completed for this team. Try again in a moment.")],
            ephemeral: true
        });
        return;
    }

    activeSignings.add(signingKey);

    try {
        await ensureGuildMembers(guild);

        if (isRosterFull(teamRole, teamData, getRosterLimit(data, guild.id))) {
            await interaction.reply({
                embeds: [createErrorEmbed(`${teamRole} has reached its roster limit.`)],
                ephemeral: true
            });
            return;
        }

        const botMember = guild.members.me;
        if (!botMember || teamRole.position >= botMember.roles.highest.position) {
            await interaction.reply({
                embeds: [createErrorEmbed(`I can't give you ${teamRole} because that role is not below my highest role.`)],
                ephemeral: true
            });
            return;
        }

        // Claim the offer before awaiting the Discord API. This prevents two
        // simultaneous clicks from both completing the same contract.
        offer.status = "accepted";
        offer.acceptedAt = Date.now();
        offer.acceptedBy = interaction.user.id;
        try {
            saveData(data);
        } catch (error) {
            console.error(error);
            offer.status = "pending";
            delete offer.acceptedAt;
            delete offer.acceptedBy;
            await interaction.reply({
                embeds: [createErrorEmbed("I couldn't save the contract acceptance, so no roster change was made.")],
                ephemeral: true
            });
            return;
        }

        try {
            await member.roles.add(teamRole, `Contract accepted from offer ${offerId}`);
        } catch (error) {
            console.error(error);
            offer.status = "pending";
            delete offer.acceptedAt;
            delete offer.acceptedBy;
            saveData(data);

            await interaction.reply({
                embeds: [createErrorEmbed(`I couldn't give you ${teamRole}. Make sure my bot role is above the team role and that I have Manage Roles permission.`)],
                ephemeral: true
            });
            return;
        }

        const embed = createTeamTransactionEmbed({
            guild,
            teamRole,
            team: teamData,
            data,
            title: `Contract Accepted - ${teamRole.name}`,
            description: `> ${member} has accepted an offer to join ${getTeamEmoji(teamRole)} ${teamRole}.`,
            color: 0x57f287
        });

        await interaction.reply({ embeds: [embed], ephemeral: true });
        await sendTransactionRecord(guild, data, embed);
    } finally {
        activeSignings.delete(signingKey);
    }
}

module.exports = {
    command,
    handleAcceptButton,
    handleDeclineButton,
    handleOfferModal
};
