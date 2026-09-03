"use strict";

const fs = require("fs");
const path = require("path");
const {
    SlashCommandBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelSelectMenuBuilder,
    ChannelType,
    RoleSelectMenuBuilder,
    UserSelectMenuBuilder,
    StringSelectMenuBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    EmbedBuilder
} = require("discord.js");

const { loadData, saveData, getRosterLimit, getDemandLimit } = require("./database.js");
const { createErrorEmbed, createSuccessEmbed } = require("./embeds.js");
const applications = require("./applications.js");
const tickets = require("./tickets.js");

const dbPath = path.resolve(
    process.env.SUPER_LEAGUE_DB_PATH || path.resolve(__dirname, "..", "users.json")
);
const ticketConfigPath = path.join(path.dirname(dbPath), "tickets.json");

function ownerOnly(interaction) {
    return Boolean(interaction.guild && interaction.guild.ownerId === interaction.user.id);
}

function ensureApplicationConfig(data, guildId) {
    if (!data.settings.applications) data.settings.applications = {};
    if (!data.settings.applications[guildId]) {
        data.settings.applications[guildId] = {
            reviewChannelId: null,
            adminRoleId: null,
            panelChannelId: null,
            panelMessageId: null,
            types: {}
        };
    }
    const config = data.settings.applications[guildId];
    config.types ??= {};
    return config;
}

function loadTicketConfig() {
    try {
        if (!fs.existsSync(ticketConfigPath)) return { guilds: {} };
        const parsed = JSON.parse(fs.readFileSync(ticketConfigPath, "utf8"));
        if (!parsed || typeof parsed !== "object") return { guilds: {} };
        parsed.guilds ??= {};
        return parsed;
    } catch (error) {
        console.error("Failed to load ticket configuration:", error);
        return { guilds: {} };
    }
}

