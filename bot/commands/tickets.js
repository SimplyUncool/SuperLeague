"use strict";

const fs = require("fs");
const path = require("path");
const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    ChannelType,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle
} = require("discord.js");

const { createErrorEmbed, createSuccessEmbed } = require("./embeds.js");
const { canRunLeagueAdmin } = require("./permissions.js");

const dbPath = path.resolve(
    process.env.SUPER_LEAGUE_DB_PATH || path.resolve(__dirname, "..", "users.json")
);
const configPath = path.join(path.dirname(dbPath), "tickets.json");

function loadConfig() {
    try {
        if (!fs.existsSync(configPath)) return { guilds: {} };
        const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
        if (!parsed || typeof parsed !== "object") return { guilds: {} };
        if (!parsed.guilds || typeof parsed.guilds !== "object") parsed.guilds = {};
        return parsed;
    } catch (error) {
        console.error("Failed to load ticket configuration:", error);
        return { guilds: {} };
    }
}

function saveConfig(config) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const tempPath = `${configPath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tempPath, JSON.stringify(config, null, 2), { mode: 0o600 });
    fs.renameSync(tempPath, configPath);
}

function getGuildConfig(guildId) {
    const config = loadConfig();
    if (!config.guilds[guildId]) {
        config.guilds[guildId] = {
            categoryId: null,
            panelChannelId: null,
            panelMessageId: null
        };
        saveConfig(config);
    }
    return { config, guild: config.guilds[guildId] };
}

function canConfigure(interaction) {
    return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) === true;
}

function buildPanel(guild) {
    const icon = guild.iconURL({ size: 128 }) ?? undefined;
    const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setAuthor({ name: guild.name, iconURL: icon })
        .setTitle("Support Tickets")
        .setDescription(
            "Need help from the staff team? Click the button below to open a private support ticket.\n\n" +
            "Please include all relevant information in your ticket so staff can help you quickly."
        )
        .setFooter({ text: guild.name });

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId("ticket_create")
            .setLabel("Create Ticket")
            .setEmoji("🎫")
            .setStyle(ButtonStyle.Primary)
    );

    return { embeds: [embed], components: [row] };
}

function buildTicketEmbed(guild, user) {
    return new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle("Ticket Created")
        .setDescription(
            `Welcome ${user}.\n\n` +
            "Please describe your issue or request below. Staff will respond when available.\n\n" +
            "When you are finished, use the **Close Ticket** button."
        )
        .setFooter({ text: `${guild.name} • Support` });
}

function buildCloseButton() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId("ticket_close")
            .setLabel("Close Ticket")
            .setEmoji("🔒")
            .setStyle(ButtonStyle.Danger)
    );
}

function findExistingTicket(guild, userId, categoryId) {
    return guild.channels.cache.find(channel =>
        channel.parentId === categoryId &&
        channel.type === ChannelType.GuildText &&
        channel.topic === `Ticket owner: ${userId}`
    );
}

const command = {
    data: new SlashCommandBuilder()
        .setName("tickets")
        .setDescription("Configure and manage the support ticket system.")
        .addSubcommand(subcommand => subcommand
            .setName("category")
            .setDescription("Set the category where tickets will be created.")
            .addChannelOption(option => option
                .setName("category")
                .setDescription("Category to create tickets in.")
                .addChannelTypes(ChannelType.GuildCategory)
                .setRequired(true)))
        .addSubcommand(subcommand => subcommand
            .setName("panel")
            .setDescription("Send the ticket panel to a channel.")
            .addChannelOption(option => option
                .setName("channel")
                .setDescription("Channel to send the ticket panel to.")
                .addChannelTypes(ChannelType.GuildText)
                .setRequired(true)))
        .addSubcommand(subcommand => subcommand
            .setName("config")
            .setDescription("Show the current ticket configuration.")),

    async execute(interaction) {
        if (!interaction.guild) {
            return interaction.reply({
                embeds: [createErrorEmbed("This command can only be used inside a server.")],
                ephemeral: true
            });
        }

        if (!canConfigure(interaction)) {
            return interaction.reply({
                embeds: [createErrorEmbed("You need the Manage Server permission to configure tickets.", interaction.guild)],
                ephemeral: true
            });
        }

        const subcommand = interaction.options.getSubcommand();
        const { config, guild: ticketConfig } = getGuildConfig(interaction.guild.id);

        if (subcommand === "category") {
            const category = interaction.options.getChannel("category", true);
            const me = interaction.guild.members.me;
            if (!me?.permissions.has(PermissionFlagsBits.ManageChannels)) {
                return interaction.reply({
                    embeds: [createErrorEmbed("I need the Manage Channels permission to create tickets.", interaction.guild)],
                    ephemeral: true
                });
            }

            ticketConfig.categoryId = category.id;
            saveConfig(config);
            return interaction.reply({
                embeds: [createSuccessEmbed(interaction.guild, "Ticket Category Set", `New tickets will be created in ${category}.`)],
                ephemeral: true
            });
        }

        if (subcommand === "panel") {
            if (!ticketConfig.categoryId) {
                return interaction.reply({
                    embeds: [createErrorEmbed("No ticket category is configured. Use `/tickets category` first.", interaction.guild)],
                    ephemeral: true
                });
            }

            const category = interaction.guild.channels.cache.get(ticketConfig.categoryId);
            if (!category || category.type !== ChannelType.GuildCategory) {
                return interaction.reply({
                    embeds: [createErrorEmbed("The configured ticket category no longer exists. Set it again with `/tickets category`.", interaction.guild)],
                    ephemeral: true
                });
            }

            const channel = interaction.options.getChannel("channel", true);
            const permissions = channel.permissionsFor(interaction.guild.members.me);
            if (!permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
                return interaction.reply({
                    embeds: [createErrorEmbed(`I need View Channel, Send Messages, and Embed Links in ${channel}.`, interaction.guild)],
                    ephemeral: true
                });
            }

            const message = await channel.send(buildPanel(interaction.guild));
            ticketConfig.panelChannelId = channel.id;
            ticketConfig.panelMessageId = message.id;
            saveConfig(config);

            return interaction.reply({
                embeds: [createSuccessEmbed(interaction.guild, "Ticket Panel Sent", `The ticket panel has been sent to ${channel}.`)],
                ephemeral: true
            });
        }

        if (subcommand === "config") {
            const category = ticketConfig.categoryId ? `<#${ticketConfig.categoryId}>` : "Not configured";
            const panel = ticketConfig.panelChannelId ? `<#${ticketConfig.panelChannelId}>` : "Not configured";
            return interaction.reply({
                embeds: [new EmbedBuilder()
                    .setColor(0x5865f2)
                    .setTitle("Ticket Configuration")
                    .addFields(
                        { name: "Category", value: category, inline: true },
                        { name: "Panel Channel", value: panel, inline: true }
                    )],
                ephemeral: true
            });
        }
    }
};

