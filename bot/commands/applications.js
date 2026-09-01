"use strict";

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

const {
    loadData,
    saveData
} = require("./database.js");

const {
    createErrorEmbed,
    createSuccessEmbed
} = require("./embeds.js");

const {
    canRunLeagueAdmin
} = require("./permissions.js");


/* =========================================================
   HELPERS
   ========================================================= */

function getGuildConfig(data, guildId) {
    if (!data.settings.applications) {
        data.settings.applications = {};
    }

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

    if (!config.types) {
        config.types = {};
    }

    return config;
}

function getApplicationId(name) {
    return name
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 80);
}

function getApplication(
    data,
    guildId,
    applicationId
) {
    const config = getGuildConfig(
        data,
        guildId
    );

    return config.types[applicationId] ?? null;
}

function isApplicationAdmin(
    interaction,
    config
) {
    if (!interaction.guild) {
        return false;
    }

    if (
        interaction.memberPermissions?.has(
            PermissionFlagsBits.Administrator
        )
    ) {
        return true;
    }

    if (
        config.adminRoleId &&
        interaction.member?.roles?.cache?.has(
            config.adminRoleId
        )
    ) {
        return true;
    }

    return false;
}

function makeApplicationSelect(config) {
    const applications = Object.entries(
        config.types
    );

    if (applications.length === 0) {
        return null;
    }

    /*
     * Discord dropdowns support a maximum of 25 options.
     */

    const options = applications
        .slice(0, 25)
        .map(([id, application]) => {
            const option = {
                label: application.name.slice(0, 100),
                description:
                    `Apply for ${application.name}`
                        .slice(0, 100),
                value: id
            };

            if (application.emoji) {
                option.emoji = application.emoji;
            }

            return option;
        });

    return new StringSelectMenuBuilder()
        .setCustomId("application_select")
        .setPlaceholder(
            "Select an application..."
        )
        .addOptions(options);
}

function buildApplicationPanel(
    guild,
    config
) {
    const menu =
        makeApplicationSelect(config);

    const icon =
        guild.iconURL({
            size: 128
        }) ?? undefined;

    const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setAuthor({
            name: guild.name,
            iconURL: icon
        })
        .setTitle("Applications")
        .setDescription(
            "Select the position or role you would like to apply for using the dropdown below.\n\n" +
            "Your application questions will be sent to you privately through DMs."
        )
        .setFooter({
            text: guild.name
        });

    if (!menu) {
        return {
            embeds: [embed],
            components: []
        };
    }

    const row =
        new ActionRowBuilder()
            .addComponents(menu);

    return {
        embeds: [embed],
        components: [row]
    };
}

function makeQuestionEmbed(
    application,
    questionIndex
) {
    const total =
        application.questions.length;

    return new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle(
            `${application.name} Application`
        )
        .setDescription(
            "Answer the question below by sending a message.\n\n" +
            "Type `cancel` at any time to cancel your application."
        )
        .addFields({
            name:
                `Question ${questionIndex + 1}/${total}`,
            value:
                application.questions[
                    questionIndex
                ]
        })
        .setFooter({
            text: "Super League Bot"
        });
}

function applicationKey(
    guildId,
    userId
) {
    return `${guildId}:${userId}`;
}

function encodeReviewData(data) {
    return Buffer
        .from(JSON.stringify(data))
        .toString("base64url");
}

function decodeReviewData(value) {
    return JSON.parse(
        Buffer
            .from(value, "base64url")
            .toString("utf8")
    );
}


/* =========================================================
   COMMAND
   ========================================================= */

