"use strict";

const crypto = require("crypto");
const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    ChannelType,
    EmbedBuilder,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    ButtonBuilder,
    ButtonStyle
} = require("discord.js");

const { loadData, saveData } = require("./database.js");
const { createErrorEmbed, createSuccessEmbed, createStatusEmbed } = require("./embeds.js");
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
    if (!config.types) config.types = {};
    return config;
}

function getApplicationId(name) {
    return name.toLowerCase().trim()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 80);
}

function applicationKey(guildId, userId) {
    return `${guildId}:${userId}`;
}

function getApplication(data, guildId, applicationId) {
    return getGuildConfig(data, guildId).types[applicationId] ?? null;
}

function isApplicationAdmin(interaction, config, data) {
    if (!interaction.guild) return false;

    if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
        return true;
    }

    if (config.adminRoleId && interaction.member?.roles?.cache?.has(config.adminRoleId)) {
        return true;
    }

    // Keep application review consistent with the league-admin permission model.
    return canRunLeagueAdmin(interaction, data);
}

function makeApplicationSelect(config) {
    const applications = Object.entries(config.types).slice(0, 25);
    if (!applications.length) return null;

    return new StringSelectMenuBuilder()
        .setCustomId("application_select")
        .setPlaceholder("Select an application...")
        .addOptions(applications.map(([id, application]) => {
            const option = {
                label: application.name.slice(0, 100),
                description: `Apply for ${application.name}`.slice(0, 100),
                value: id
            };
            if (application.emoji) option.emoji = application.emoji;
            return option;
        }));
}

function buildApplicationPanel(guild, config) {
    const menu = makeApplicationSelect(config);
    const icon = guild.iconURL({ size: 128 }) ?? undefined;
    const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setAuthor({ name: guild.name, iconURL: icon })
        .setTitle("Applications")
        .setDescription(
            "Select the position or role you would like to apply for using the dropdown below.\n\n" +
            "Completed applications are sent to the configured review channel. Accepted applicants receive the role configured for that application."
        )
        .setFooter({ text: guild.name });

    if (!menu) return { embeds: [embed], components: [] };

    return {
        embeds: [embed],
        components: [new ActionRowBuilder().addComponents(menu)]
    };
}

function makeQuestionEmbed(application, questionIndex) {
    return new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle(`${application.name} Application`)
        .setDescription(
            "Answer the question below by sending a message.\n\n" +
            "Type `cancel` at any time to cancel your application."
        )
        .addFields({
            name: `Question ${questionIndex + 1}/${application.questions.length}`,
            value: application.questions[questionIndex]
        })
        .setFooter({ text: "Super League Bot" });
}

function reviewButtonId(action, reviewId) {
    return `application_${action}:${reviewId}`;
}

