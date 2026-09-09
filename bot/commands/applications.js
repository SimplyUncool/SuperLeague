"use strict";

const fs = require("fs");
const Module = require("module");
const path = require("path");

const corePath = path.resolve(__dirname, "../internal/applications_core.js");
let source = fs.readFileSync(corePath, "utf8");
source = source.replace(
  'if (!q.required) rows.push(skipRow()); rows.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("application_cancel").setLabel("Cancel").setStyle(ButtonStyle.Danger));',
  'if (!q.required) rows.push(skipRow()); rows.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("application_cancel").setLabel("Cancel").setStyle(ButtonStyle.Danger)));'
);

const coreModule = new Module(corePath, module);
coreModule.filename = corePath;
coreModule.paths = Module._nodeModulePaths(path.dirname(corePath));
coreModule._compile(source, corePath);
const core = coreModule.exports;

// The application form question editor is intentionally kept in the interactive
// application-management UI. It is not exposed as /applications question/*.
if (core.command?.data?.options) {
  core.command.data.options = core.command.data.options.filter(option => option.name !== "question");
}

module.exports = core;
