"use strict";

const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    EmbedBuilder
} = require("discord.js");

function targetMember(interaction) {
    return interaction.options.getMember("user");
}

function canModerate(interaction, member) {
    if (!member) return "That user is not in this server.";
    if (member.id === interaction.user.id) return "You cannot moderate yourself.";
    if (member.id === interaction.client.user.id) return "You cannot moderate the bot.";
    if (!member.moderatable) return "I cannot moderate that user. Check my role hierarchy and permissions.";
    if (interaction.guild.ownerId !== interaction.user.id && member.roles.highest.position >= interaction.member.roles.highest.position) {
        return "You cannot moderate a member with an equal or higher role than yours.";
    }
    return null;
}

function reason(interaction) {
    return interaction.options.getString("reason") || "No reason provided.";
}

function response(interaction, title, description) {
    return interaction.reply({
        embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(title).setDescription(description)]
    });
}

const command = {
    data: new SlashCommandBuilder()
        .setName("mod")
        .setDescription("Moderation tools.")
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
        .addSubcommand(sub => sub
            .setName("timeout")
            .setDescription("Timeout a member.")
            .addUserOption(o => o.setName("user").setDescription("Member to timeout.").setRequired(true))
            .addIntegerOption(o => o.setName("duration").setDescription("Duration in minutes (1-40320).").setRequired(true).setMinValue(1).setMaxValue(40320))
            .addStringOption(o => o.setName("reason").setDescription("Reason.").setMaxLength(512)))
        .addSubcommand(sub => sub
            .setName("untimeout")
            .setDescription("Remove a member's timeout.")
            .addUserOption(o => o.setName("user").setDescription("Member to untimeout.").setRequired(true))
            .addStringOption(o => o.setName("reason").setDescription("Reason.").setMaxLength(512)))
        .addSubcommand(sub => sub
            .setName("mute")
            .setDescription("Mute a member using Discord's native timeout system.")
            .addUserOption(o => o.setName("user").setDescription("Member to mute.").setRequired(true))
            .addIntegerOption(o => o.setName("duration").setDescription("Duration in minutes (1-40320).").setRequired(true).setMinValue(1).setMaxValue(40320))
            .addStringOption(o => o.setName("reason").setDescription("Reason.").setMaxLength(512)))
        .addSubcommand(sub => sub
            .setName("unmute")
            .setDescription("Remove a member's mute.")
            .addUserOption(o => o.setName("user").setDescription("Member to unmute.").setRequired(true))
            .addStringOption(o => o.setName("reason").setDescription("Reason.").setMaxLength(512)))
        .addSubcommand(sub => sub
            .setName("ban")
            .setDescription("Ban a member.")
            .addUserOption(o => o.setName("user").setDescription("Member to ban.").setRequired(true))
            .addIntegerOption(o => o.setName("delete_days").setDescription("Days of message history to delete (0-7).").setMinValue(0).setMaxValue(7))
            .addStringOption(o => o.setName("reason").setDescription("Reason.").setMaxLength(512)))
        .addSubcommand(sub => sub
            .setName("unban")
            .setDescription("Unban a user.")
            .addStringOption(o => o.setName("user_id").setDescription("User ID.").setRequired(true).setMaxLength(30))
            .addStringOption(o => o.setName("reason").setDescription("Reason.").setMaxLength(512))),

    async execute(interaction) {
        if (!interaction.guild) return interaction.reply({ content: "This command can only be used in a server.", ephemeral: true });

        const sub = interaction.options.getSubcommand();
        const member = targetMember(interaction);

        if (sub === "unban") {
            if (!interaction.memberPermissions.has(PermissionFlagsBits.BanMembers)) {
                return interaction.reply({ content: "You need the Ban Members permission.", ephemeral: true });
            }
            const userId = interaction.options.getString("user_id", true).trim();
            if (!/^\d{17,20}$/.test(userId)) return interaction.reply({ content: "That is not a valid Discord user ID.", ephemeral: true });
            try {
                await interaction.guild.members.unban(userId, reason(interaction));
                return response(interaction, "User Unbanned", `<@${userId}> has been unbanned.`);
            } catch (error) {
                return interaction.reply({ content: "I could not unban that user. They may not be banned, or I may lack Ban Members permission.", ephemeral: true });
            }
        }

        if (sub === "ban" && !interaction.memberPermissions.has(PermissionFlagsBits.BanMembers)) {
            return interaction.reply({ content: "You need the Ban Members permission.", ephemeral: true });
        }
        if (["timeout", "untimeout", "mute", "unmute"].includes(sub) && !interaction.memberPermissions.has(PermissionFlagsBits.ModerateMembers)) {
            return interaction.reply({ content: "You need the Moderate Members permission.", ephemeral: true });
        }

        const hierarchyError = canModerate(interaction, member);
        if (hierarchyError) return interaction.reply({ content: hierarchyError, ephemeral: true });

        try {
            if (sub === "ban") {
                const days = interaction.options.getInteger("delete_days") ?? 0;
                await member.ban({ deleteMessageSeconds: days * 86400, reason: reason(interaction) });
                return response(interaction, "Member Banned", `<@${member.id}> has been banned.\n\n**Reason:** ${reason(interaction)}`);
            }

            if (["timeout", "mute"].includes(sub)) {
                const duration = interaction.options.getInteger("duration", true);
                await member.timeout(duration * 60 * 1000, reason(interaction));
                return response(interaction, sub === "mute" ? "Member Muted" : "Member Timed Out", `<@${member.id}> has been ${sub === "mute" ? "muted" : "timed out"} for **${duration} minute(s)**.\n\n**Reason:** ${reason(interaction)}`);
            }

            if (["untimeout", "unmute"].includes(sub)) {
                await member.timeout(null, reason(interaction));
                return response(interaction, sub === "unmute" ? "Member Unmuted" : "Timeout Removed", `<@${member.id}> is no longer timed out.`);
            }
        } catch (error) {
            console.error("Moderation error:", error);
            return interaction.reply({ content: "I could not complete that moderation action. Check my permissions and role hierarchy.", ephemeral: true });
        }
    }
};

module.exports = { command };