const command = {
    data: new SlashCommandBuilder()
        .setName("applications")
        .setDescription(
            "Configure and manage server applications."
        )

        /*
         * CREATE
         */

        .addSubcommand(subcommand =>
            subcommand
                .setName("create")
                .setDescription(
                    "Create an application type."
                )

                .addStringOption(option =>
                    option
                        .setName("name")
                        .setDescription(
                            "Name of the application."
                        )
                        .setRequired(true)
                        .setMaxLength(100)
                )

                .addRoleOption(option =>
                    option
                        .setName("role")
                        .setDescription(
                            "Role given when accepted."
                        )
                        .setRequired(true)
                )

                .addStringOption(option =>
                    option
                        .setName("emoji")
                        .setDescription(
                            "Optional emoji."
                        )
                        .setRequired(false)
                        .setMaxLength(50)
                )
        )

        /*
         * DELETE
         */

        .addSubcommand(subcommand =>
            subcommand
                .setName("delete")
                .setDescription(
                    "Delete an application type."
                )

                .addStringOption(option =>
                    option
                        .setName("application")
                        .setDescription(
                            "Application to delete."
                        )
                        .setRequired(true)
                        .setAutocomplete(true)
                )
        )

        /*
         * LIST
         */

        .addSubcommand(subcommand =>
            subcommand
                .setName("list")
                .setDescription(
                    "List application types."
                )
        )

        /*
         * PANEL
         */

        .addSubcommand(subcommand =>
            subcommand
                .setName("panel")
                .setDescription(
                    "Send the application panel."
                )

                .addChannelOption(option =>
                    option
                        .setName("channel")
                        .setDescription(
                            "Channel to send the panel to."
                        )
                        .addChannelTypes(
                            ChannelType.GuildText
                        )
                        .setRequired(false)
                )
        )

        /*
         * QUESTION GROUP
         */

        .addSubcommandGroup(group =>
            group
                .setName("question")
                .setDescription(
                    "Manage application questions."
                )

                .addSubcommand(subcommand =>
                    subcommand
                        .setName("add")
                        .setDescription(
                            "Add a question."
                        )

                        .addStringOption(option =>
                            option
                                .setName("application")
                                .setDescription(
                                    "Application."
                                )
                                .setRequired(true)
                                .setAutocomplete(true)
                        )

                        .addStringOption(option =>
                            option
                                .setName("question")
                                .setDescription(
                                    "Question to ask."
                                )
                                .setRequired(true)
                                .setMaxLength(1000)
                        )
                )

                .addSubcommand(subcommand =>
                    subcommand
                        .setName("remove")
                        .setDescription(
                            "Remove a question."
                        )

                        .addStringOption(option =>
                            option
                                .setName("application")
                                .setDescription(
                                    "Application."
                                )
                                .setRequired(true)
                                .setAutocomplete(true)
                        )

                        .addIntegerOption(option =>
                            option
                                .setName("number")
                                .setDescription(
                                    "Question number."
                                )
                                .setRequired(true)
                                .setMinValue(1)
                        )
                )

                .addSubcommand(subcommand =>
                    subcommand
                        .setName("list")
                        .setDescription(
                            "List application questions."
                        )

                        .addStringOption(option =>
                            option
                                .setName("application")
                                .setDescription(
                                    "Application."
                                )
                                .setRequired(true)
                                .setAutocomplete(true)
                        )
                )
        )

        /*
         * CONFIG GROUP
         */

        .addSubcommandGroup(group =>
            group
                .setName("config")
                .setDescription(
                    "Configure the application system."
                )

                .addSubcommand(subcommand =>
                    subcommand
                        .setName("review-channel")
                        .setDescription(
                            "Set the application review channel."
                        )

                        .addChannelOption(option =>
                            option
                                .setName("channel")
                                .setDescription(
                                    "Where completed applications are sent."
                                )
                                .addChannelTypes(
                                    ChannelType.GuildText
                                )
                                .setRequired(true)
                        )
                )

                .addSubcommand(subcommand =>
                    subcommand
                        .setName("admin-role")
                        .setDescription(
                            "Set who can review applications."
                        )

                        .addRoleOption(option =>
                            option
                                .setName("role")
                                .setDescription(
                                    "Role allowed to review applications."
                                )
                                .setRequired(true)
                        )
                )

                .addSubcommand(subcommand =>
                    subcommand
                        .setName("panel-channel")
                        .setDescription(
                            "Set the application panel channel."
                        )

                        .addChannelOption(option =>
                            option
                                .setName("channel")
                                .setDescription(
                                    "Where the application panel is sent."
                                )
                                .addChannelTypes(
                                    ChannelType.GuildText
                                )
                                .setRequired(true)
                        )
                )

                .addSubcommand(subcommand =>
                    subcommand
                        .setName("show")
                        .setDescription(
                            "Show the current application configuration."
                        )
                )
        ),


    /*
     * AUTOCOMPLETE
     */

    async autocomplete(interaction) {
        const data = loadData();

        const config =
            getGuildConfig(
                data,
                interaction.guildId
            );

        const focused =
            interaction.options
                .getFocused()
                .toLowerCase();

        const choices =
            Object.entries(config.types)
                .filter(
                    ([, application]) =>
                        application.name
                            .toLowerCase()
                            .includes(focused)
                )
                .slice(0, 25)
                .map(
                    ([id, application]) => ({
                        name:
                            application.name,
                        value: id
                    })
                );

        await interaction.respond(
            choices
        );
    },


    /*
     * EXECUTE
     */

    async execute(interaction) {
        if (!interaction.guild) {
            return interaction.reply({
                embeds: [
                    createErrorEmbed(
                        "This command can only be used inside a server."
                    )
                ],
                ephemeral: true
            });
        }

        const data = loadData();

        if (
            !canRunLeagueAdmin(
                interaction,
                data
            )
        ) {
            return interaction.reply({
                embeds: [
                    createErrorEmbed(
                        "You do not have permission to configure applications.",
                        interaction.guild
                    )
                ],
                ephemeral: true
            });
        }

        const config =
            getGuildConfig(
                data,
                interaction.guild.id
            );

        const group =
            interaction.options
                .getSubcommandGroup(false);

        const subcommand =
            interaction.options
                .getSubcommand();


        /* =================================================
           CREATE
           ================================================= */

        if (
            !group &&
            subcommand === "create"
        ) {
            const name =
                interaction.options
                    .getString(
                        "name",
                        true
                    )
                    .trim();

            const role =
                interaction.options
                    .getRole(
                        "role",
                        true
                    );

            const emoji =
                interaction.options
                    .getString(
                        "emoji"
                    );

            const id =
                getApplicationId(name);

            if (!id) {
                return interaction.reply({
                    embeds: [
                        createErrorEmbed(
                            "That application name is invalid.",
                            interaction.guild
                        )
                    ],
                    ephemeral: true
                });
            }

            if (config.types[id]) {
                return interaction.reply({
                    embeds: [
                        createErrorEmbed(
                            "An application with that name already exists.",
                            interaction.guild
                        )
                    ],
                    ephemeral: true
                });
            }

            if (
                Object.keys(
                    config.types
                ).length >= 25
            ) {
                return interaction.reply({
                    embeds: [
                        createErrorEmbed(
                            "You can have a maximum of 25 application types because Discord dropdowns support 25 options.",
                            interaction.guild
                        )
                    ],
                    ephemeral: true
                });
            }

            config.types[id] = {
                name,
                roleId: role.id,
                emoji:
                    emoji || null,
                questions: []
            };

            saveData(data);

            return interaction.reply({
                embeds: [
                    createSuccessEmbed(
                        interaction.guild,
                        "Application Created",
                        `Created **${name}**.\n\n` +
                        `Accepted applicants will receive ${role}.\n\n` +
                        "Use `/applications question add` to add questions."
                    )
                ],
                ephemeral: true
            });
        }


        /* =================================================
           DELETE
           ================================================= */

        if (
            !group &&
            subcommand === "delete"
        ) {
            const id =
                interaction.options
                    .getString(
                        "application",
                        true
                    );

            const application =
                config.types[id];

            if (!application) {
                return interaction.reply({
                    embeds: [
                        createErrorEmbed(
                            "That application does not exist.",
                            interaction.guild
                        )
                    ],
                    ephemeral: true
                });
            }

            delete config.types[id];

            saveData(data);

            return interaction.reply({
                embeds: [
                    createSuccessEmbed(
                        interaction.guild,
                        "Application Deleted",
                        `Deleted **${application.name}**.`
                    )
                ],
                ephemeral: true
            });
        }


        /* =================================================
           LIST
           ================================================= */

        if (
            !group &&
            subcommand === "list"
        ) {
            const applications =
                Object.values(
                    config.types
                );

            if (
                applications.length === 0
            ) {
                return interaction.reply({
                    embeds: [
                        createErrorEmbed(
                            "No application types have been created.",
                            interaction.guild
                        )
                    ],
                    ephemeral: true
                });
            }

            const description =
                applications
                    .map(
                        application =>
                            `${application.emoji || "📋"} **${application.name}**\n` +
                            `Role: <@&${application.roleId}>\n` +
                            `Questions: ${application.questions.length}`
                    )
                    .join("\n\n");

            return interaction.reply({
                embeds: [
                    new EmbedBuilder()
                        .setColor(0x5865f2)
                        .setTitle(
                            "Application Types"
                        )
                        .setDescription(
                            description
                        )
                ],
                ephemeral: true
            });
        }


        /* =================================================
           PANEL
           ================================================= */

        if (
            !group &&
            subcommand === "panel"
        ) {
            const channel =
                interaction.options
                    .getChannel(
                        "channel"
                    ) ||
                interaction.guild.channels.cache.get(
                    config.panelChannelId
                );

            if (!channel) {
                return interaction.reply({
                    embeds: [
                        createErrorEmbed(
                            "No panel channel is configured. Use `/applications config panel-channel` first or specify a channel.",
                            interaction.guild
                        )
                    ],
                    ephemeral: true
                });
            }

            if (
                Object.keys(
                    config.types
                ).length === 0
            ) {
                return interaction.reply({
                    embeds: [
                        createErrorEmbed(
                            "Create at least one application type first.",
                            interaction.guild
                        )
                    ],
                    ephemeral: true
                });
            }

            const panel =
                buildApplicationPanel(
                    interaction.guild,
                    config
                );

            const message =
                await channel.send(
                    panel
                );

            config.panelChannelId =
                channel.id;

            config.panelMessageId =
                message.id;

            saveData(data);

            return interaction.reply({
                embeds: [
                    createSuccessEmbed(
                        interaction.guild,
                        "Application Panel Sent",
                        `The application panel has been sent to ${channel}.`
                    )
                ],
                ephemeral: true
            });
        }


        /* =================================================
           QUESTIONS
           ================================================= */

        if (
            group === "question"
        ) {
            const id =
                interaction.options
                    .getString(
                        "application",
                        true
                    );

            const application =
                getApplication(
                    data,
                    interaction.guild.id,
                    id
                );

            if (!application) {
                return interaction.reply({
                    embeds: [
                        createErrorEmbed(
                            "That application does not exist.",
                            interaction.guild
                        )
                    ],
                    ephemeral: true
                });
            }


            if (
                subcommand === "add"
            ) {
                const question =
                    interaction.options
                        .getString(
                            "question",
                            true
                        )
                        .trim();

                if (
                    application.questions
                        .length >= 20
                ) {
                    return interaction.reply({
                        embeds: [
                            createErrorEmbed(
                                "An application can have a maximum of 20 questions.",
                                interaction.guild
                            )
                        ],
                        ephemeral: true
                    });
                }

                application.questions.push(
                    question
                );

                saveData(data);

                return interaction.reply({
                    embeds: [
                        createSuccessEmbed(
                            interaction.guild,
                            "Question Added",
                            `Added question **#${application.questions.length}** to **${application.name}**.`
                        )
                    ],
                    ephemeral: true
                });
            }


            if (
                subcommand === "remove"
            ) {
                const number =
                    interaction.options
                        .getInteger(
                            "number",
                            true
                        );

                if (
                    number < 1 ||
                    number >
                    application.questions.length
                ) {
                    return interaction.reply({
                        embeds: [
                            createErrorEmbed(
                                "That question number does not exist.",
                                interaction.guild
                            )
                        ],
                        ephemeral: true
                    });
                }

                application.questions.splice(
                    number - 1,
                    1
                );

                saveData(data);

                return interaction.reply({
                    embeds: [
                        createSuccessEmbed(
                            interaction.guild,
                            "Question Removed",
                            `Removed question **#${number}** from **${application.name}**.`
                        )
                    ],
                    ephemeral: true
                });
            }


            if (
                subcommand === "list"
            ) {
                if (
                    application.questions
                        .length === 0
                ) {
                    return interaction.reply({
                        embeds: [
                            createErrorEmbed(
                                `**${application.name}** has no questions.`,
                                interaction.guild
                            )
                        ],
                        ephemeral: true
                    });
                }

                const description =
                    application.questions
                        .map(
                            (question, index) =>
                                `**${index + 1}.** ${question}`
                        )
                        .join("\n\n");

                return interaction.reply({
                    embeds: [
                        new EmbedBuilder()
                            .setColor(
                                0x5865f2
                            )
                            .setTitle(
                                `${application.name} Questions`
                            )
                            .setDescription(
                                description
                            )
                    ],
                    ephemeral: true
                });
            }
        }


        /* =================================================
           CONFIG
           ================================================= */

        if (
            group === "config"
        ) {
            if (
                subcommand ===
                "review-channel"
            ) {
                const channel =
                    interaction.options
                        .getChannel(
                            "channel",
                            true
                        );

                config.reviewChannelId =
                    channel.id;

                saveData(data);

                return interaction.reply({
                    embeds: [
                        createSuccessEmbed(
                            interaction.guild,
                            "Review Channel Set",
                            `Completed applications will be sent to ${channel}.`
                        )
                    ],
                    ephemeral: true
                });
            }


            if (
                subcommand ===
                "admin-role"
            ) {
                const role =
                    interaction.options
                        .getRole(
                            "role",
                            true
                        );

                config.adminRoleId =
                    role.id;

                saveData(data);

                return interaction.reply({
                    embeds: [
                        createSuccessEmbed(
                            interaction.guild,
                            "Application Admin Role Set",
                            `Members with ${role} can review applications.`
                        )
                    ],
                    ephemeral: true
                });
            }


            if (
                subcommand ===
                "panel-channel"
            ) {
                const channel =
                    interaction.options
                        .getChannel(
                            "channel",
                            true
                        );

                config.panelChannelId =
                    channel.id;

                saveData(data);

                return interaction.reply({
                    embeds: [
                        createSuccessEmbed(
                            interaction.guild,
                            "Panel Channel Set",
                            `The application panel will default to ${channel}.`
                        )
                    ],
                    ephemeral: true
                });
            }


            if (
                subcommand === "show"
            ) {
                const review =
                    config.reviewChannelId
                        ? `<#${config.reviewChannelId}>`
                        : "Not configured";

                const panel =
                    config.panelChannelId
                        ? `<#${config.panelChannelId}>`
                        : "Not configured";

                const adminRole =
                    config.adminRoleId
                        ? `<@&${config.adminRoleId}>`
                        : "Not configured";

                return interaction.reply({
                    embeds: [
                        new EmbedBuilder()
                            .setColor(
                                0x5865f2
                            )
                            .setTitle(
                                "Application Configuration"
                            )
                            .addFields(
                                {
                                    name:
                                        "Review Channel",
                                    value:
                                        review,
                                    inline: true
                                },
                                {
                                    name:
                                        "Admin Role",
                                    value:
                                        adminRole,
                                    inline: true
                                },
                                {
                                    name:
                                        "Panel Channel",
                                    value:
                                        panel,
                                    inline: true
                                },
                                {
                                    name:
                                        "Application Types",
                                    value:
                                        String(
                                            Object.keys(
                                                config.types
                                            ).length
                                        ),
                                    inline: true
                                }
                            )
                    ],
                    ephemeral: true
                });
            }
        }
    }
};


