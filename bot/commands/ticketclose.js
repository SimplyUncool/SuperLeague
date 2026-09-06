"use strict";

const { SlashCommandBuilder, PermissionFlagsBits } = require("discord.js");
const { canRunLeagueAdmin } = require("./permissions.js");

const closingTickets = new Set();

function getTicketOwnerId(channel) {
    const topic = channel?.topic;
    return topic?.startsWith("Ticket owner: ") ? topic.slice("Ticket owner: ".length).trim() : null;
}

function canClose(interaction) {
    const ownerId = getTicketOwnerId(interaction.channel);
    return Boolean(ownerId) && (
        ownerId === interaction.user.id ||
        interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels) === true ||
        canRunLeagueAdmin(interaction, {})
    );
}

async function closeTicket(interaction, fromButton = false) {
    if (!interaction.guild || !getTicketOwnerId(interaction.channel)) {
        if (fromButton) await interaction.reply({ content: "This channel is not a ticket.", ephemeral: true }).catch(() => {});
        else await interaction.reply({ content: "This command can only be used inside a ticket channel.", ephemeral: true });
        return;
    }

    if (!canClose(interaction)) {
        if (fromButton) await interaction.reply({ content: "Only the ticket owner or staff with Manage Channels can close this ticket.", ephemeral: true }).catch(() => {});
        else await interaction.reply({ content: "Only the ticket owner or staff with Manage Channels can close this ticket.", ephemeral: true });
        return;
    }

    const channel = interaction.channel;
    if (closingTickets.has(channel.id)) {
        if (fromButton) await interaction.deferUpdate().catch(() => {});
        else await interaction.reply({ content: "This ticket is already being closed.", ephemeral: true });
        return;
    }
    closingTickets.add(channel.id);

    if (fromButton) {
        await interaction.deferUpdate();
    } else {
        await interaction.reply({ content: "Ticket closed. This channel will be deleted in 5 seconds." });
    }

    try {
        await channel.send({ content: "🔒 Ticket closed. This channel will be deleted in 5 seconds." });
    } catch (error) {
        console.error("Failed to send ticket close notice:", error);
    }

    setTimeout(() => {
        channel.delete(`Ticket closed by ${interaction.user.tag}`).catch(error => {
            console.error("Failed to delete ticket channel:", error);
        }).finally(() => closingTickets.delete(channel.id));
    }, 5000);
}

const command = {
    data: new SlashCommandBuilder()
        .setName("close")
        .setDescription("Close the current support ticket."),
    async execute(interaction) {
        await closeTicket(interaction);
    }
};

async function handleButton(interaction) {
    if (interaction.customId !== "ticket_close") return false;
    await closeTicket(interaction, true);
    return true;
}

module.exports = { command, handleButton, closeTicket };
