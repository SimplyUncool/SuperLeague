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

const dbPath = path.resolve(
    process.env.SUPER_LEAGUE_DB_PATH || path.resolve(__dirname, "..", "users.json")
);
const ticketConfigPath = path.join(path.dirname(dbPath), "tickets.json");

function ownerOnly(interaction) {
    return Boolean(interaction.guild && interaction.guild.ownerId === interaction.user.id);
}

function ensureTicketConfig(config, guildId) {
    config.guilds ??= {};
    config.guilds[guildId] ??= {
        categoryId: null,
        panelChannelId: null,
        panelMessageId: null
    };
    return config.guilds[guildId];
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

function status(value) {
    return value || "Not configured";
}

function mainEmbed(guild, data) {
    const tickets = ensureTicketConfig(loadTicketConfig(), guild.id);
    const roster = getRosterLimit(data, guild.id);
    const demand = getDemandLimit(data, guild.id);

    return new EmbedBuilder()
        .setColor(0x5865f2)
        .setAuthor({ name: guild.name, iconURL: guild.iconURL({ size: 128 }) ?? undefined })
        .setTitle("Super League Configuration")
        .setDescription("Configure the league from the menus below.\n\n**Server owner only.** Changes are saved immediately.")
        .addFields(
            {
                name: "Channels",
                value: [
                    `Staff Logs: ${status(data.settings.logChannels[guild.id] && `<#${data.settings.logChannels[guild.id]}>`)}`,
                    `Transactions: ${status(data.settings.transactionChannels[guild.id] && `<#${data.settings.transactionChannels[guild.id]}>`)}`
                ].join("\n"),
                inline: true
            },
            {
                name: "Roles",
                value: [
                    `Manager: ${status(data.settings.managerRoles[guild.id] && `<@&${data.settings.managerRoles[guild.id]}>`)}`,
                    `Assistant: ${status(data.settings.assistantManagerRoles[guild.id] && `<@&${data.settings.assistantManagerRoles[guild.id]}>`)}`,
                    `Player Manager: ${status(data.settings.playerManagerRoles[guild.id] && `<@&${data.settings.playerManagerRoles[guild.id]}>`)}`,
                    `Candidate: ${status(data.settings.candidateRoles[guild.id] && `<@&${data.settings.candidateRoles[guild.id]}>`)}`
                ].join("\n"),
                inline: true
            },
            {
                name: "Limits",
                value: `Roster: **${roster}**\nDemands: **${demand}** per member`,
                inline: true
            },
            {
                name: "Tickets",
                value: `Category: ${status(tickets.categoryId && `<#${tickets.categoryId}>`)}\nPanel: ${status(tickets.panelChannelId && `<#${tickets.panelChannelId}>`)}`,
                inline: true
            },
            {
                name: "Access",
                value: "Echo and League Administration access lists",
                inline: true
            }
        )
        .setFooter({ text: "Super League • Server Owner Configuration" });
}

function button(id, label, style = ButtonStyle.Primary) {
    return new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
}

function mainRows() {
    return [
        new ActionRowBuilder().addComponents(
            button("cfg_channels", "Channels"),
            button("cfg_roles", "Roles"),
            button("cfg_limits", "Limits"),
            button("cfg_tickets", "Tickets"),
            button("cfg_access", "Access")
        ),
        new ActionRowBuilder().addComponents(button("cfg_refresh", "Refresh", ButtonStyle.Secondary))
    ];
}

function backRow() {
    return new ActionRowBuilder().addComponents(button("cfg_home", "Back", ButtonStyle.Secondary));
}

function pageEmbed(title, description) {
    return new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle(title)
        .setDescription(description);
}

function settingSelect(customId, placeholder, options) {
    return new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId(customId)
            .setPlaceholder(placeholder)
            .addOptions(options)
    );
}

function channelSelect(customId, placeholder, types = [ChannelType.GuildText]) {
    return new ActionRowBuilder().addComponents(
        new ChannelSelectMenuBuilder()
            .setCustomId(customId)
            .setPlaceholder(placeholder)
            .setChannelTypes(types)
            .setMinValues(1)
            .setMaxValues(1)
    );
}

function roleSelect(customId, placeholder) {
    return new ActionRowBuilder().addComponents(
        new RoleSelectMenuBuilder()
            .setCustomId(customId)
            .setPlaceholder(placeholder)
            .setMinValues(1)
            .setMaxValues(1)
    );
}

function buildChannels() {
    return {
        embeds: [pageEmbed("Channels", "Choose what you want to configure, then select the channel.\n\nThe selected channel is saved immediately.")],
        components: [
            settingSelect("cfg_channel_setting", "Choose a channel setting", [
                { label: "Staff Logs", value: "log", description: "Where staff command logs are sent" },
                { label: "Transactions", value: "transaction", description: "Where completed transactions are sent" }
            ]),
            backRow()
        ]
    };
}