/* =========================================================
   DROPDOWN
   ========================================================= */

async function handleApplicationSelect(
    interaction
) {
    if (!interaction.guild) {
        return;
    }

    const data = loadData();

    const config =
        getGuildConfig(
            data,
            interaction.guild.id
        );

    const applicationId =
        interaction.values[0];

    const application =
        config.types[
            applicationId
        ];

    if (!application) {
        return interaction.reply({
            content:
                "That application no longer exists.",
            ephemeral: true
        });
    }

    if (
        application.questions.length === 0
    ) {
        return interaction.reply({
            content:
                "This application has not been configured with any questions yet.",
            ephemeral: true
        });
    }

    /*
     * One active application at a time.
     * This avoids ambiguity because DMs don't identify
     * which server the user is answering for.
     */

    const existing =
        Object.keys(
            data.settings.activeApplications
        ).find(
            key =>
                key.endsWith(
                    `:${interaction.user.id}`
                )
        );

    if (existing) {
        return interaction.reply({
            content:
                "You already have an active application. Finish or cancel it before starting another.",
            ephemeral: true
        });
    }

    const key =
        applicationKey(
            interaction.guild.id,
            interaction.user.id
        );

    try {
        await interaction.user.createDM();
    } catch (error) {
        console.error(
            "Could not create application DM:",
            error
        );

        return interaction.reply({
            content:
                "I couldn't send you a DM. Please enable DMs from server members and try again.",
            ephemeral: true
        });
    }

    data.settings.activeApplications[key] = {
        guildId:
            interaction.guild.id,

        userId:
            interaction.user.id,

        applicationId,

        questionIndex: 0,

        answers: [],

        startedAt:
            Date.now()
    };

    saveData(data);

    await interaction.reply({
        content:
            "Application started. Check your DMs.",
        ephemeral: true
    });

    try {
        const dm =
            await interaction.user.createDM();

        await dm.send({
            embeds: [
                new EmbedBuilder()
                    .setColor(
                        0x5865f2
                    )
                    .setTitle(
                        `${application.name} Application`
                    )
                    .setDescription(
                        "Your application will be completed privately through DMs.\n\n" +
                        "Answer each question with a separate message.\n" +
                        "Type `cancel` at any time to cancel."
                    )
            ]
        });

        await dm.send({
            embeds: [
                makeQuestionEmbed(
                    application,
                    0
                )
            ]
        });

    } catch (error) {
        console.error(
            "Could not send application DM:",
            error
        );

        delete data.settings
            .activeApplications[key];

        saveData(data);
    }
}


