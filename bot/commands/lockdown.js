"use strict";

const {
    SlashCommandBuilder,
    EmbedBuilder,
    PermissionFlagsBits
} = require("discord.js");
const {
    enableManualLockdown,
    disableManualLockdown,
    getSecurityStatus
} = require("../security.js");

function ownerOnly(interaction) {
    return Boolean(interaction.guild && interaction.guild.ownerId === interaction.user.id);
}

function statusEmbed(guild) {
    const status = getSecurityStatus(guild);
    return new EmbedBuilder()
        .setColor(status.lockdown || status.raidMode ? 0xed4245 : 0x57f287)
        .setTitle("Super League Security")
        .setDescription([
            `Emergency lockdown: **${status.lockdown ? "ACTIVE" : "inactive"}**`,
            `Raid mode: **${status.raidMode ? "ACTIVE" : "inactive"}**`,
            `Protected channels: **${status.protectedChannels}**`,
            `Trusted IDs: **${status.trustedIds}**`,
            `Bot highest role position: **${status.botRolePosition ?? "unknown"}**`
        ].join("\n"));
}

const command = {
    data: new SlashCommandBuilder()
        .setName("lockdown")
        .setDescription("Emergency server lockdown and security status.")
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addSubcommand(subcommand => subcommand
            .setName("enable")
            .setDescription("Lock public text channels and thread creation."))
        .addSubcommand(subcommand => subcommand
            .setName("disable")
            .setDescription("End the emergency lockdown and restore saved permissions."))
        .addSubcommand(subcommand => subcommand
            .setName("status")
            .setDescription("Show current emergency security status.")),

    async execute(interaction) {
        if (!interaction.guild) return interaction.reply({ content: "This command can only be used inside a server.", ephemeral: true });
        if (!ownerOnly(interaction)) return interaction.reply({ content: "Only the server owner can use emergency lockdown controls.", ephemeral: true });

        const subcommand = interaction.options.getSubcommand();
        if (subcommand === "enable") {
            const result = await enableManualLockdown(interaction.guild);
            return interaction.reply({ embeds: [statusEmbed(interaction.guild).setDescription(result.changed ? "Emergency lockdown is now **ACTIVE**. Public message and thread creation is blocked." : "Emergency lockdown was already active.")], ephemeral: true });
        }
        if (subcommand === "disable") {
            const result = await disableManualLockdown(interaction.guild);
            return interaction.reply({ embeds: [statusEmbed(interaction.guild).setDescription(result.changed ? "Emergency lockdown is now **inactive** and saved public permissions were restored where possible." : "Emergency lockdown was already inactive.")], ephemeral: true });
        }
        return interaction.reply({ embeds: [statusEmbed(interaction.guild)], ephemeral: true });
    }
};

module.exports = { command, statusEmbed };