function buildChannelSetting(setting) {
    const details = {
        log: ["Staff Logs", "Select the channel where staff command audit logs should be posted."],
        transaction: ["Transactions", "Select the channel where completed transactions should be posted."]
    }[setting];

    if (!details) return buildChannels();

    return {
        embeds: [pageEmbed(details[0], details[1])],
        components: [
            channelSelect(`cfg_channel_set:${setting}`, "Select channel"),
            new ActionRowBuilder().addComponents(button("cfg_channels", "Choose Another", ButtonStyle.Secondary), button("cfg_home", "Home", ButtonStyle.Secondary))
        ]
    };
}

function buildRoles() {
    return {
        embeds: [pageEmbed("Roles", "Choose one staff role to configure.\n\nThe bot validates that the role is usable and is not a registered team role.")],
        components: [
            settingSelect("cfg_role_setting", "Choose a role setting", [
                { label: "Manager Role", value: "manager", description: "Shared manager role" },
                { label: "Assistant Manager Role", value: "assistant", description: "Shared assistant manager role" },
                { label: "Player Manager Role", value: "player_manager", description: "Shared player manager role" },
                { label: "Candidate Pool", value: "candidate", description: "Role used for manager candidates" }
            ]),
            backRow()
        ]
    };
}

function buildRoleSetting(setting) {
    const names = {
        manager: ["Manager Role", "Select the shared manager role."],
        assistant: ["Assistant Manager Role", "Select the shared assistant manager role."],
        player_manager: ["Player Manager Role", "Select the shared player manager role."],
        candidate: ["Manager Candidate Pool", "Select the role used for the manager lottery pool."]
    };
    if (!names[setting]) return buildRoles();

    return {
        embeds: [pageEmbed(names[setting][0], names[setting][1])],
        components: [
            roleSelect(`cfg_role_set:${setting}`, "Select role"),
            new ActionRowBuilder().addComponents(button("cfg_roles", "Choose Another", ButtonStyle.Secondary), button("cfg_home", "Home", ButtonStyle.Secondary))
        ]
    };
}

function buildLimits() {
    return {
        embeds: [pageEmbed("Limits", "Set the maximum roster size, set how many demands a member gets, or reset everyone's used demands.")],
        components: [
            new ActionRowBuilder().addComponents(
                button("cfg_roster_limit", "Roster Limit"),
                button("cfg_demand_limit", "Demand Limit"),
                button("cfg_demand_reset", "Reset Demands", ButtonStyle.Danger)
            ),
            backRow()
        ]
    };
}

function buildTickets() {
    const ticket = ensureTicketConfig(loadTicketConfig(), "__preview__");
    return {
        embeds: [pageEmbed("Tickets", "Configure the support ticket system.\n\nChoose a setting first, then select its Discord channel.")],
        components: [
            settingSelect("cfg_ticket_setting", "Choose a ticket setting", [
                { label: "Ticket Category", value: "category", description: "Category where new tickets are created" },
                { label: "Panel Channel", value: "panel", description: "Channel where the ticket panel is posted" }
            ]),
            backRow()
        ]
    };
}

function buildTicketSetting(setting) {
    const details = {
        category: ["Ticket Category", "Select the category where new support tickets should be created."],
        panel: ["Ticket Panel Channel", "Select the channel where the public ticket panel should be posted."]
    }[setting];
    if (!details) return buildTickets();

    const type = setting === "category" ? [ChannelType.GuildCategory] : [ChannelType.GuildText];
    return {
        embeds: [pageEmbed(details[0], details[1])],
        components: [
            channelSelect(`cfg_ticket_set:${setting}`, "Select channel", type),
            new ActionRowBuilder().addComponents(button("cfg_tickets", "Choose Another", ButtonStyle.Secondary), button("cfg_home", "Home", ButtonStyle.Secondary))
        ]
    };
}

function buildAccess() {
    return {
        embeds: [pageEmbed("Access Lists", "Select a member to manage their restricted access.\n\nYou can grant or remove **Echo** and **League Administration** access.")],
        components: [
            new ActionRowBuilder().addComponents(
                new UserSelectMenuBuilder()
                    .setCustomId("cfg_access_user")
                    .setPlaceholder("Select a member")
                    .setMinValues(1)
                    .setMaxValues(1)
            ),
            backRow()
        ]
    };
}