async function handleButton(interaction) {
    if (!interaction.guild) return;

    const { guild: ticketConfig } = getGuildConfig(interaction.guild.id);

    if (interaction.customId === "ticket_create") {
        if (!ticketConfig.categoryId) {
            return interaction.reply({ content: "Tickets have not been configured yet. Please contact a server administrator.", ephemeral: true });
        }

        const category = interaction.guild.channels.cache.get(ticketConfig.categoryId);
        if (!category || category.type !== ChannelType.GuildCategory) {
            return interaction.reply({ content: "The configured ticket category no longer exists. Please contact a server administrator.", ephemeral: true });
        }

        const existing = findExistingTicket(interaction.guild, interaction.user.id, category.id);
        if (existing) {
            return interaction.reply({ content: `You already have an open ticket: ${existing}`, ephemeral: true });
        }

        const me = interaction.guild.members.me;
        if (!me?.permissions.has(PermissionFlagsBits.ManageChannels)) {
            return interaction.reply({ content: "I need the Manage Channels permission to create tickets.", ephemeral: true });
        }

        const overwrites = category.permissionOverwrites.cache.map(overwrite => ({
            id: overwrite.id,
            allow: overwrite.allow.bitfield,
            deny: overwrite.deny.bitfield,
            type: overwrite.type
        }));

        const everyoneIndex = overwrites.findIndex(overwrite => overwrite.id === interaction.guild.id);
        if (everyoneIndex >= 0) {
            overwrites[everyoneIndex].deny |= PermissionFlagsBits.ViewChannel;
            overwrites[everyoneIndex].allow &= ~PermissionFlagsBits.ViewChannel;
        } else {
            overwrites.push({
                id: interaction.guild.id,
                deny: [PermissionFlagsBits.ViewChannel]
            });
        }

        const userOverwrite = overwrites.find(overwrite => overwrite.id === interaction.user.id);
        if (userOverwrite) {
            userOverwrite.allow |= PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages | PermissionFlagsBits.ReadMessageHistory | PermissionFlagsBits.AttachFiles | PermissionFlagsBits.EmbedLinks;
            userOverwrite.deny &= ~PermissionFlagsBits.ViewChannel;
        } else {
            overwrites.push({
                id: interaction.user.id,
                allow: [
                    PermissionFlagsBits.ViewChannel,
                    PermissionFlagsBits.SendMessages,
                    PermissionFlagsBits.ReadMessageHistory,
                    PermissionFlagsBits.AttachFiles,
                    PermissionFlagsBits.EmbedLinks
                ]
            });
        }

        const safeName = interaction.user.username
            .toLowerCase()
            .replace(/[^a-z0-9-]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 70) || "user";

        await interaction.deferReply({ ephemeral: true });

        try {
            const channel = await interaction.guild.channels.create({
                name: `ticket-${safeName}`.slice(0, 100),
                type: ChannelType.GuildText,
                parent: category.id,
                topic: `Ticket owner: ${interaction.user.id}`,
                permissionOverwrites: overwrites,
                reason: `Support ticket opened by ${interaction.user.tag}`
            });

            await channel.send({
                content: `${interaction.user}`,
                embeds: [buildTicketEmbed(interaction.guild, interaction.user)],
                components: [buildCloseButton()]
            });

            await interaction.editReply({ content: `Your ticket has been created: ${channel}` });
        } catch (error) {
            console.error("Failed to create ticket:", error);
            await interaction.editReply({ content: "I couldn't create the ticket. Check my Manage Channels permission and the category permissions." });
        }

        return;
    }

    if (interaction.customId === "ticket_close") {
        const ownerId = interaction.channel?.topic?.startsWith("Ticket owner: ")
            ? interaction.channel.topic.slice("Ticket owner: ".length).trim()
            : null;

        const canClose = ownerId === interaction.user.id ||
            interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels) === true ||
            canRunLeagueAdmin(interaction, {});

        if (!canClose) {
            return interaction.reply({ content: "Only the ticket owner or staff with Manage Channels can close this ticket.", ephemeral: true });
        }

        await interaction.reply({ content: "Ticket closed. This channel will be deleted in 5 seconds." });
        setTimeout(() => {
            interaction.channel?.delete(`Ticket closed by ${interaction.user.tag}`).catch(console.error);
        }, 5000);
    }
}

module.exports = { command, handleButton };
