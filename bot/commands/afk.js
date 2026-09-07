"use strict";

const { SlashCommandBuilder } = require("discord.js");
const afk = require("../afk.js");

const command = {
    data: new SlashCommandBuilder()
        .setName("afk")
        .setDescription("Set or clear your AFK status.")
        .addStringOption(option => option
            .setName("reason")
            .setDescription("Why you are AFK. Use 'off' to clear your AFK status.")
            .setMaxLength(512)),

    async execute(interaction) {
        if (!interaction.guild) return interaction.reply({ content: "This command can only be used in a server.", ephemeral: true });

        const reason = interaction.options.getString("reason")?.trim();
        if (reason?.toLowerCase() === "off") {
            const removed = afk.clearAfk(interaction.guild.id, interaction.user.id);
            return interaction.reply({
                content: removed ? "Your AFK status has been cleared." : "You are not currently marked as AFK.",
                ephemeral: true
            });
        }

        afk.setAfk(interaction.guild.id, interaction.user.id, reason || "AFK");
        await interaction.reply({
            content: `You are now AFK: **${reason || "AFK"}**`,
            ephemeral: true
        });
    }
};

module.exports = { command };