const command = {
    data: new SlashCommandBuilder()
        .setName("applications")
        .setDescription("Configure and manage server applications.")
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
        .addSubcommand(subcommand => subcommand
            .setName("delete")
            .setDescription("Delete an application type.")
            .addStringOption(option => option
                .setName("application")
                .setDescription("Application to delete.")
                .setRequired(true)
                .setAutocomplete(true)))
        .addSubcommand(subcommand => subcommand
            .setName("list")
            .setDescription("List application types."))
        .addSubcommand(subcommand => subcommand
            .setName("panel")
            .setDescription("Send the application panel.")
            .addChannelOption(option => option
                .setName("channel")
                .setDescription("Channel to send the panel to.")
                .addChannelTypes(ChannelType.GuildText)
                .setRequired(false)))
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
                    .setAutocomplete(true))))
        .addSubcommandGroup(group => group
            .setName("config")
            .setDescription("Configure the application system.")
            .addSubcommand(subcommand => subcommand
                .setName("review-channel")
                .setDescription("Set the application review channel.")
                .addChannelOption(option => option
                    .setName("channel")
                    .setDescription("Where completed applications are sent.")
                    .addChannelTypes(ChannelType.GuildText)
                    .setRequired(true)))
            .addSubcommand(subcommand => subcommand
                .setName("admin-role")
                .setDescription("Set who can review applications.")
                .addRoleOption(option => option
                    .setName("role")
                    .setDescription("Role allowed to review applications.")
                    .setRequired(true)))
            .addSubcommand(subcommand => subcommand
                .setName("panel-channel")
                .setDescription("Set the application panel channel.")
                .addChannelOption(option => option
                    .setName("channel")
                    .setDescription("Where the application panel is sent.")
                    .addChannelTypes(ChannelType.GuildText)
                    .setRequired(true)))
            .addSubcommand(subcommand => subcommand
                .setName("show")
                .setDescription("Show the current application configuration."))),

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
            return interaction.reply({
                embeds: [createErrorEmbed("This command can only be used inside a server.")],
                ephemeral: true
            });
        }

        const data = loadData();
        if (!canRunLeagueAdmin(interaction, data)) {
            return interaction.reply({
                embeds: [createErrorEmbed("You do not have permission to configure applications.", interaction.guild)],
                ephemeral: true
            });
        }

        const config = getGuildConfig(data, interaction.guild.id);
        const group = interaction.options.getSubcommandGroup(false);
        const subcommand = interaction.options.getSubcommand();

        if (!group && subcommand === "create") {
            const name = interaction.options.getString("name", true).trim();
            const role = interaction.options.getRole("role", true);
            const emoji = interaction.options.getString("emoji");
            const id = getApplicationId(name);

            if (!id) {
                return interaction.reply({ embeds: [createErrorEmbed("That application name is invalid.", interaction.guild)], ephemeral: true });
            }
            if (config.types[id]) {
                return interaction.reply({ embeds: [createErrorEmbed("An application with that name already exists.", interaction.guild)], ephemeral: true });
            }
            if (Object.keys(config.types).length >= 25) {
                return interaction.reply({ embeds: [createErrorEmbed("You can have a maximum of 25 application types.", interaction.guild)], ephemeral: true });
            }
            if (role.id === interaction.guild.id || !role.editable) {
                return interaction.reply({ embeds: [createErrorEmbed("I cannot assign that role. Choose a normal role below my highest bot role.", interaction.guild)], ephemeral: true });
            }

            config.types[id] = {
                name,
                roleId: role.id,
                emoji: emoji || null,
                questions: []
            };
            saveData(data);

            return interaction.reply({
                embeds: [createSuccessEmbed(interaction.guild, "Application Created", `Created **${name}**.\n\nAccepted applicants will receive ${role}.\n\nUse `/applications question add` to add questions.`)],
                ephemeral: true
            });
        }

        if (!group && subcommand === "delete") {
            const id = interaction.options.getString("application", true);
            const application = config.types[id];
            if (!application) {
                return interaction.reply({ embeds: [createErrorEmbed("That application does not exist.", interaction.guild)], ephemeral: true });
            }

            delete config.types[id];
            saveData(data);
            return interaction.reply({ embeds: [createSuccessEmbed(interaction.guild, "Application Deleted", `Deleted **${application.name}**.`)], ephemeral: true });
        }

        if (!group && subcommand === "list") {
            const applications = Object.values(config.types);
            if (!applications.length) {
                return interaction.reply({ embeds: [createErrorEmbed("No application types have been created.", interaction.guild)], ephemeral: true });
            }

            const description = applications.map(application =>
                `${application.emoji || "📋"} **${application.name}**\nRole: <@&${application.roleId}>\nQuestions: ${application.questions.length}`
            ).join("\n\n");

            return interaction.reply({
                embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle("Application Types").setDescription(description.slice(0, 4096))],
                ephemeral: true
            });
        }

        if (!group && subcommand === "panel") {
            await interaction.deferReply({ ephemeral: true });

            const channel = interaction.options.getChannel("channel") ||
                interaction.guild.channels.cache.get(config.panelChannelId);

            if (!channel) {
                return interaction.editReply({ embeds: [createErrorEmbed("No panel channel is configured. Use `/applications config panel-channel` first or specify a channel.", interaction.guild)] });
            }
            if (!Object.keys(config.types).length) {
                return interaction.editReply({ embeds: [createErrorEmbed("Create at least one application type first.", interaction.guild)] });
            }

            const message = await channel.send(buildApplicationPanel(interaction.guild, config));
            config.panelChannelId = channel.id;
            config.panelMessageId = message.id;
            saveData(data);

            return interaction.editReply({ embeds: [createSuccessEmbed(interaction.guild, "Application Panel Sent", `The application panel has been sent to ${channel}.`)] });
        }

        if (group === "question") {
            const id = interaction.options.getString("application", true);
            const application = getApplication(data, interaction.guild.id, id);
            if (!application) {
                return interaction.reply({ embeds: [createErrorEmbed("That application does not exist.", interaction.guild)], ephemeral: true });
            }

            if (subcommand === "add") {
                if (application.questions.length >= 20) {
                    return interaction.reply({ embeds: [createErrorEmbed("An application can have a maximum of 20 questions.", interaction.guild)], ephemeral: true });
                }
                const question = interaction.options.getString("question", true).trim();
                if (!question) {
                    return interaction.reply({ embeds: [createErrorEmbed("The question cannot be empty.", interaction.guild)], ephemeral: true });
                }
                application.questions.push(question);
                saveData(data);
                return interaction.reply({ embeds: [createSuccessEmbed(interaction.guild, "Question Added", `Added question **#${application.questions.length}** to **${application.name}**.`)], ephemeral: true });
            }

            if (subcommand === "remove") {
                const number = interaction.options.getInteger("number", true);
                if (number < 1 || number > application.questions.length) {
                    return interaction.reply({ embeds: [createErrorEmbed("That question number does not exist.", interaction.guild)], ephemeral: true });
                }
                application.questions.splice(number - 1, 1);
                saveData(data);
                return interaction.reply({ embeds: [createSuccessEmbed(interaction.guild, "Question Removed", `Removed question **#${number}** from **${application.name}**.`)], ephemeral: true });
            }

            if (subcommand === "list") {
                if (!application.questions.length) {
                    return interaction.reply({ embeds: [createErrorEmbed(`**${application.name}** has no questions.`, interaction.guild)], ephemeral: true });
                }
                const description = application.questions.map((question, index) => `**${index + 1}.** ${question}`).join("\n\n");
                return interaction.reply({
                    embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(`${application.name} Questions`).setDescription(description.slice(0, 4096))],
                    ephemeral: true
                });
            }
        }

        if (group === "config") {
            if (subcommand === "review-channel") {
                config.reviewChannelId = interaction.options.getChannel("channel", true).id;
                saveData(data);
                return interaction.reply({ embeds: [createSuccessEmbed(interaction.guild, "Review Channel Set", `Completed applications will be sent to <#${config.reviewChannelId}>.`)], ephemeral: true });
            }
            if (subcommand === "admin-role") {
                config.adminRoleId = interaction.options.getRole("role", true).id;
                saveData(data);
                return interaction.reply({ embeds: [createSuccessEmbed(interaction.guild, "Application Admin Role Set", `Members with <@&${config.adminRoleId}> can review applications.`)], ephemeral: true });
            }
            if (subcommand === "panel-channel") {
                config.panelChannelId = interaction.options.getChannel("channel", true).id;
                saveData(data);
                return interaction.reply({ embeds: [createSuccessEmbed(interaction.guild, "Panel Channel Set", `The application panel will default to <#${config.panelChannelId}>.`)], ephemeral: true });
            }
            if (subcommand === "show") {
                return interaction.reply({
                    embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle("Application Configuration").addFields(
                        { name: "Review Channel", value: config.reviewChannelId ? `<#${config.reviewChannelId}>` : "Not configured", inline: true },
                        { name: "Admin Role", value: config.adminRoleId ? `<@&${config.adminRoleId}>` : "Not configured", inline: true },
                        { name: "Panel Channel", value: config.panelChannelId ? `<#${config.panelChannelId}>` : "Not configured", inline: true },
                        { name: "Application Types", value: String(Object.keys(config.types).length), inline: true }
                    )],
                    ephemeral: true
                });
            }
        }
    }
};

