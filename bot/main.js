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
const release = require("./commands/release.js");
const applications = require("./commands/applications.js");
const demand = require("./commands/demand.js");
const tickets = require("./commands/tickets.js");
const ticketclose = require("./commands/ticketclose.js");
const moderation = require("./commands/moderation.js");
const threadlock = require("./commands/threadlock.js");
const teamstaff = require("./commands/teamstaff.js");
const access = require("./commands/access.js");
const limits = require("./commands/limits.js");
const logchannel = require("./commands/logchannel.js");
const transactionchannel = require("./commands/transactionchannel.js");
const managerrole = require("./commands/managerrole.js");
const assistantmanagerrole = require("./commands/assistantmanagerrole.js");
const playermanagerrole = require("./commands/playermanagerrole.js");
const teamswap = require("./commands/teamswap.js");
const configPages = require("./commands/config.js");
const config = require("./configHub.js");
const lockdown = require("./commands/lockdown.js");
const robloxverify = require("./commands/robloxverify.js");
const invites = require("./commands/invites.js");
const inviteTracker = require("./inviteTracker.js");
const inviteConfig = require("./inviteConfig.js");
const afk = require("./afk.js");
const afkCommand = require("./commands/afk.js");
const levels = require("./levels.js");
const { createErrorEmbed } = require("./commands/embeds.js");
const { loadData } = require("./commands/database.js");
const { sendStaffCommandLog } = require("./commands/stafflog.js");
const { initializeSecurity } = require("./security.js");
const token = process.env.DISCORD_TOKEN;
if (!token) throw new Error("DISCORD_TOKEN is required. Set it in your .env file.");
const PUBLIC_COMMANDS = new Set(["release", "teamswap", "roster", "teamcreate", "teamdisband", "teamlist", "overroster", "managerswap", "fofill", "promote", "demote", "demand", "threadlock", "levels"]);
function makePublicInteraction(interaction) { if (!PUBLIC_COMMANDS.has(interaction.commandName)) return interaction; const originalReply = interaction.reply.bind(interaction), originalDeferReply = interaction.deferReply.bind(interaction); interaction.reply = options => originalReply(options && typeof options === "object" && !Array.isArray(options) ? { ...options, ephemeral: false } : options); interaction.deferReply = options => originalDeferReply(options && typeof options === "object" && !Array.isArray(options) ? { ...options, ephemeral: false } : options); return interaction; }
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent], partials: [Partials.Channel] });
initializeSecurity(client);
const commands = new Collection();
const commandList = [offer.command, release.command, teamswap.command, roster.command, teamcreate.command, teamdisband.command, teamlist.command, overroster.command, managerswap.command, teamstaff.setCandidateRoleCommand, teamstaff.fofillCommand, teamstaff.promoteCommand, teamstaff.demoteCommand, managerrole.command, assistantmanagerrole.command, playermanagerrole.command, demand.command, demand.demandLimitCommand, demand.demandResetCommand, limits.rosterLimitCommand, logchannel.command, transactionchannel.command, tickets.command, access.whitelistCommand, access.echoCommand, applications.command, moderation.command, threadlock.command, config.command, lockdown.command, robloxverify.command, ticketclose.command, invites.command, afkCommand.command, levels.command];
for (const command of commandList) commands.set(command.data.name, command);
const commandData = commands.map(command => command.data.toJSON());
const rest = new REST({ version: "10" }).setToken(token);
async function registerGuildCommands(guildId) { await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), { body: commandData }); }
function isUnknownInteraction(error) { return error?.code === 10062 || error?.rawError?.code === 10062; }
async function safeInteractionError(interaction, message) { if (interaction.replied || isUnknownInteraction(message)) return; const embed = createErrorEmbed(typeof message === "string" ? message : "Something went wrong while running that command.", interaction.guild); try { if (interaction.deferred) await interaction.editReply({ embeds: [embed] }); else await interaction.reply({ embeds: [embed], ephemeral: true }); } catch (error) { if (!isUnknownInteraction(error)) console.error(error); } }
client.on("interactionCreate", async interaction => {
  if (interaction.isAutocomplete()) { const command = commands.get(interaction.commandName); if (!command?.autocomplete) return; try { await command.autocomplete(interaction); } catch (error) { if (!isUnknownInteraction(error)) console.error("Autocomplete error:", error); } return; }
  if (interaction.isChatInputCommand()) { const command = commands.get(interaction.commandName); if (!command) return; try { await command.execute(makePublicInteraction(interaction)); } catch (error) { if (!isUnknownInteraction(error)) console.error(error); await safeInteractionError(interaction, "Something went wrong while running that command."); } finally { try { await sendStaffCommandLog(interaction); } catch (error) { if (!isUnknownInteraction(error)) console.error(error); } } return; }
  if (interaction.isButton() || interaction.isStringSelectMenu() || interaction.isRoleSelectMenu?.() || interaction.isChannelSelectMenu?.() || interaction.isUserSelectMenu?.() || interaction.isModalSubmit()) {
    if (interaction.customId?.startsWith("hub_")) { try { if (await config.handleInteraction(interaction)) return; } catch (error) { if (!isUnknownInteraction(error)) console.error("Unified config interaction error:", error); await safeInteractionError(interaction, "Something went wrong while opening configuration."); } return; }
    if (interaction.customId?.startsWith("cfg_")) { try { if (await inviteConfig.handleInteraction(interaction)) return; await configPages.handleInteraction(interaction); } catch (error) { if (!isUnknownInteraction(error)) console.error("Config interaction error:", error); await safeInteractionError(interaction, "Something went wrong while updating the configuration."); } return; }
    if (interaction.customId?.startsWith("lvlcfg_")) { try { await levels.handleInteraction(interaction); } catch (error) { if (!isUnknownInteraction(error)) console.error("Levels configuration error:", error); await safeInteractionError(interaction, "Something went wrong while updating the level configuration."); } return; }
    if (interaction.customId?.startsWith("appcfg_")) { try { await applications.handleInteraction(interaction); } catch (error) { if (!isUnknownInteraction(error)) console.error("Application config interaction error:", error); await safeInteractionError(interaction, "Something went wrong while updating applications."); } return; }
    if (interaction.customId?.startsWith("application_")) { try { if (interaction.customId === "application_select") await applications.handleApplicationSelect(interaction); else if (interaction.customId.startsWith("application_accept:") || interaction.customId.startsWith("application_reject:")) await applications.handleApplicationReview(interaction); else await applications.handleApplicantInteraction(interaction); } catch (error) { if (!isUnknownInteraction(error)) console.error(error); await safeInteractionError(interaction, "Something went wrong while handling that application."); } return; }
  }
  if (interaction.isButton()) { try { if (interaction.customId === "ticket_close") { await ticketclose.handleButton(interaction); return; } if (interaction.customId === "ticket_create") { await tickets.handleButton(interaction); return; } if (interaction.customId === "roblox_verify") { await robloxverify.handleButton(interaction); return; } if (interaction.customId.startsWith("offer_accept:")) { await offer.handleAcceptButton(interaction); return; } if (interaction.customId.startsWith("offer_decline:")) { await offer.handleDeclineButton(interaction); return; } } catch (error) { if (!isUnknownInteraction(error)) console.error(error); await safeInteractionError(interaction, "Something went wrong while handling that interaction."); } return; }
  if (interaction.isModalSubmit()) { try { if (interaction.customId.startsWith("offer_confirm:")) { await offer.handleOfferModal(interaction); return; } } catch (error) { if (!isUnknownInteraction(error)) console.error(error); await safeInteractionError(interaction, "Something went wrong while handling that interaction."); } }
});
client.on("messageCreate", async message => { try { await applications.handleApplicationDM(message); } catch (error) { console.error("Application DM error:", error); } try { await afk.handleMessage(message); } catch (error) { console.error("AFK handler error:", error); } try { await levels.handleMessage(message); } catch (error) { console.error("Levels handler error:", error); } });
client.on("guildMemberAdd", async member => { try { await inviteTracker.handleMemberAdd(member); } catch (error) { console.error("Invite tracking join error:", error); } });
client.on("guildMemberRemove", async member => { try { await inviteTracker.handleMemberRemove(member); } catch (error) { console.error("Invite tracking leave error:", error); } });
client.on("guildCreate", async guild => { try { await registerGuildCommands(guild.id); } catch (error) { console.error(`Guild command registration failed for ${guild.name}:`, error); } try { await inviteTracker.refreshGuild(guild); } catch (error) { console.error(`Invite tracking initialization error for ${guild.name}:`, error); } });
client.on("guildMemberUpdate", async (_oldMember, newMember) => { try { const database = loadData(); if (managerrole.isManagerInGuild(database, newMember.guild, newMember.id)) await managerrole.syncManagerMemberRoles(newMember, database, "Restoring required manager and team roles").catch(console.error); if (assistantmanagerrole.isAssistantManagerInGuild(database, newMember.guild, newMember.id)) await assistantmanagerrole.syncAssistantManagerMemberRoles(newMember, database, "Restoring required assistant manager and team roles").catch(console.error); if (playermanagerrole.isPlayerManagerInGuild(database, newMember.guild, newMember.id)) await playermanagerrole.syncPlayerManagerMemberRoles(newMember, database, "Restoring required player manager and team roles").catch(console.error); } catch (error) { console.error("Guild member role sync error:", error); } });
client.once("clientReady", async readyClient => { console.log(`${readyClient.user.tag} is online`); readyClient.user.setPresence({ activities: [{ name: "Watching over the Super League.", type: 3 }], status: "online" }); try { await managerrole.syncAllManagerRoles(readyClient); } catch (error) { console.error("Manager role startup sync failed:", error); } try { await assistantmanagerrole.syncAllAssistantManagerRoles(readyClient); } catch (error) { console.error("Assistant manager role startup sync failed:", error); } try { await playermanagerrole.syncAllPlayerManagerRoles(readyClient); } catch (error) { console.error("Player manager role startup sync failed:", error); } try { await inviteTracker.initialize(readyClient); } catch (error) { console.error("Invite tracking startup failed:", error); } if (process.env.ROBLOX_CLIENT_ID && process.env.ROBLOX_CLIENT_SECRET && process.env.ROBLOX_REDIRECT_URI && process.env.ROBLOX_GUILD_ID && process.env.ROBLOX_VERIFIED_ROLE_ID) { try { robloxverify.startWebServer(readyClient); } catch (error) { console.error("Roblox verification startup failed:", error); } } else console.warn("Roblox verification is disabled: missing one or more ROBLOX_* environment variables."); try { console.log("Refreshing slash commands..."); await rest.put(Routes.applicationCommands(readyClient.user.id), { body: [] }); const guildIds = [...readyClient.guilds.cache.keys()]; for (let i = 0; i < guildIds.length; i++) { await registerGuildCommands(guildIds[i]); if (i < guildIds.length - 1) await new Promise(resolve => setTimeout(resolve, 350)); } console.log(`Commands refreshed and loaded in ${guildIds.length} guild${guildIds.length === 1 ? "" : "s"}!`); } catch (error) { console.error("Failed to refresh slash commands:", error); } });
client.on("error", error => console.error("Discord client error:", error));
client.on("warn", warning => console.warn("Discord client warning:", warning));
client.on("shardError", error => console.error("Discord shard error:", error));
client.login(token);