function buildAccessScope(userId) {
    return {
        embeds: [pageEmbed("Access Lists", `Member: <@${userId}>\n\nChoose which restricted access list to modify.`)],
        components: [
            settingSelect(`cfg_access_scope:${userId}`, "Choose an access list", [
                { label: "Echo", value: "echo", description: "Allow this member to use /echo" },
                { label: "League Administration", value: "league_admin", description: "Allow restricted league administration commands" }
            ]),
            new ActionRowBuilder().addComponents(button("cfg_access", "Choose Another", ButtonStyle.Secondary), button("cfg_home", "Home", ButtonStyle.Secondary))
        ]
    };
}

function buildAccessActions(userId, scope) {
    const label = scope === "echo" ? "Echo" : "League Administration";
    return {
        embeds: [pageEmbed(label, `Member: <@${userId}>\n\nChoose whether to grant or remove **${label}** access.`)],
        components: [
            new ActionRowBuilder().addComponents(
                button(`cfg_access_apply:add:${scope}:${userId}`, "Grant Access", ButtonStyle.Success),
                button(`cfg_access_apply:remove:${scope}:${userId}`, "Remove Access", ButtonStyle.Danger)
            ),
            new ActionRowBuilder().addComponents(button(`cfg_access_scope_back:${userId}`, "Back", ButtonStyle.Secondary), button("cfg_home", "Home", ButtonStyle.Secondary))
        ]
    };
}

function buildModal(customId, title, label, value) {
    return new ModalBuilder()
        .setCustomId(customId)
        .setTitle(title)
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId("value")
                    .setLabel(label)
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true)
                    .setValue(String(value))
            )
        );
}

function validateRole(interaction, role) {
    if (!role || role.id === interaction.guild.id) return "Choose a normal Discord role instead of @everyone.";
    const data = loadData();
    if (data.teams[role.id]) return "A registered team role cannot also be used as a shared staff role.";
    if (!role.editable) return `I cannot assign ${role}. Place my bot role above it and make sure I have Manage Roles.`;
    return null;
}

function setRole(data, guildId, key, roleId) {
    data.settings[key][guildId] = roleId;
}

function savePanel(interaction, data, title, description, page) {
    saveData(data);
    return interaction.update({ embeds: [createSuccessEmbed(interaction.guild, title, description)], components: page.components });
}

const command = {
    data: new SlashCommandBuilder()
        .setName("config")
        .setDescription("Open the Super League server configuration panel."),

    async execute(interaction) {
        if (!interaction.guild) return interaction.reply({ embeds: [createErrorEmbed("This command can only be used inside a server.")], ephemeral: true });
        if (!ownerOnly(interaction)) return interaction.reply({ embeds: [createErrorEmbed("Only the server owner can open and use the configuration panel.", interaction.guild)], ephemeral: true });
        const data = loadData();
        await interaction.reply({ embeds: [mainEmbed(interaction.guild, data)], components: mainRows() });
    }
};