async function handleApplicationSelect(interaction) {
    if (!interaction.guild) return;

    const data = loadData();
    const config = getGuildConfig(data, interaction.guild.id);
    const applicationId = interaction.values[0];
    const application = config.types[applicationId];

    if (!application) return interaction.reply({ content: "That application no longer exists.", ephemeral: true });
    if (!application.questions?.length) return interaction.reply({ content: "This application has not been configured with any questions yet.", ephemeral: true });

    const activeApplications = data.settings.activeApplications;
    const existing = Object.values(activeApplications).find(active => active.userId === interaction.user.id);
    if (existing) {
        return interaction.reply({ content: "You already have an active application. Finish or cancel it before starting another.", ephemeral: true });
    }

    const key = applicationKey(interaction.guild.id, interaction.user.id);
    try {
        const dm = await interaction.user.createDM();
        activeApplications[key] = {
            guildId: interaction.guild.id,
            userId: interaction.user.id,
            applicationId,
            questionIndex: 0,
            answers: [],
            startedAt: Date.now()
        };
        saveData(data);

        await interaction.reply({ content: "Application started. Check your DMs.", ephemeral: true });

        await dm.send({
            embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(`${application.name} Application`).setDescription(
                "Your application will be completed privately through DMs.\n\nAnswer each question with a separate message.\nType `cancel` at any time to cancel."
            )]
        });
        await dm.send({ embeds: [makeQuestionEmbed(application, 0)] });
    } catch (error) {
        console.error("Could not start application DM:", error);
        delete activeApplications[key];
        saveData(data);
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: "I couldn't send you a DM. Please enable DMs from server members and try again.", ephemeral: true });
        }
    }
}