/* =========================================================
   DM QUESTIONNAIRE
   ========================================================= */

async function handleApplicationDM(
    message
) {
    if (message.author.bot) {
        return;
    }

    if (message.guild) {
        return;
    }

    const data = loadData();

    const key =
        Object.keys(
            data.settings.activeApplications
        ).find(
            value =>
                value.endsWith(
                    `:${message.author.id}`
                )
        );

    if (!key) {
        return;
    }

    const active =
        data.settings.activeApplications[
            key
        ];

    const guild =
        message.client.guilds.cache.get(
            active.guildId
        );

    if (!guild) {
        delete data.settings
            .activeApplications[key];

        saveData(data);

        return;
    }

    const config =
        getGuildConfig(
            data,
            active.guildId
        );

    const application =
        config.types[
            active.applicationId
        ];

    if (!application) {
        delete data.settings
            .activeApplications[key];

        saveData(data);

        await message.reply(
            "This application is no longer available."
        );

        return;
    }

    const answer =
        message.content.trim();

    if (!answer) {
        return;
    }

    if (
        answer.toLowerCase() ===
        "cancel"
    ) {
        delete data.settings
            .activeApplications[key];

        saveData(data);

        await message.reply(
            "Your application has been cancelled."
        );

        return;
    }

    /*
     * Store answer
     */

    active.answers.push(
        answer.slice(0, 4000)
    );

    active.questionIndex++;

    /*
     * More questions
     */

    if (
        active.questionIndex <
        application.questions.length
    ) {
        saveData(data);

        await message.reply({
            embeds: [
                makeQuestionEmbed(
                    application,
                    active.questionIndex
                )
            ]
        });

        return;
    }

    /*
     * Application finished
     */

    delete data.settings
        .activeApplications[key];

    saveData(data);

    if (!config.reviewChannelId) {
        await message.reply(
            "Your application was completed, but this server has not configured an application review channel. Please contact a server administrator."
        );

        return;
    }

    const reviewChannel =
        guild.channels.cache.get(
            config.reviewChannelId
        );

    if (
        !reviewChannel ||
        !reviewChannel.isTextBased()
    ) {
        await message.reply(
            "Your application was completed, but the configured review channel could not be found. Please contact a server administrator."
        );

        return;
    }

    const fields =
        application.questions.map(
            (question, index) => ({
                name:
                    `Q${index + 1}: ${question}`
                        .slice(0, 256),

                value:
                    (
                        active.answers[index] ||
                        "No answer"
                    ).slice(0, 1024)
            })
        );

    const embed =
        new EmbedBuilder()
            .setColor(0xf1c40f)
            .setTitle(
                `${application.name} Application`
            )
            .setDescription(
                `**Applicant:** <@${message.author.id}>\n` +
                `**Application:** ${application.name}\n` +
                `**Status:** 🟡 Pending`
            )
            .addFields(fields)
            .setTimestamp()
            .setFooter({
                text:
                    `User ID: ${message.author.id}`
            });

    const reviewData = encodeReviewData({
        guildId:
            guild.id,

        userId:
            message.author.id,

        applicationId
    });

    const buttons =
        new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(
                        `application_accept:${reviewData}`
                    )
                    .setLabel(
                        "Accept"
                    )
                    .setEmoji("✅")
                    .setStyle(
                        ButtonStyle.Success
                    ),

                new ButtonBuilder()
                    .setCustomId(
                        `application_reject:${reviewData}`
                    )
                    .setLabel(
                        "Reject"
                    )
                    .setEmoji("❌")
                    .setStyle(
                        ButtonStyle.Danger
                    )
            );

    try {
        await reviewChannel.send({
            embeds: [embed],
            components: [buttons]
        });

        await message.reply(
            `Your **${application.name}** application has been submitted successfully. You will be notified when it has been reviewed.`
        );
    } catch (error) {
        console.error(
            "Failed to send application review:",
            error
        );

        await message.reply(
            "Your application was completed, but I couldn't send it to the review channel. Please contact a server administrator."
        );
    }
}