function saveTicketConfig(config) {
    fs.mkdirSync(path.dirname(ticketConfigPath), { recursive: true });
    const tempPath = `${ticketConfigPath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tempPath, JSON.stringify(config, null, 2), { mode: 0o600 });
    fs.renameSync(tempPath, ticketConfigPath);
}

function getTicketGuildConfig() {
    const config = loadTicketConfig();
    return config.guilds;
}

function status(value) {
    return value || "Not configured";
}

function buildMainEmbed(guild, data) {
    const app = ensureApplicationConfig(data, guild.id);
    const ticketGuilds = getTicketGuildConfig();
    const ticket = ticketGuilds[guild.id] ?? {};

    return new EmbedBuilder()
        .setColor(0x5865f2)
        .setAuthor({ name: guild.name, iconURL: guild.iconURL({ size: 128 }) ?? undefined })
        .setTitle("Super League Configuration")
        .setDescription("Use the buttons below to configure the league. **Only the server owner can make changes.**")
        .addFields(
            { name: "Channels", value: `Staff Logs: ${status(data.settings.logChannels[guild.id] && `<#${data.settings.logChannels[guild.id]}>`)}\nTransactions: ${status(data.settings.transactionChannels[guild.id] && `<#${data.settings.transactionChannels[guild.id]}>`)}`, inline: true },
            { name: "Team Roles", value: `Manager: ${status(data.settings.managerRoles[guild.id] && `<@&${data.settings.managerRoles[guild.id]}>`)}\nAssistant: ${status(data.settings.assistantManagerRoles[guild.id] && `<@&${data.settings.assistantManagerRoles[guild.id]}>`)}\nPlayer Manager: ${status(data.settings.playerManagerRoles[guild.id] && `<@&${data.settings.playerManagerRoles[guild.id]}>`)}`, inline: true },
            { name: "Team Staff", value: `Candidate Pool: ${status(data.settings.candidateRoles[guild.id] && `<@&${data.settings.candidateRoles[guild.id]}>`)}`, inline: true },
            { name: "Limits", value: `Roster: **${getRosterLimit(data, guild.id)}**\nDemands: **${getDemandLimit(data, guild.id)}** per member`, inline: true },
            { name: "Applications", value: `Review: ${status(app.reviewChannelId && `<#${app.reviewChannelId}>`)}\nAdmin Role: ${status(app.adminRoleId && `<@&${app.adminRoleId}>`)}\nPanel: ${status(app.panelChannelId && `<#${app.panelChannelId}>`)}\nTypes: **${Object.keys(app.types).length}**`, inline: true },
            { name: "Tickets", value: `Category: ${status(ticket.categoryId && `<#${ticket.categoryId}>`)}\nPanel: ${status(ticket.panelChannelId && `<#${ticket.panelChannelId}>`)}`, inline: true }
        )
        .setFooter({ text: "Super League • Server Owner Configuration" });
}

function mainRows() {
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("cfg_channels").setLabel("Channels").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId("cfg_roles").setLabel("Roles").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId("cfg_limits").setLabel("Limits").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId("cfg_applications").setLabel("Applications").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId("cfg_tickets").setLabel("Tickets").setStyle(ButtonStyle.Primary)
        ),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("cfg_access").setLabel("Access Lists").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId("cfg_refresh").setLabel("Refresh").setStyle(ButtonStyle.Secondary)
        )
    ];
}

function backRow() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("cfg_home").setLabel("Back").setStyle(ButtonStyle.Secondary)
    );
}

function menuEmbed(title, description) {
    return new EmbedBuilder().setColor(0x5865f2).setTitle(title).setDescription(description);
}

function channelRow(customId, placeholder, types = [ChannelType.GuildText]) {
    return new ActionRowBuilder().addComponents(
        new ChannelSelectMenuBuilder()
            .setCustomId(customId)
            .setPlaceholder(placeholder)
            .setChannelTypes(types)
            .setMinValues(1)
            .setMaxValues(1)
    );
}

function roleRow(customId, placeholder) {
    return new ActionRowBuilder().addComponents(
        new RoleSelectMenuBuilder().setCustomId(customId).setPlaceholder(placeholder).setMinValues(1).setMaxValues(1)
    );
}

function buildChannels() {
    return {
        embeds: [menuEmbed("Configure Channels", "Select a channel below. The selected value is saved immediately.")],
        components: [
            channelRow("cfg_set_log", "Select staff log channel"),
            channelRow("cfg_set_transaction", "Select transaction channel"),
            channelRow("cfg_set_app_review", "Select application review channel"),
            channelRow("cfg_set_app_panel", "Select application panel channel"),
            backRow()
        ]
    };
}

function buildRoles() {
    return {
        embeds: [menuEmbed("Configure Roles", "Select a role below. The selected value is saved immediately. Roles must be below the bot's highest role when the bot needs to assign them.")],
        components: [
            roleRow("cfg_set_manager_role", "Select manager role"),
            roleRow("cfg_set_assistant_role", "Select assistant manager role"),
            roleRow("cfg_set_player_manager_role", "Select player manager role"),
            roleRow("cfg_set_candidate_role", "Select manager candidate pool role"),
            backRow()
        ]
    };
}

function buildLimits() {
    return {
        embeds: [menuEmbed("Configure Limits", "Change the roster or demand limit, or reset every member's used demands.")],
        components: [
            new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId("cfg_roster_limit").setLabel("Roster Limit").setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId("cfg_demand_limit").setLabel("Demand Limit").setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId("cfg_demand_reset").setLabel("Reset Demands").setStyle(ButtonStyle.Danger)
            ),
            backRow()
        ]
    };
}

function buildApplications(data, guildId) {
    const app = ensureApplicationConfig(data, guildId);
    const types = Object.entries(app.types);
    const description = types.length
        ? types.map(([id, value]) => `${value.emoji || "📋"} **${value.name}** — \`${id}\` — ${value.questions.length} questions`).join("\n")
        : "No application types have been created yet.";

    const rows = [
        channelRow("cfg_set_app_review", "Set application review channel"),
        roleRow("cfg_set_app_admin", "Set application admin role"),
        channelRow("cfg_set_app_panel", "Set application panel channel")
    ];

    if (types.length) {
        rows.push(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId("cfg_delete_app")
                .setPlaceholder("Delete an application type")
                .addOptions(types.slice(0, 25).map(([id, value]) => ({ label: value.name.slice(0, 100), value: id })))
        ));
    }

    rows.push(backRow());
    return {
        embeds: [menuEmbed("Configure Applications", `${description}\n\nCreate applications and manage questions with the existing `/applications create` and `/applications question ...` commands.`)],
        components: rows
    };
}

function buildTickets() {
    return {
        embeds: [menuEmbed("Configure Tickets", "Set the ticket category or deploy a ticket panel. Ticket settings are stored outside the Git checkout.")],
        components: [
            new ActionRowBuilder().addComponents(
                new ChannelSelectMenuBuilder().setCustomId("cfg_set_ticket_category").setPlaceholder("Select ticket category").setChannelTypes([ChannelType.GuildCategory]),
                new ChannelSelectMenuBuilder().setCustomId("cfg_set_ticket_panel").setPlaceholder("Select ticket panel channel").setChannelTypes([ChannelType.GuildText])
            ),
            backRow()
        ]
    };
}