async function handleApplicationDM(message) {
    if (message.author.bot || message.guild) return;

    const data = loadData();
    const key = Object.keys(data.settings.activeApplications).find(value => value.endsWith(`:${message.author.id}`));
    if (!key) return;

    const active = data.settings.activeApplications[key];
    const guild = message.client.guilds.cache.get(active.guildId);
    if (!guild) {
        delete data.settings.activeApplications[key];
        saveData(data);
        return;
    }

    const config = getGuildConfig(data, active.guildId);
    const application = config.types[active.applicationId];
    if (!application) {
        delete data.settings.activeApplications[key];
        saveData(data);
        await message.reply("This application is no longer available.");
        return;
    }

    const answer = message.content.trim();
    if (!answer) return;

    if (answer.toLowerCase() === "cancel") {
        delete data.settings.activeApplications[key];
        saveData(data);
        await message.reply("Your application has been cancelled.");
        return;
    }

    active.answers.push(answer.slice(0, 4000));
    active.questionIndex++;

    if (active.questionIndex < application.questions.length) {
        saveData(data);
        await message.reply({ embeds: [makeQuestionEmbed(application, active.questionIndex)] });
        return;
    }

    if (!config.reviewChannelId) {
        delete data.settings.activeApplications[key];
        saveData(data);
        await message.reply("Your application was completed, but this server has not configured an application review channel. Please contact a server administrator.");
        return;
    }

    const reviewChannel = guild.channels.cache.get(config.reviewChannelId);
    if (!reviewChannel?.isTextBased()) {
        delete data.settings.activeApplications[key];
        saveData(data);
        await message.reply("Your application was completed, but the configured review channel could not be found. Please contact a server administrator.");
        return;
    }

    const reviewId = crypto.randomBytes(12).toString("hex");
    data.settings.applicationReviews[reviewId] = {
        id: reviewId,
        guildId: guild.id,
        userId: message.author.id,
        applicationId: active.applicationId,
        applicationName: application.name,
        roleId: application.roleId,
        questions: application.questions.slice(),
        answers: active.answers.slice(),
        status: "pending",
        submittedAt: Date.now()
    };
    delete data.settings.activeApplications[key];

    try {
        saveData(data);
    } catch (error) {
        console.error("Failed to save completed application:", error);
        await message.reply("I couldn't save your completed application. Please contact a server administrator.");
        return;
    }

    const fields = application.questions.map((question, index) => ({
        name: `Q${index + 1}: ${question}`.slice(0, 256),
        value: (active.answers[index] || "No answer").slice(0, 1024)
    }));

    const embed = new EmbedBuilder()
        .setColor(0xf1c40f)
        .setTitle(`${application.name} Application`)
        .setDescription(
            `**Applicant:** <@${message.author.id}>\n` +
            `**Application:** ${application.name}\n` +
            "**Status:** 🟡 Pending"
        )
        .addFields(fields)
        .setTimestamp()
        .setFooter({ text: `Review ID: ${reviewId}` });

    const buttons = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(reviewButtonId("accept", reviewId)).setLabel("Accept").setEmoji("✅").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(reviewButtonId("reject", reviewId)).setLabel("Reject").setEmoji("❌").setStyle(ButtonStyle.Danger)
    );

    try {
        await reviewChannel.send({ embeds: [embed], components: [buttons] });
        await message.reply(`Your **${application.name}** application has been submitted successfully. You will be notified when it has been reviewed.`);
    } catch (error) {
        console.error("Failed to send application review:", error);
        const review = data.settings.applicationReviews[reviewId];
        if (review) review.status = "delivery_failed";
        saveData(data);
        await message.reply("Your application was saved, but I couldn't send it to the review channel. Please contact a server administrator.");
    }
}

