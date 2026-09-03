"use strict";

const { SlashCommandBuilder, EmbedBuilder } = require("discord.js");
const { loadData, saveData } = require("./database.js");
const { createErrorEmbed, createSuccessEmbed } = require("./embeds.js");
const { canRunLeagueAdmin } = require("./permissions.js");

function getGuildConfig(data, guildId) {
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

function getApplicationId(name) {
    return name.toLowerCase().trim()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 80);
}

const command = {
    data: new SlashCommandBuilder()
        .setName("applications")
        .setDescription("Create application types and manage their questions.")
        .addSubcommand(subcommand => subcommand
            .setName("create")
            .setDescription("Create an application type.")
            .addStringOption(option => option
                .setName("name")
                .setDescription("Name of the application.")
                .setRequired(true)
                .setMaxLength(100))
            .addRoleOption(option => option
                .setName("role")
                .setDescription("Role given when accepted.")
                .setRequired(true))
            .addStringOption(option => option
                .setName("emoji")
                .setDescription("Optional emoji.")
                .setRequired(false)
                .setMaxLength(50)))
        .addSubcommandGroup(group => group
            .setName("question")
            .setDescription("Manage application questions.")
            .addSubcommand(subcommand => subcommand
                .setName("add")
                .setDescription("Add a question.")
                .addStringOption(option => option
                    .setName("application")
                    .setDescription("Application.")
                    .setRequired(true)
                    .setAutocomplete(true))
                .addStringOption(option => option
                    .setName("question")
                    .setDescription("Question to ask.")
                    .setRequired(true)
                    .setMaxLength(1000)))
            .addSubcommand(subcommand => subcommand
                .setName("remove")
                .setDescription("Remove a question.")
                .addStringOption(option => option
                    .setName("application")
                    .setDescription("Application.")
                    .setRequired(true)
                    .setAutocomplete(true))
                .addIntegerOption(option => option
                    .setName("number")
                    .setDescription("Question number.")
                    .setRequired(true)
                    .setMinValue(1)))
            .addSubcommand(subcommand => subcommand
                .setName("list")
                .setDescription("List application questions.")
                .addStringOption(option => option
                    .setName("application")
                    .setDescription("Application.")
                    .setRequired(true)
                    .setAutocomplete(true)))),

    async autocomplete(interaction) {
        const data = loadData();
        const config = getGuildConfig(data, interaction.guildId);
        const focused = interaction.options.getFocused().toLowerCase();
        await interaction.respond(
            Object.entries(config.types)
                .filter(([, application]) => application.name.toLowerCase().includes(focused))
                .slice(0, 25)
                .map(([id, application]) => ({ name: application.name, value: id }))
        );
    },

    async execute(interaction) {
        if (!interaction.guild) {
            return interaction.reply({ embeds: [createErrorEmbed("This command can only be used inside a server.")], ephemeral: true });
        }

        const data = loadData();
        if (!canRunLeagueAdmin(interaction, data)) {
            return interaction.reply({ embeds: [createErrorEmbed("You do not have permission to configure applications.", interaction.guild)], ephemeral: true });
        }

        const config = getGuildConfig(data, interaction.guild.id);
        const group = interaction.options.getSubcommandGroup(false);
        const subcommand = interaction.options.getSubcommand();

        if (!group && subcommand === "create") {
            const name = interaction.options.getString("name", true).trim();
            const role = interaction.options.getRole("role", true);
            const emoji = interaction.options.getString("emoji");
            const id = getApplicationId(name);

            if (!id) return interaction.reply({ embeds: [createErrorEmbed("That application name is invalid.", interaction.guild)], ephemeral: true });
            if (config.types[id]) return interaction.reply({ embeds: [createErrorEmbed("An application with that name already exists.", interaction.guild)], ephemeral: true });
            if (Object.keys(config.types).length >= 25) return interaction.reply({ embeds: [createErrorEmbed("You can have a maximum of 25 application types.", interaction.guild)], ephemeral: true });
            if (role.id === interaction.guild.id || !role.editable) return interaction.reply({ embeds: [createErrorEmbed("I cannot assign that role. Choose a normal role below my highest bot role.", interaction.guild)], ephemeral: true });

            config.types[id] = { name, roleId: role.id, emoji: emoji || null, questions: [] };
            saveData(data);
            return interaction.reply({ embeds: [createSuccessEmbed(interaction.guild, "Application Created", `Created **${name}**. Accepted applicants will receive ${role}. Use the question commands to add questions.`)] });
        }

        if (group !== "question") return;

        const id = interaction.options.getString("application", true);
        const application = config.types[id];
        if (!application) return interaction.reply({ embeds: [createErrorEmbed("That application does not exist.", interaction.guild)], ephemeral: true });

        if (subcommand === "add") {
            if (application.questions.length >= 20) return interaction.reply({ embeds: [createErrorEmbed("An application can have a maximum of 20 questions.", interaction.guild)], ephemeral: true });
            const question = interaction.options.getString("question", true).trim();
            if (!question) return interaction.reply({ embeds: [createErrorEmbed("The question cannot be empty.", interaction.guild)], ephemeral: true });
            application.questions.push(question);
            saveData(data);
            return interaction.reply({ embeds: [createSuccessEmbed(interaction.guild, "Question Added", `Added question **#${application.questions.length}** to **${application.name}**.`)] });
        }

        if (subcommand === "remove") {
            const number = interaction.options.getInteger("number", true);
            if (number < 1 || number > application.questions.length) return interaction.reply({ embeds: [createErrorEmbed("That question number does not exist.", interaction.guild)], ephemeral: true });
            application.questions.splice(number - 1, 1);
            saveData(data);
            return interaction.reply({ embeds: [createSuccessEmbed(interaction.guild, "Question Removed", `Removed question **#${number}** from **${application.name}**.`)] });
        }

        if (subcommand === "list") {
            if (!application.questions.length) return interaction.reply({ embeds: [createErrorEmbed(`**${application.name}** has no questions.`, interaction.guild)], ephemeral: true });
            const description = application.questions.map((question, index) => `**${index + 1}.** ${question}`).join("\n\n");
            return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(`${application.name} Questions`).setDescription(description.slice(0, 4096))] });
        }
    }
};

module.exports = { command };
