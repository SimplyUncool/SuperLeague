"use strict";

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const configuredPath = process.env.SUPER_LEAGUE_DB_PATH;
const dbPath = path.resolve(configuredPath || path.join(__dirname, "superleague.db"));
process.env.SUPER_LEAGUE_DB_PATH = dbPath;

const dataDir = path.dirname(dbPath);
const managedNames = new Set([
    "users.json",
    "users.json.bak",
    "levels.json",
    "invites.json",
    "tickets.json",
    "security.json"
]);

fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = FULL");
db.pragma("foreign_keys = ON");
db.exec(`
    CREATE TABLE IF NOT EXISTS file_store (
        name TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        updated_at INTEGER NOT NULL
    )
`);

const readStatement = db.prepare("SELECT content FROM file_store WHERE name = ?");
const writeStatement = db.prepare(`
    INSERT INTO file_store (name, content, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
        content = excluded.content,
        updated_at = excluded.updated_at
`);
const deleteStatement = db.prepare("DELETE FROM file_store WHERE name = ?");
const hasStatement = db.prepare("SELECT 1 FROM file_store WHERE name = ? LIMIT 1");
const migrateFiles = db.transaction(files => {
    for (const name of files) {
        if (hasStatement.get(name)) continue;
        const physicalPath = path.join(dataDir, name);
        if (!fs.existsSync(physicalPath)) continue;
        const content = fs.readFileSync(physicalPath, "utf8");
        writeStatement.run(name, content, Date.now());
    }
});

migrateFiles(managedNames);

function logicalName(filePath) {
    const resolved = path.resolve(filePath);
    if (resolved === dbPath) return null;
    const relative = path.relative(dataDir, resolved);
    if (relative.includes(path.sep)) return null;
    if (managedNames.has(relative)) return relative;
    for (const name of managedNames) {
        if (relative.startsWith(`${name}.tmp-`)) return name;
    }
    return null;
}

function isManaged(filePath) {
    return typeof filePath === "string" && logicalName(filePath) !== null;
}

const originalExistsSync = fs.existsSync.bind(fs);
const originalReadFileSync = fs.readFileSync.bind(fs);
const originalWriteFileSync = fs.writeFileSync.bind(fs);
const originalRenameSync = fs.renameSync.bind(fs);
const originalCopyFileSync = fs.copyFileSync.bind(fs);
const originalUnlinkSync = fs.unlinkSync.bind(fs);

const temporaryContents = new Map();
const atomicWrite = db.transaction((name, content) => writeStatement.run(name, String(content), Date.now()));
const atomicDelete = db.transaction(name => deleteStatement.run(name));

fs.existsSync = filePath => {
    if (!isManaged(filePath)) return originalExistsSync(filePath);
    return Boolean(hasStatement.get(logicalName(filePath)));
};

fs.readFileSync = (filePath, options) => {
    if (!isManaged(filePath)) return originalReadFileSync(filePath, options);
    const name = logicalName(filePath);
    if (temporaryContents.has(path.resolve(filePath))) {
        const content = temporaryContents.get(path.resolve(filePath));
        return options && (options === "buffer" || options.encoding === null) ? Buffer.from(content) : content;
    }
    const row = readStatement.get(name);
    if (!row) {
        const error = new Error(`ENOENT: no such file or directory, open '${filePath}'`);
        error.code = "ENOENT";
        error.path = filePath;
        throw error;
    }
    return options && (options === "buffer" || options.encoding === null) ? Buffer.from(row.content) : row.content;
};

fs.writeFileSync = (filePath, data, options) => {
    if (typeof filePath !== "string" || (!isManaged(filePath) && !logicalName(filePath))) {
        return originalWriteFileSync(filePath, data, options);
    }
    const resolved = path.resolve(filePath);
    const name = logicalName(filePath);
    const content = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
    if (managedNames.has(name) && resolved.endsWith(name)) {
        atomicWrite(name, content);
        return;
    }
    temporaryContents.set(resolved, content);
};

fs.renameSync = (oldPath, newPath) => {
    const targetName = typeof newPath === "string" ? logicalName(newPath) : null;
    if (!targetName) return originalRenameSync(oldPath, newPath);
    const oldResolved = path.resolve(oldPath);
    let content;
    if (temporaryContents.has(oldResolved)) {
        content = temporaryContents.get(oldResolved);
        temporaryContents.delete(oldResolved);
    } else {
        content = originalReadFileSync(oldPath, "utf8");
        originalUnlinkSync(oldPath);
    }
    atomicWrite(targetName, content);
};

fs.copyFileSync = (source, destination, mode) => {
    const sourceName = typeof source === "string" ? logicalName(source) : null;
    const destinationName = typeof destination === "string" ? logicalName(destination) : null;
    if (!sourceName && !destinationName) return originalCopyFileSync(source, destination, mode);
    let content;
    if (sourceName) {
        const row = readStatement.get(sourceName);
        if (!row) {
            const error = new Error(`ENOENT: no such file or directory, copyfile '${source}'`);
            error.code = "ENOENT";
            throw error;
        }
        content = row.content;
    } else {
        content = originalReadFileSync(source, "utf8");
    }
    if (destinationName) atomicWrite(destinationName, content);
    else originalWriteFileSync(destination, content, { encoding: "utf8" });
};

fs.unlinkSync = filePath => {
    if (!isManaged(filePath)) return originalUnlinkSync(filePath);
    const resolved = path.resolve(filePath);
    if (temporaryContents.delete(resolved)) return;
    const name = logicalName(filePath);
    if (hasStatement.get(name)) atomicDelete(name);
    else {
        const error = new Error(`ENOENT: no such file or directory, unlink '${filePath}'`);
        error.code = "ENOENT";
        throw error;
    }
};

process.on("exit", () => {
    try { db.close(); } catch {}
});

module.exports = { dbPath };
