"use strict";

const fs = require("fs");
const path = require("path");

const filePath = path.resolve(__dirname, "..", "users.json");

const STAFF_POSITIONS = [
    "assistant_manager",
    "player_manager"
];

const EMPTY_TEAM_STAFF = {
    assistant_manager: null,
    player_manager: null
};

function createEmptyDatabase() {
    return {
        teams: {},
        settings: {
            transactionChannel: null,
            candidateRoles: {},
            managerRoles: {},
            assistantManagerRoles: {},
            playerManagerRoles: {},
            logChannels: {},
            transactionChannels: {},
            owner_id: "",

            whitelists: {
                echo: [],
                league_admin: []
            },

            demandLimits: {},
            rosterLimits: {},
            demandUsage: {},

            applications: {},
            activeApplications: {}
        }
    };
}

function loadData() {
    if (!fs.existsSync(filePath)) {
        const data = createEmptyDatabase();
        saveData(data);
        return data;
    }

    const file = fs.readFileSync(filePath, "utf8");

    if (!file.trim()) {
        const data = createEmptyDatabase();
        saveData(data);
        return data;
    }

    try {
        return normalizeData(JSON.parse(file));
    } catch (error) {
        console.error("Failed to parse users.json:", error);

        const data = createEmptyDatabase();
        saveData(data);

        return data;
    }
}

function normalizeData(parsed) {
    const teams = {};

    for (const [roleId, team] of Object.entries(parsed.teams ?? {})) {
        const rawStaff = team.staff ?? {};

        const staff = {
            ...EMPTY_TEAM_STAFF
        };

        for (const position of STAFF_POSITIONS) {
            const value = rawStaff[position];

            staff[position] =
                typeof value === "string"
                    ? value
                    : null;
        }

        teams[roleId] = {
            managerid:
                typeof team.managerid === "string"
                    ? team.managerid
                    : "",

            staff
        };
    }

    const rawSettings = parsed.settings ?? {};

    const demandLimits = Object.fromEntries(
        Object.entries(
            rawSettings.demandLimits ??
            rawSettings.demandCaps ??
            {}
        )
            .filter(
                ([, value]) =>
                    typeof value === "number" &&
                    Number.isFinite(value)
            )
            .map(([guildId, limit]) => [
                guildId,
                Math.min(
                    100,
                    Math.max(1, Math.floor(limit))
                )
            ])
    );

    const rosterLimits = Object.fromEntries(
        Object.entries(
            rawSettings.rosterLimits ?? {}
        )
            .filter(
                ([, value]) =>
                    typeof value === "number" &&
                    Number.isFinite(value)
            )
            .map(([guildId, limit]) => [
                guildId,
                Math.min(
                    100,
                    Math.max(1, Math.floor(limit))
                )
            ])
    );

    const demandUsage = Object.fromEntries(
        Object.entries(
            rawSettings.demandUsage ?? {}
        ).map(([guildId, usage]) => [
            guildId,

            Object.fromEntries(
                Object.entries(usage ?? {})
                    .filter(
                        ([, value]) =>
                            typeof value === "number" &&
                            Number.isFinite(value)
                    )
                    .map(([userId, count]) => [
                        userId,
                        Math.max(
                            0,
                            Math.floor(count)
                        )
                    ])
            )
        ])
    );

    return {
        teams,

        settings: {
            transactionChannel:
                typeof rawSettings.transactionChannel === "string"
                    ? rawSettings.transactionChannel
                    : null,

            candidateRoles:
                rawSettings.candidateRoles ?? {},

            managerRoles:
                rawSettings.managerRoles ?? {},

            assistantManagerRoles:
                rawSettings.assistantManagerRoles ?? {},

            playerManagerRoles:
                rawSettings.playerManagerRoles ?? {},

            logChannels:
                rawSettings.logChannels ?? {},

            transactionChannels:
                rawSettings.transactionChannels ?? {},

            owner_id:
                typeof rawSettings.owner_id === "string"
                    ? rawSettings.owner_id
                    : typeof rawSettings.ownerId === "string"
                        ? rawSettings.ownerId
                        : "",

            whitelists: {
                echo:
                    Array.isArray(
                        rawSettings.whitelists?.echo
                    )
                        ? rawSettings.whitelists.echo.filter(
                            id => typeof id === "string"
                        )
                        : [],

                league_admin:
                    Array.isArray(
                        rawSettings.whitelists?.league_admin
                    )
                        ? rawSettings.whitelists.league_admin.filter(
                            id => typeof id === "string"
                        )
                        : []
            },

            demandLimits,

            rosterLimits,

            demandUsage,

            /*
             * APPLICATION SYSTEM
             */

            applications:
                rawSettings.applications &&
                typeof rawSettings.applications === "object"
                    ? rawSettings.applications
                    : {},

            activeApplications:
                rawSettings.activeApplications &&
                typeof rawSettings.activeApplications === "object"
                    ? rawSettings.activeApplications
                    : {}
        }
    };
}

function getLogChannelId(data, guildId) {
    return data.settings.logChannels[guildId] ?? null;
}

function getTransactionChannelId(data, guildId) {
    return (
        data.settings.transactionChannels[guildId] ??
        data.settings.transactionChannel
    );
}

function getDemandLimit(data, guildId) {
    return data.settings.demandLimits[guildId] ?? 1;
}

function getRosterLimit(data, guildId) {
    return data.settings.rosterLimits[guildId] ?? 20;
}

function saveData(data) {
    const dir = path.dirname(filePath);

    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, {
            recursive: true
        });
    }

    fs.writeFileSync(
        filePath,
        JSON.stringify(data, null, 4),
        "utf8"
    );
}

module.exports = {
    STAFF_POSITIONS,
    EMPTY_TEAM_STAFF,
    loadData,
    normalizeData,
    getLogChannelId,
    getTransactionChannelId,
    getDemandLimit,
    getRosterLimit,
    saveData
};