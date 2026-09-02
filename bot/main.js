"use strict";

require("dotenv").config();

const { Client, Collection, GatewayIntentBits, Partials, REST, Routes } = require("discord.js");

const offer = require("./commands/offer.js");
const roster = require("./commands/roster.js");
const teamcreate = require("./commands/teamcreate.js");
const teamdisband = require("./commands/teamdisband.js");
const teamlist = require("./commands/teamlist.js");
const overroster = require("./commands/overroster.js");
const managerswap = require("./commands/managerswap.js");
const logchannel = require("./commands/logchannel.js");
const transactionchannel = require("./commands/transactionchannel.js");
const release = require("./commands/release.js");
const applications = require("./commands/applications.js");
const tickets = require("./commands/tickets.js");
const moderation = require("./commands/moderation.js");
const threadlock = require("./commands/threadlock.js");
const teamstaff = require("./commands/teamstaff.js");
const teamswap = require("./commands/teamswap.js");
const managerrole = require("./commands/managerrole.js");
const assistantmanagerrole = require("./commands/assistantmanagerrole.js");
const playermanagerrole = require("./commands/playermanagerrole.js");
const access = require("./commands/access.js");
const limits = require("./commands/limits.js");
const demand = require("./commands/demand.js");
const { createErrorEmbed } = require("./commands/embeds.js");
const { loadData } = require("./commands/database.js");
const { sendStaffCommandLog } = require("./commands/stafflog.js");

const token = process.env.DISCORD_TOKEN;
if (!token) throw new Error("DISCORD_TOKEN is required. Set it in your .env file.");

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent],
    partials: [Partials.Channel]
});

const commands = new Collection();
const commandList = [
    offer.command,
    release.command,
    teamswap.command,
    roster.command,
    teamcreate.command,
    teamdisband.command,
    teamlist.command,
    overroster.command,
    managerswap.command,
    logchannel.command,
    transactionchannel.command,
    managerrole.command,
    assistantmanagerrole.command,
    playermanagerrole.command,
    teamstaff.setCandidateRoleCommand,
    teamstaff.fofillCommand,
    teamstaff.promoteCommand,
    teamstaff.demoteCommand,
    access.whitelistCommand,
    access.echoCommand,
    limits.rosterLimitCommand,
    demand.command,
    demand.demandLimitCommand,
    demand.demandResetCommand,
    applications.command,
    tickets.command,
    moderation.command,
    threadlock.command
];

for (const command of commandList) commands.set(command.data.name, command);

function isUnknownInteraction(error) {
    return error?.code === 10062 || error?.rawError?.code === 10062;
}

async function safeInteractionError(interaction, message) {
    if (interaction.replied || isUnknownInteraction(message)) return;
    const embed = createErrorEmbed(typeof message === "string" ? message : "Something went wrong while running that command.", interaction.guild);
    try {
        if (interaction.deferred) await interaction.editReply({ embeds: [embed] });
        else await interaction.reply({ embeds: [embed], ephemeral: true });
    } catch (error) {
        if (!isUnknownInteraction(error)) console.error(error);
    }
}

client.on("interactionCreate", async interaction => {
    if (interaction.isAutocomplete()) {
        const command = commands.get(interaction.commandName);
        if (!command?.autocomplete) return;
        try { await command.autocomplete(interaction); }
        catch (error) { if (!isUnknownInteraction(error)) console.error("Autocomplete error:", error); }
        return;
    }

    if (interaction.isChatInputCommand()) {
        const command = commands.get(interaction.commandName);
        if (!command) return;
        try { await command.execute(interaction); }
        catch (error) {
            if (!isUnknownInteraction(error)) console.error(error);
            await safeInteractionError(interaction, "Something went wrong while running that command.");
        }
        finally {
            try { await sendStaffCommandLog(interaction); }
            catch (error) { if (!isUnknownInteraction(error)) console.error(error); }
        }
        return;
    }

    if (interaction.isStringSelectMenu()) {
        try {
            if (interaction.customId === "application_select") {
                await applications.handleApplicationSelect(interaction);
                return;
            }
        } catch (error) {
            if (!isUnknownInteraction(error)) console.error(error);
            await safeInteractionError(interaction, "Something went wrong while starting the application.");
        }
        return;
    }

    if (interaction.isButton()) {
        try {
            if (interaction.customId === "ticket_create" || interaction.customId === "ticket_close") {
                await tickets.handleButton(interaction);
                return;
            }
            if (interaction.customId.startsWith("application_accept:") || interaction.customId.startsWith("application_reject:")) {
                await applications.handleApplicationReview(interaction);
                return;
            }
            if (interaction.customId.startsWith("offer_accept:")) {
                await offer.handleAcceptButton(interaction);
                return;
            }
            if (interaction.customId.startsWith("offer_decline:")) {
                await offer.handleDeclineButton(interaction);
                return;
            }
        } catch (error) {
            if (!isUnknownInteraction(error)) console.error(error);
            await safeInteractionError(interaction, "Something went wrong while handling that interaction.");
        }
        return;
    }

    if (interaction.isModalSubmit()) {
        try {
            if (interaction.customId.startsWith("offer_confirm:")) {
                await offer.handleOfferModal(interaction);
                return;
            }
        } catch (error) {
            if (!isUnknownInteraction(error)) console.error(error);
            await safeInteractionError(interaction, "Something went wrong while confirming that offer.");
        }
    }
});

client.on("messageCreate", async message => {
    try { await applications.handleApplicationDM(message); }
    catch (error) { console.error("Application DM error:", error); }
});

client.on("guildMemberUpdate", async (_oldMember, newMember) => {
    const database = loadData();
    if (managerrole.isManagerInGuild(database, newMember.guild, newMember.id)) {
        await managerrole.syncManagerMemberRoles(newMember, database, "Restoring required manager and team roles").catch(console.error);
    }
    if (assistantmanagerrole.isAssistantManagerInGuild(database, newMember.guild, newMember.id)) {
        await assistantmanagerrole.syncAssistantManagerMemberRoles(newMember, database, "Restoring required assistant manager and team roles").catch(console.error);
    }
    if (playermanagerrole.isPlayerManagerInGuild(database, newMember.guild, newMember.id)) {
        await playermanagerrole.syncPlayerManagerMemberRoles(newMember, database, "Restoring required player manager and team roles").catch(console.error);
    }
});

client.once("clientReady", async readyClient => {
    console.log(`${readyClient.user.tag} is online`);
    await managerrole.syncAllManagerRoles(readyClient);
    await assistantmanagerrole.syncAllAssistantManagerRoles(readyClient);
    await playermanagerrole.syncAllPlayerManagerRoles(readyClient);

    const rest = new REST({ version: "10" }).setToken(token);
    try {
        console.log("Refreshing slash commands...");
        const guildIds = [...readyClient.guilds.cache.keys()];
        for (let i = 0; i < guildIds.length; i++) {
            await rest.put(Routes.applicationGuildCommands(readyClient.user.id, guildIds[i]), { body: [] });
            if (i < guildIds.length - 1) await new Promise(resolve => setTimeout(resolve, 350));
        }
        await rest.put(Routes.applicationCommands(readyClient.user.id), { body: commands.map(command => command.data.toJSON()) });
        console.log("Commands refreshed and loaded!");
    } catch (error) {
        console.error("Failed to refresh commands:", error);
    }
});

client.login(token);
