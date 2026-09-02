"use strict";

const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require("discord.js");

const command = {
    data: new SlashCommandBuilder()
        .setName("threadlock")
        .setDescription("Prevent @everyone from creating threads in this channel.")
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

    async execute(interaction) {
        if (!interaction.guild) {
            return interaction.reply({ content: "This command can only be used in a server.", ephemeral: true });
        }

        if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageChannels)) {
            return interaction.reply({ content: "You need the Manage Channels permission.", ephemeral: true });
        }

        const everyoneRole = interaction.guild.roles.everyone;

        try {
            await interaction.channel.permissionOverwrites.edit(everyoneRole, {
                CreatePublicThreads: false,
                CreatePrivateThreads: false
            });

            return interaction.reply({
                embeds: [
                    new EmbedBuilder()
                        .setColor(0xed4245)
                        .setTitle("Threads Locked")
                        .setDescription("@everyone can no longer create threads in this channel.")
                ]
            });
        } catch (error) {
            console.error("Thread lock error:", error);
            return interaction.reply({
                content: "I could not lock thread creation. Make sure I have the Manage Channels permission.",
                ephemeral: true
            });
        }
    }
};

module.exports = { command };