function buildAccess() {
    return {
        embeds: [menuEmbed("Configure Access Lists", "Select a member, then choose which restricted access list to modify. Changes are saved immediately.")],
        components: [
            new ActionRowBuilder().addComponents(
                new UserSelectMenuBuilder().setCustomId("cfg_access_user").setPlaceholder("Select a member").setMinValues(1).setMaxValues(1)
            ),
            backRow()
        ]
    };
}

function buildAccessActions(userId) {
    return {
        embeds: [menuEmbed("Configure Access", `Selected member: <@${userId}>\nChoose a scope, then add or remove access.`)],
        components: [
            new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder().setCustomId(`cfg_access_scope:${userId}`).setPlaceholder("Select access scope").addOptions(
                    { label: "Echo", value: "echo", description: "Allow /echo" },
                    { label: "League Administration", value: "league_admin", description: "Allow restricted league admin commands" }
                )
            ),
            new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`cfg_access_add:${userId}`).setLabel("Add Access").setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId(`cfg_access_remove:${userId}`).setLabel("Remove Access").setStyle(ButtonStyle.Danger)
            ),
            backRow()
        ]
    };
}

function buildScopeActions(userId, scope) {
    return {
        embeds: [menuEmbed("Configure Access", `Member: <@${userId}>\nScope: **${scope === "echo" ? "Echo" : "League Administration"}**\nChoose Add or Remove.`)],
        components: [
            new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`cfg_access_apply:add:${scope}:${userId}`).setLabel("Add Access").setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId(`cfg_access_apply:remove:${scope}:${userId}`).setLabel("Remove Access").setStyle(ButtonStyle.Danger)
            ),
            backRow()
        ]
    };
}

async function saveAndReply(interaction, data, title, description) {
    saveData(data);
    return interaction.update({ embeds: [createSuccessEmbed(interaction.guild, title, description)], components: mainRows() });
}

function validateRole(interaction, role) {
    if (!role || role.id === interaction.guild.id) return "Choose a normal Discord role instead of @everyone.";
    if (dataHasTeamRole(interaction, role.id)) return "A registered team role cannot also be used as a shared staff/candidate role.";
    if (!role.editable) return `I cannot assign ${role}. Place my bot role above it and make sure I have Manage Roles.`;
    return null;
}

function dataHasTeamRole(interaction, roleId) {
    const data = loadData();
    return Boolean(data.teams[roleId]);
}

function setRole(data, guildId, key, roleId) {
    data.settings[key][guildId] = roleId;
}

function buildModal(customId, title, label, value) {
    const input = new TextInputBuilder()
        .setCustomId("value")
        .setLabel(label)
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setValue(String(value));
    return new ModalBuilder().setCustomId(customId).setTitle(title).addComponents(new ActionRowBuilder().addComponents(input));
}

const command = {
    data: new SlashCommandBuilder().setName("config").setDescription("Open the Super League server configuration panel."),

    async execute(interaction) {
        if (!interaction.guild) return interaction.reply({ embeds: [createErrorEmbed("This command can only be used inside a server.")], ephemeral: true });
        if (!ownerOnly(interaction)) return interaction.reply({ embeds: [createErrorEmbed("Only the server owner can open and use the configuration panel.", interaction.guild)], ephemeral: true });

        const data = loadData();
        await interaction.reply({ embeds: [buildMainEmbed(interaction.guild, data)], components: mainRows() });
    }
};