/* =========================================================
   ACCEPT / REJECT
   ========================================================= */

async function handleApplicationReview(
    interaction
) {
    const [
        action,
        encoded
    ] =
        interaction.customId.split(
            ":"
        );

    const data = loadData();

    let reviewData;

    try {
        reviewData =
            decodeReviewData(
                encoded
            );
    } catch {
        return interaction.reply({
            content:
                "This application review button is invalid.",
            ephemeral: true
        });
    }

    if (
        interaction.guildId !==
        reviewData.guildId
    ) {
        return interaction.reply({
            content:
                "This application belongs to another server.",
            ephemeral: true
        });
    }

    const config =
        getGuildConfig(
            data,
            reviewData.guildId
        );

    if (
        !isApplicationAdmin(
            interaction,
            config
        )
    ) {
        return interaction.reply({
            content:
                "You do not have permission to review applications.",
            ephemeral: true
        });
    }

    const application =
        config.types[
            reviewData.applicationId
        ];

    if (!application) {
        return interaction.reply({
            content:
                "This application type no longer exists.",
            ephemeral: true
        });
    }

    const accepted =
        action ===
        "application_accept";

    const rejected =
        action ===
        "application_reject";

    if (
        !accepted &&
        !rejected
    ) {
        return interaction.reply({
            content:
                "Invalid application action.",
            ephemeral: true
        });
    }

    /*
     * ACCEPT
     */

    if (accepted) {
        let member;

        try {
            member =
                await interaction.guild
                    .members.fetch(
                        reviewData.userId
                    );
        } catch {
            return interaction.reply({
                content:
                    "I couldn't find the applicant in this server.",
                ephemeral: true
            });
        }

        const role =
            interaction.guild.roles.cache.get(
                application.roleId
            );

        if (!role) {
            return interaction.reply({
                content:
                    "The role configured for this application no longer exists.",
                ephemeral: true
            });
        }

        if (
            role.position >=
            interaction.guild.members.me.roles.highest.position
        ) {
            return interaction.reply({
                content:
                    "I cannot assign that role because it is higher than or equal to my highest role.",
                ephemeral: true
            });
        }

        try {
            await member.roles.add(
                role,
                `Accepted ${application.name} application by ${interaction.user.tag}`
            );
        } catch (error) {
            console.error(
                "Failed to assign application role:",
                error
            );

            return interaction.reply({
                content:
                    "I couldn't assign the configured role. Check my Manage Roles permission and role hierarchy.",
                ephemeral: true
            });
        }
    }

    /*
     * DM APPLICANT
     */

    try {
        const user =
            await interaction.client.users.fetch(
                reviewData.userId
            );

        if (accepted) {
            await user.send(
                `Your **${application.name}** application in **${interaction.guild.name}** has been **accepted**.\n\nYou have been given <@&${application.roleId}>.`
            );
        } else {
            await user.send(
                `Your **${application.name}** application in **${interaction.guild.name}** has been **rejected**.`
            );
        }
    } catch {
        /*
         * DMs being closed should not prevent the
         * application from being processed.
         */
    }

    /*
     * Update review message
     */

    const oldEmbed =
        interaction.message.embeds[0];

    const updatedEmbed =
        oldEmbed
            ? EmbedBuilder.from(
                oldEmbed
            )
            : new EmbedBuilder();

    updatedEmbed
        .setColor(
            accepted
                ? 0x57f287
                : 0xed4245
        )
        .setDescription(
            `**Applicant:** <@${reviewData.userId}>\n` +
            `**Application:** ${application.name}\n` +
            `**Status:** ${
                accepted
                    ? "🟢 Accepted"
                    : "🔴 Rejected"
            }\n` +
            `**Reviewed by:** <@${interaction.user.id}>`
        )
        .setTimestamp();

    await interaction.update({
        embeds: [updatedEmbed],
        components: []
    });
}


module.exports = {
    command,
    handleApplicationSelect,
    handleApplicationDM,
    handleApplicationReview
};