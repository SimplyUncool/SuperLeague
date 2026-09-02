"use strict";

const fs = require("fs");
const Module = require("module");
const path = require("path");

// Keep the existing application implementation intact while correcting the
// escaped inline-code backticks before Node compiles it.
const legacyPath = path.join(__dirname, "applications_legacy.js");
let source = fs.readFileSync(legacyPath, "utf8");
source = source.replace(
    "Use `/applications question add` to add questions.",
    "Use \\`/applications question add\\` to add questions."
);

const legacyModule = new Module(legacyPath, module.parent);
legacyModule.filename = legacyPath;
legacyModule.paths = Module._nodeModulePaths(__dirname);
legacyModule._compile(source, legacyPath);

module.exports = legacyModule.exports;
