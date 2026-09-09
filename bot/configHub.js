"use strict";

const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require("discord.js");
const legacyConfig = require("./commands/config.js");

function ownerOnly(interaction) {
    return Boolean(interaction.guild && interaction.guild.ownerId === interaction.user.id);
}

function button(id, label, style = ButtonStyle.Primary) {
    return new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
}

function home(guild) {
    return {
        embeds: [new EmbedBuilder()
            .setColor(0x5865f2)
            .setAuthor({ name: guild.name, iconURL: guild.iconURL({ size: 128 }) ?? undefined })
            .setTitle("Super League Configuration")
            .setDescription("Everything is managed from this panel. Choose a section below; changes are saved immediately.")
            .addFields(
                { name: "League", value: "Channels, staff roles, limits, tickets and access lists.", inline: true },
                { name: "Applications", value: "Forms, questions, review workflow, roles, cooldowns and publishing.", inline: true },
                { name: "Levels", value: "XP, cooldowns, announcements, ignored channels and level roles.", inline: true }
            )
            .setFooter({ text: "Super League • Server Owner Configuration" })],
        components: [
            new ActionRowBuilder().addComponents(
                button("hub_core", "League Settings"),
                button("appcfg_home", "Applications"),
                button("lvlcfg_home", "Levels")
            ),
            new ActionRowBuilder().addComponents(button("hub_refresh", "Refresh", ButtonStyle.Secondary))
        ]
    };
}

const command = {
    data: new SlashCommandBuilder()
        .setName("config")
        .setDescription("Open the unified Super League configuration panel."),

    async execute(interaction) {
        if (!interaction.guild) return interaction.reply({ content: "This command can only be used inside a server.", ephemeral: true });
        if (!ownerOnly(interaction)) return interaction.reply({ content: "Only the server owner can use the configuration panel.", ephemeral: true });
        await interaction.reply(home(interaction.guild));
    }
};

async function handleInteraction(interaction) {
    if (!interaction.guild || !ownerOnly(interaction)) {
        return interaction.reply({ content: "Only the server owner can use the configuration panel.", ephemeral: true });
    }
    if (interaction.customId === "hub_core") return legacyConfig.execute(interaction);
    if (interaction.customId === "hub_refresh") return interaction.update(home(interaction.guild));
    return false;
}

module.exports = { command, handleInteraction, home };