async function handleApplicationReview(interaction) {
    const [action, reviewId] = interaction.customId.split(":");
    const data = loadData();

    if (!reviewId || !["application_accept", "application_reject"].includes(action)) {
        return interaction.reply({ content: "Invalid application review action.", ephemeral: true });
    }

    const review = data.settings.applicationReviews[reviewId];
    if (!review) {
        return interaction.reply({ content: "This application review no longer exists.", ephemeral: true });
    }
    if (interaction.guildId !== review.guildId) {
        return interaction.reply({ content: "This application belongs to another server.", ephemeral: true });
    }

    const config = getGuildConfig(data, review.guildId);
    if (!isApplicationAdmin(interaction, config, data)) {
        return interaction.reply({ content: "You do not have permission to review applications.", ephemeral: true });
    }

    if (review.status !== "pending") {
        return interaction.reply({ content: `This application has already been ${review.status.replace("_", " ")}.`, ephemeral: true });
    }

    const accepted = action === "application_accept";
    const role = interaction.guild.roles.cache.get(review.roleId);

    if (accepted) {
        if (!role) return interaction.reply({ content: "The role configured for this application no longer exists.", ephemeral: true });
        if (!interaction.guild.members.me || role.position >= interaction.guild.members.me.roles.highest.position) {
            return interaction.reply({ content: "I cannot assign that role because it is higher than or equal to my highest role.", ephemeral: true });
        }

        const member = await interaction.guild.members.fetch(review.userId).catch(() => null);
        if (!member) return interaction.reply({ content: "I couldn't find the applicant in this server.", ephemeral: true });

        // Claim the review before awaiting Discord. A second reviewer will now see
        // a non-pending record instead of processing the same application twice.
        review.status = "accepted";
        review.reviewedBy = interaction.user.id;
        review.reviewedAt = Date.now();
        try {
            saveData(data);
        } catch (error) {
            console.error(error);
            review.status = "pending";
            delete review.reviewedBy;
            delete review.reviewedAt;
            return interaction.reply({ content: "I couldn't save the review state, so the application was not accepted.", ephemeral: true });
        }

        try {
            await member.roles.add(role, `Accepted application ${reviewId} by ${interaction.user.tag}`);
        } catch (error) {
            console.error("Failed to assign application role:", error);
            review.status = "pending";
            delete review.reviewedBy;
            delete review.reviewedAt;
            saveData(data);
            return interaction.reply({ content: "I couldn't assign the configured role. Check my Manage Roles permission and role hierarchy.", ephemeral: true });
        }
    } else {
        review.status = "rejected";
        review.reviewedBy = interaction.user.id;
        review.reviewedAt = Date.now();
        saveData(data);
    }

    try {
        const user = await interaction.client.users.fetch(review.userId);
        await user.send(
            accepted
                ? `Your **${review.applicationName}** application in **${interaction.guild.name}** has been **accepted**.\n\nYou have been given <@&${review.roleId}>.`
                : `Your **${review.applicationName}** application in **${interaction.guild.name}** has been **rejected**.`
        );
    } catch (error) {
        console.error("Could not notify applicant:", error);
    }

    const oldEmbed = interaction.message.embeds[0];
    const updatedEmbed = oldEmbed ? EmbedBuilder.from(oldEmbed) : new EmbedBuilder();
    updatedEmbed
        .setColor(accepted ? 0x57f287 : 0xed4245)
        .setDescription(
            `**Applicant:** <@${review.userId}>\n` +
            `**Application:** ${review.applicationName}\n` +
            `**Status:** ${accepted ? "🟢 Accepted" : "🔴 Rejected"}\n` +
            `**Reviewed by:** <@${interaction.user.id}>`
        )
        .setTimestamp();

    await interaction.update({ embeds: [updatedEmbed], components: [] });
}

module.exports = {
    command,
    handleApplicationSelect,
    handleApplicationDM,
    handleApplicationReview
};