async function handleInteraction(interaction) {
    if (!interaction.guild) return;
    if (!ownerOnly(interaction)) {
        return interaction.reply({ embeds: [createErrorEmbed("Only the server owner can use this configuration panel.", interaction.guild)], ephemeral: true });
    }

    const id = interaction.customId;

    if (interaction.isButton()) {
        if (id === "cfg_home" || id === "cfg_refresh") {
            const data = loadData();
            return interaction.update({ embeds: [mainEmbed(interaction.guild, data)], components: mainRows() });
        }
        if (id === "cfg_channels") return interaction.update(buildChannels());
        if (id === "cfg_roles") return interaction.update(buildRoles());
        if (id === "cfg_limits") return interaction.update(buildLimits());
        if (id === "cfg_tickets") return interaction.update(buildTickets());
        if (id === "cfg_access") return interaction.update(buildAccess());

        if (id === "cfg_roster_limit") {
            return interaction.showModal(buildModal("cfg_modal_roster_limit", "Roster Limit", "Maximum players per team", getRosterLimit(loadData(), interaction.guild.id)));
        }
        if (id === "cfg_demand_limit") {
            return interaction.showModal(buildModal("cfg_modal_demand_limit", "Demand Limit", "Demands per member", getDemandLimit(loadData(), interaction.guild.id)));
        }
        if (id === "cfg_demand_reset") {
            const data = loadData();
            const usage = data.settings.demandUsage[interaction.guild.id] ?? {};
            const count = Object.keys(usage).length;
            for (const userId of Object.keys(usage)) usage[userId] = 0;
            data.settings.demandUsage[interaction.guild.id] = usage;
            saveData(data);
            return interaction.update({ embeds: [createSuccessEmbed(interaction.guild, "Demands Reset", `Reset used demands for **${count}** members.`)], components: buildLimits().components });
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
            return interaction.update({
                embeds: [createSuccessEmbed(interaction.guild, action === "add" ? "Access Granted" : "Access Removed", `<@${userId}> ${action === "add" ? "now has" : "no longer has"} **${scope === "echo" ? "Echo" : "League Administration"}** access.`)],
                components: buildAccess().components
            });
        }
        if (id.startsWith("cfg_access_scope_back:")) {
            return interaction.update(buildAccessScope(id.split(":")[1]));
        }
    }

    if (interaction.isUserSelectMenu?.() && id === "cfg_access_user") {
        return interaction.update(buildAccessScope(interaction.values[0]));
    }

    if (interaction.isStringSelectMenu()) {
        if (id === "cfg_channel_setting") return interaction.update(buildChannelSetting(interaction.values[0]));
        if (id === "cfg_role_setting") return interaction.update(buildRoleSetting(interaction.values[0]));
        if (id === "cfg_ticket_setting") return interaction.update(buildTicketSetting(interaction.values[0]));
        if (id.startsWith("cfg_access_scope:")) return interaction.update(buildAccessActions(id.split(":")[1], interaction.values[0]));
    }

    if (interaction.isChannelSelectMenu?.()) {
        const channelId = interaction.values[0];
        const data = loadData();

        if (id.startsWith("cfg_channel_set:")) {
            const setting = id.split(":")[1];
            if (setting === "log") {
                data.settings.logChannels[interaction.guild.id] = channelId;
                return savePanel(interaction, data, "Staff Logs Updated", `Staff audit logs will now be posted in <#${channelId}>.`, buildChannelSetting("log"));
            }
            if (setting === "transaction") {
                data.settings.transactionChannels[interaction.guild.id] = channelId;
                return savePanel(interaction, data, "Transactions Updated", `Completed transactions will now be posted in <#${channelId}>.`, buildChannelSetting("transaction"));
            }
        }

        if (id.startsWith("cfg_ticket_set:")) {
            const setting = id.split(":")[1];
            const config = loadTicketConfig();
            const ticket = ensureTicketConfig(config, interaction.guild.id);
            if (setting === "category") {
                ticket.categoryId = channelId;
                saveTicketConfig(config);
                return interaction.update({ embeds: [createSuccessEmbed(interaction.guild, "Ticket Category Updated", `New tickets will be created in <#${channelId}>.`)], components: buildTicketSetting("category").components });
            }
            if (setting === "panel") {
                ticket.panelChannelId = channelId;
                saveTicketConfig(config);
                return interaction.update({ embeds: [createSuccessEmbed(interaction.guild, "Ticket Panel Channel Updated", `The ticket panel channel is now <#${channelId}>.`)], components: buildTicketSetting("panel").components });
            }
        }
    }

    if (interaction.isRoleSelectMenu?.()) {
        const roleId = interaction.values[0];
        const role = interaction.guild.roles.cache.get(roleId);
        const error = validateRole(interaction, role);
        if (error) return interaction.reply({ embeds: [createErrorEmbed(error, interaction.guild)], ephemeral: true });

        const setting = id.startsWith("cfg_role_set:") ? id.split(":")[1] : null;
        const data = loadData();
        const guildId = interaction.guild.id;
        const checks = {
            manager: ["assistantManagerRoles", "playerManagerRoles", "The manager role must be different from the assistant manager and player manager roles."],
            assistant: ["managerRoles", "playerManagerRoles", "The assistant manager role must be different from the manager and player manager roles."],
            player_manager: ["managerRoles", "assistantManagerRoles", "The player manager role must be different from the manager and assistant manager roles."]
        };

        if (checks[setting]) {
            const [first, second, message] = checks[setting];
            if (data.settings[first][guildId] === roleId || data.settings[second][guildId] === roleId) {
                return interaction.reply({ embeds: [createErrorEmbed(message, interaction.guild)], ephemeral: true });
            }
        }
        if (setting === "candidate" && data.settings.managerRoles[guildId] === roleId) {
            return interaction.reply({ embeds: [createErrorEmbed("The candidate role must be different from the manager role.", interaction.guild)], ephemeral: true });
        }

        const keys = {
            manager: "managerRoles",
            assistant: "assistantManagerRoles",
            player_manager: "playerManagerRoles",
            candidate: "candidateRoles"
        };
        if (!keys[setting]) return;
        setRole(data, guildId, keys[setting], roleId);
        return savePanel(interaction, data, "Role Updated", `${role} is now the configured ${setting === "candidate" ? "manager candidate pool" : setting.replace("_", " ") + " role"}.`, buildRoleSetting(setting));
    }

    if (interaction.isModalSubmit()) {
        const raw = interaction.fields.getTextInputValue("value").trim();
        const value = Number(raw);
        if (!Number.isInteger(value) || value < 1 || value > 100) {
            return interaction.reply({ embeds: [createErrorEmbed("Enter a whole number from 1 to 100.", interaction.guild)], ephemeral: true });
        }
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
