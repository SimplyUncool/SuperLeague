"use strict";

const { SlashCommandBuilder, EmbedBuilder } = require("discord.js");
const { getStats } = require("../inviteTracker.js");

const command = {
    data: new SlashCommandBuilder()
        .setName("invites")
        .setDescription("Show invite statistics for a member.")
        .addUserOption(option => option
            .setName("user")
            .setDescription("Member to check (defaults to you).")
            .setRequired(false)),

    async execute(interaction) {
        if (!interaction.guild) return interaction.reply({ content: "This command can only be used inside a server.", ephemeral: true });

        const user = interaction.options.getUser("user") || interaction.user;
        const stats = getStats(interaction.guild, user.id);
        const embed = new EmbedBuilder()
            .setTitle("Invite Statistics")
            .setDescription(`Invite statistics for ${user}.`)
            .addFields(
                { name: "Total invites", value: `**${stats.total}**`, inline: true },
                { name: "Still here", value: `**${stats.active}**`, inline: true },
                { name: "Left", value: `**${stats.left}**`, inline: true }
            )
            .setThumbnail(user.displayAvatarURL({ size: 128 }))
            .setTimestamp();

        await interaction.reply({ embeds: [embed] });
    }
};

module.exports = { command };