async function handleInteraction(interaction) {
    if (!interaction.guild) return;
    if (!ownerOnly(interaction)) {
        if (interaction.isStringSelectMenu() || interaction.isRoleSelectMenu?.() || interaction.isChannelSelectMenu?.() || interaction.isUserSelectMenu?.() || interaction.isButton()) {
            return interaction.reply({ embeds: [createErrorEmbed("Only the server owner can use this configuration panel.", interaction.guild)], ephemeral: true });
        }
        return;
    }

    const id = interaction.customId;

    if (interaction.isButton()) {
        if (id === "cfg_home" || id === "cfg_refresh") {
            const data = loadData();
            return interaction.update({ embeds: [buildMainEmbed(interaction.guild, data)], components: mainRows() });
        }
        if (id === "cfg_channels") return interaction.update(buildChannels());
        if (id === "cfg_roles") return interaction.update(buildRoles());
        if (id === "cfg_limits") return interaction.update(buildLimits());
        if (id === "cfg_applications") return interaction.update(buildApplications(loadData(), interaction.guild.id));
        if (id === "cfg_tickets") return interaction.update(buildTickets());
        if (id === "cfg_access") return interaction.update(buildAccess());

        if (id === "cfg_roster_limit") return interaction.showModal(buildModal("cfg_modal_roster_limit", "Roster Limit", "Maximum players per team", getRosterLimit(loadData(), interaction.guild.id)));
        if (id === "cfg_demand_limit") return interaction.showModal(buildModal("cfg_modal_demand_limit", "Demand Limit", "Demands per member", getDemandLimit(loadData(), interaction.guild.id)));
        if (id === "cfg_demand_reset") {
            const data = loadData();
            const usage = data.settings.demandUsage[interaction.guild.id] ?? {};
            const count = Object.keys(usage).length;
            for (const userId of Object.keys(usage)) usage[userId] = 0;
            data.settings.demandUsage[interaction.guild.id] = usage;
            saveData(data);
            return interaction.update({ embeds: [createSuccessEmbed(interaction.guild, "Demands Reset", `Reset used demands for **${count}** members.`)], components: buildLimits().components });
        }

        if (id.startsWith("cfg_access_add:") || id.startsWith("cfg_access_remove:")) {
            const [, userId] = id.split(":");
            return interaction.update(buildScopeActions(userId, id.startsWith("cfg_access_add:") ? "echo" : "echo"));
        }

        if (id.startsWith("cfg_access_apply:")) {
            const [, action, scope, userId] = id.split(":");
            const data = loadData();
            const list = data.settings.whitelists[scope];
            if (!Array.isArray(list)) return interaction.update(buildAccess());
            if (action === "add") {
                if (!list.includes(userId)) list.push(userId);
            } else {
                const index = list.indexOf(userId);
                if (index >= 0) list.splice(index, 1);
            }
            saveData(data);
            return interaction.update({ embeds: [createSuccessEmbed(interaction.guild, action === "add" ? "Access Granted" : "Access Removed", `<@${userId}> ${action === "add" ? "now has" : "no longer has"} **${scope === "echo" ? "Echo" : "League Administration"}** access.`)], components: buildAccess().components });
        }
    }

    if (interaction.isUserSelectMenu?.() && id === "cfg_access_user") {
        return interaction.update(buildAccessActions(interaction.values[0]));
    }

    if (interaction.isStringSelectMenu()) {
        if (id.startsWith("cfg_access_scope:")) {
            const userId = id.split(":")[1];
            return interaction.update(buildScopeActions(userId, interaction.values[0]));
        }
        if (id === "cfg_delete_app") {
            const data = loadData();
            const app = ensureApplicationConfig(data, interaction.guild.id);
            const applicationId = interaction.values[0];
            const application = app.types[applicationId];
            if (!application) return interaction.update(buildApplications(data, interaction.guild.id));
            delete app.types[applicationId];
            saveData(data);
            return interaction.update({ embeds: [createSuccessEmbed(interaction.guild, "Application Deleted", `Deleted **${application.name}**.`)], components: buildApplications(data, interaction.guild.id).components });
        }
    }

    if (interaction.isChannelSelectMenu?.()) {
        const channelId = interaction.values[0];
        const data = loadData();

        if (id === "cfg_set_log") {
            data.settings.logChannels[interaction.guild.id] = channelId;
            return saveAndReply(interaction, data, "Staff Log Channel Set", `Staff audit entries will now be posted in <#${channelId}>.`);
        }
        if (id === "cfg_set_transaction") {
            data.settings.transactionChannels[interaction.guild.id] = channelId;
            return saveAndReply(interaction, data, "Transaction Channel Set", `Completed transactions will now be posted in <#${channelId}>.`);
        }
        if (id === "cfg_set_app_review") {
            ensureApplicationConfig(data, interaction.guild.id).reviewChannelId = channelId;
            return saveAndReply(interaction, data, "Application Review Channel Set", `Completed applications will be sent to <#${channelId}>.`);
        }
        if (id === "cfg_set_app_panel") {
            ensureApplicationConfig(data, interaction.guild.id).panelChannelId = channelId;
            return saveAndReply(interaction, data, "Application Panel Channel Set", `The application panel will default to <#${channelId}>.`);
        }
        if (id === "cfg_set_ticket_category") {
            const config = loadTicketConfig();
            config.guilds[interaction.guild.id] ??= { categoryId: null, panelChannelId: null, panelMessageId: null };
            config.guilds[interaction.guild.id].categoryId = channelId;
            saveTicketConfig(config);
            return interaction.update({ embeds: [createSuccessEmbed(interaction.guild, "Ticket Category Set", `New tickets will be created in <#${channelId}>.`)], components: buildTickets().components });
        }
        if (id === "cfg_set_ticket_panel") {
            const config = loadTicketConfig();
            config.guilds[interaction.guild.id] ??= { categoryId: null, panelChannelId: null, panelMessageId: null };
            config.guilds[interaction.guild.id].panelChannelId = channelId;
            saveTicketConfig(config);
            return interaction.update({ embeds: [createSuccessEmbed(interaction.guild, "Ticket Panel Channel Set", `The ticket panel channel is now <#${channelId}>.`)], components: buildTickets().components });
        }
    }

    if (interaction.isRoleSelectMenu?.()) {
        const roleId = interaction.values[0];
        const role = interaction.guild.roles.cache.get(roleId);
        const data = loadData();
        const error = validateRole(interaction, role);
        if (error) return interaction.reply({ embeds: [createErrorEmbed(error, interaction.guild)], ephemeral: true });

        if (id === "cfg_set_manager_role") {
            if (data.settings.assistantManagerRoles[interaction.guild.id] === roleId || data.settings.playerManagerRoles[interaction.guild.id] === roleId) return interaction.reply({ embeds: [createErrorEmbed("The manager role must be different from the assistant manager and player manager roles.", interaction.guild)], ephemeral: true });
            setRole(data, interaction.guild.id, "managerRoles", roleId);
            return saveAndReply(interaction, data, "Manager Role Set", `${role} is now the shared manager role.`);
        }
        if (id === "cfg_set_assistant_role") {
            if (data.settings.managerRoles[interaction.guild.id] === roleId || data.settings.playerManagerRoles[interaction.guild.id] === roleId) return interaction.reply({ embeds: [createErrorEmbed("The assistant manager role must be different from the manager and player manager roles.", interaction.guild)], ephemeral: true });
            setRole(data, interaction.guild.id, "assistantManagerRoles", roleId);
            return saveAndReply(interaction, data, "Assistant Manager Role Set", `${role} is now the shared assistant manager role.`);
        }
        if (id === "cfg_set_player_manager_role") {
            if (data.settings.managerRoles[interaction.guild.id] === roleId || data.settings.assistantManagerRoles[interaction.guild.id] === roleId) return interaction.reply({ embeds: [createErrorEmbed("The player manager role must be different from the manager and assistant manager roles.", interaction.guild)], ephemeral: true });
            setRole(data, interaction.guild.id, "playerManagerRoles", roleId);
            return saveAndReply(interaction, data, "Player Manager Role Set", `${role} is now the shared player manager role.`);
        }
        if (id === "cfg_set_candidate_role") {
            if (data.settings.managerRoles[interaction.guild.id] === roleId) return interaction.reply({ embeds: [createErrorEmbed("The candidate role must be different from the manager role.", interaction.guild)], ephemeral: true });
            setRole(data, interaction.guild.id, "candidateRoles", roleId);
            return saveAndReply(interaction, data, "Candidate Role Set", `${role} is now the manager lottery pool.`);
        }
        if (id === "cfg_set_app_admin") {
            const app = ensureApplicationConfig(data, interaction.guild.id);
            app.adminRoleId = roleId;
            return saveAndReply(interaction, data, "Application Admin Role Set", `Members with ${role} can review applications.`);
        }
    }

    if (interaction.isModalSubmit()) {
        const raw = interaction.fields.getTextInputValue("value").trim();
        const value = Number(raw);
        if (!Number.isInteger(value) || value < 1 || value > 100) return interaction.reply({ embeds: [createErrorEmbed("Enter a whole number from 1 to 100.", interaction.guild)], ephemeral: true });
        const data = loadData();
        if (interaction.customId === "cfg_modal_roster_limit") {
            data.settings.rosterLimits[interaction.guild.id] = value;
            saveData(data);
            return interaction.reply({ embeds: [createSuccessEmbed(interaction.guild, "Roster Limit Updated", `Every registered team can now have up to **${value}** players.`)] });
        }
        if (interaction.customId === "cfg_modal_demand_limit") {
            data.settings.demandLimits[interaction.guild.id] = value;
            saveData(data);
            return interaction.reply({ embeds: [createSuccessEmbed(interaction.guild, "Demand Limit Updated", `Each member can now leave a team up to **${value}** times.`)] });
        }
    }
}

module.exports = { command, handleInteraction };
