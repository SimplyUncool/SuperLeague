"use strict";

const fs = require("fs");
const path = require("path");
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, ChannelType, StringSelectMenuBuilder, EmbedBuilder } = require("discord.js");
const { createErrorEmbed, createSuccessEmbed } = require("./commands/embeds.js");

const dbPath = path.resolve(process.env.SUPER_LEAGUE_DB_PATH || path.join(__dirname, "users.json"));
const configPath = path.join(path.dirname(dbPath), "invites.json");

function loadConfig() {
    try {
        if (!fs.existsSync(configPath)) return { guilds: {} };
        const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
        if (!parsed || typeof parsed !== "object") return { guilds: {} };
        parsed.guilds ??= {};
        return parsed;
    } catch (error) {
        console.error("Failed to load invite configuration:", error);
        return { guilds: {} };
    }
}

function saveConfig(config) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const tempPath = `${configPath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tempPath, JSON.stringify(config, null, 2), { mode: 0o600 });
    fs.renameSync(tempPath, configPath);
}

function ensureGuild(config, guildId) {
    config.guilds ??= {};
    config.guilds[guildId] ??= { logChannelId: null, invites: {}, members: {} };
    config.guilds[guildId].invites ??= {};
    config.guilds[guildId].members ??= {};
    return config.guilds[guildId];
}

function button(id, label, style = ButtonStyle.Primary) {
    return new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
}

function pageEmbed(title, description) {
    return new EmbedBuilder().setColor(0x5865f2).setTitle(title).setDescription(description);
}

function buildChannels() {
    return {
        embeds: [pageEmbed("Channels", "Choose what you want to configure, then select the channel.\n\nThe selected channel is saved immediately.")],
        components: [
            new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId("cfg_channel_setting")
                    .setPlaceholder("Choose a channel setting")
                    .addOptions([
                        { label: "Staff Logs", value: "log", description: "Where staff command logs are sent" },
                        { label: "Transactions", value: "transaction", description: "Where completed transactions are sent" },
                        { label: "Invite Logs", value: "invite", description: "Where member invite tracking logs are sent" }
                    ])
            ),
            new ActionRowBuilder().addComponents(button("cfg_home", "Back", ButtonStyle.Secondary))
        ]
    };
}

function buildChannelSetting(setting) {
    const details = {
        log: ["Staff Logs", "Select the channel where staff command audit logs should be posted."],
        transaction: ["Transactions", "Select the channel where completed transactions should be posted."],
        invite: ["Invite Logs", "Select the channel where invite tracker join logs should be posted."]
    }[setting];
    if (!details) return buildChannels();

    return {
        embeds: [pageEmbed(details[0], details[1])],
        components: [
            new ActionRowBuilder().addComponents(
                new ChannelSelectMenuBuilder()
                    .setCustomId(`cfg_channel_set:${setting}`)
                    .setPlaceholder("Select channel")
                    .setChannelTypes(ChannelType.GuildText)
                    .setMinValues(1)
                    .setMaxValues(1)
            ),
            new ActionRowBuilder().addComponents(button("cfg_channels", "Choose Another", ButtonStyle.Secondary), button("cfg_home", "Home", ButtonStyle.Secondary))
        ]
    };
}

async function handleInteraction(interaction) {
    if (!interaction.guild) return false;
    if (!interaction.customId?.startsWith("cfg_")) return false;

    if (interaction.isButton() && interaction.customId === "cfg_channels") {
        await interaction.update(buildChannels());
        return true;
    }

    if (interaction.isStringSelectMenu() && interaction.customId === "cfg_channel_setting") {
        const setting = interaction.values[0];
        if (setting === "invite" && interaction.guild.ownerId !== interaction.user.id) {
            await interaction.reply({ embeds: [createErrorEmbed("Only the server owner can configure invite logs.", interaction.guild)], ephemeral: true });
            return true;
        }
        if (setting === "invite") {
            await interaction.update(buildChannelSetting("invite"));
            return true;
        }
        await interaction.update(buildChannelSetting(setting));
        return true;
    }

    if (interaction.isChannelSelectMenu?.() && interaction.customId === "cfg_channel_set:invite") {
        if (interaction.guild.ownerId !== interaction.user.id) {
            await interaction.reply({ embeds: [createErrorEmbed("Only the server owner can configure invite logs.", interaction.guild)], ephemeral: true });
            return true;
        }
        const channelId = interaction.values[0];
        const config = loadConfig();
        const guild = ensureGuild(config, interaction.guild.id);
        guild.logChannelId = channelId;
        saveConfig(config);
        await interaction.update({
            embeds: [createSuccessEmbed(interaction.guild, "Invite Logs Updated", `Invite tracker logs will now be posted in <#${channelId}>.`)],
            components: buildChannelSetting("invite").components
        });
        return true;
    }

    return false;
}

module.exports = { handleInteraction, buildChannels, buildChannelSetting, loadConfig, saveConfig, ensureGuild };
