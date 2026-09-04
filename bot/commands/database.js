"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const filePath = path.resolve(
    process.env.SUPER_LEAGUE_DB_PATH ||
    path.resolve(__dirname, "..", "users.json")
);

const backupPath = `${filePath}.bak`;
const DB_META = Symbol("databaseMetadata");

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
            activeApplications: {},
            applicationReviews: {},
            offers: {},
            robloxLinks: {}
        }
    };
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function hash(value) {
    return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function attachMetadata(data, raw) {
    Object.defineProperty(data, DB_META, {
        value: { snapshot: clone(data), hash: hash(raw) },
        enumerable: false,
        configurable: true,
        writable: true
    });
    return data;
}

function normalizeData(parsed) {
    const teams = {};

    for (const [roleId, team] of Object.entries(parsed.teams ?? {})) {
        const rawStaff = team.staff ?? {};
        const staff = { ...EMPTY_TEAM_STAFF };

        for (const position of STAFF_POSITIONS) {
            const value = rawStaff[position];
            staff[position] = typeof value === "string" ? value : null;
        }

        teams[roleId] = {
            managerid: typeof team.managerid === "string" ? team.managerid : "",
            staff
        };
    }

    const rawSettings = parsed.settings ?? {};

    const normalizeNumberMap = (value, min, max) => Object.fromEntries(
        Object.entries(value ?? {})
            .filter(([, item]) => typeof item === "number" && Number.isFinite(item))
            .map(([id, item]) => [id, Math.min(max, Math.max(min, Math.floor(item)))])
    );

    const demandUsage = Object.fromEntries(
        Object.entries(rawSettings.demandUsage ?? {}).map(([guildId, usage]) => [
            guildId,
            Object.fromEntries(
                Object.entries(usage ?? {})
                    .filter(([, value]) => typeof value === "number" && Number.isFinite(value))
                    .map(([userId, count]) => [userId, Math.max(0, Math.floor(count))])
            )
        ])
    );

    return {
        teams,
        settings: {
            transactionChannel: typeof rawSettings.transactionChannel === "string" ? rawSettings.transactionChannel : null,
            candidateRoles: rawSettings.candidateRoles ?? {},
            managerRoles: rawSettings.managerRoles ?? {},
            assistantManagerRoles: rawSettings.assistantManagerRoles ?? {},
            playerManagerRoles: rawSettings.playerManagerRoles ?? {},
            logChannels: rawSettings.logChannels ?? {},
            transactionChannels: rawSettings.transactionChannels ?? {},
            owner_id:
                typeof rawSettings.owner_id === "string"
                    ? rawSettings.owner_id
                    : typeof rawSettings.ownerId === "string"
                        ? rawSettings.ownerId
                        : "",
            whitelists: {
                echo: Array.isArray(rawSettings.whitelists?.echo)
                    ? rawSettings.whitelists.echo.filter(id => typeof id === "string")
                    : [],
                league_admin: Array.isArray(rawSettings.whitelists?.league_admin)
                    ? rawSettings.whitelists.league_admin.filter(id => typeof id === "string")
                    : []
            },
            demandLimits: normalizeNumberMap(rawSettings.demandLimits ?? rawSettings.demandCaps ?? {}, 1, 100),
            rosterLimits: normalizeNumberMap(rawSettings.rosterLimits ?? {}, 1, 100),
            demandUsage,
            applications:
                rawSettings.applications && typeof rawSettings.applications === "object"
                    ? rawSettings.applications
                    : {},
            activeApplications:
                rawSettings.activeApplications && typeof rawSettings.activeApplications === "object"
                    ? rawSettings.activeApplications
                    : {},
            applicationReviews:
                rawSettings.applicationReviews && typeof rawSettings.applicationReviews === "object"
                    ? rawSettings.applicationReviews
                    : {},
            offers:
                rawSettings.offers && typeof rawSettings.offers === "object"
                    ? rawSettings.offers
                    : {},
            robloxLinks:
                rawSettings.robloxLinks && typeof rawSettings.robloxLinks === "object"
                    ? rawSettings.robloxLinks
                    : {}
        }
    };
}

function recoverDatabase(raw, source) {
    try {
        return attachMetadata(normalizeData(JSON.parse(raw)), raw);
    } catch (error) {
        console.error(`Failed to parse ${source}:`, error);
        return null;
    }
}

function loadData() {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    if (!fs.existsSync(filePath)) {
        if (fs.existsSync(backupPath)) {
            const recovered = recoverDatabase(fs.readFileSync(backupPath, "utf8"), backupPath);
            if (recovered) {
                saveData(recovered);
                return recovered;
            }
        }

        const data = createEmptyDatabase();
        saveData(data);
        return data;
    }

    const raw = fs.readFileSync(filePath, "utf8");
    if (!raw.trim()) {
        throw new Error(`Database file is empty: ${filePath}`);
    }

    const data = recoverDatabase(raw, filePath);
    if (data) return data;

    if (fs.existsSync(backupPath)) {
        const backup = recoverDatabase(fs.readFileSync(backupPath, "utf8"), backupPath);
        if (backup) {
            console.warn("Recovered database from the last known-good backup.");
            return backup;
        }
    }

    throw new Error(`Database is corrupted and no valid backup exists: ${filePath}`);
}

function deepEqual(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
}

function mergeThreeWay(base, ours, current) {
    if (deepEqual(ours, base)) return current;
    if (deepEqual(current, base)) return ours;

    if (
        ours && current && base &&
        typeof ours === "object" &&
        typeof current === "object" &&
        typeof base === "object" &&
        !Array.isArray(ours) &&
        !Array.isArray(current) &&
        !Array.isArray(base)
    ) {
        const result = { ...current };
        const keys = new Set([
            ...Object.keys(base),
            ...Object.keys(ours),
            ...Object.keys(current)
        ]);

        for (const key of keys) {
            if (!(key in ours)) {
                if (deepEqual(current[key], base[key])) delete result[key];
                continue;
            }

            result[key] = mergeThreeWay(
                base[key],
                ours[key],
                current[key]
            );
        }

        return result;
    }

    return ours;
}

function atomicWrite(raw) {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });

    const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    const fd = fs.openSync(tempPath, "w", 0o600);

    try {
        fs.writeFileSync(fd, raw, "utf8");
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }

    if (fs.existsSync(filePath)) {
        fs.copyFileSync(filePath, backupPath);
    }

    try {
        fs.renameSync(tempPath, filePath);
    } catch (error) {
        try { fs.unlinkSync(tempPath); } catch {}
        throw error;
    }
}

function saveData(data) {
    const meta = data?.[DB_META];
    let dataToWrite = data;

    if (meta && fs.existsSync(filePath)) {
        const currentRaw = fs.readFileSync(filePath, "utf8");
        const current = recoverDatabase(currentRaw, filePath);

        if (current && hash(currentRaw) !== meta.hash) {
            dataToWrite = mergeThreeWay(meta.snapshot, data, current);
        }
    }

    const normalized = normalizeData(dataToWrite);
    const raw = JSON.stringify(normalized, null, 4);
    atomicWrite(raw);

    if (data && typeof data === "object") {
        for (const key of Object.keys(data)) delete data[key];
        Object.assign(data, normalized);
        attachMetadata(data, raw);
    }
}

function getLogChannelId(data, guildId) {
    return data.settings.logChannels[guildId] ?? null;
}

function getTransactionChannelId(data, guildId) {
    return data.settings.transactionChannels[guildId] ?? data.settings.transactionChannel;
}

function getDemandLimit(data, guildId) {
    return data.settings.demandLimits[guildId] ?? 1;
}

function getRosterLimit(data, guildId) {
    return data.settings.rosterLimits[guildId] ?? 20;
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
