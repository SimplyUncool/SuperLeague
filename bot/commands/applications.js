"use strict";

const core = require("../internal/applications_core.js");

// The application form question editor is intentionally kept in the interactive
// application-management UI. It is not exposed as /applications question/*.
if (core.command?.data?.options) {
  core.command.data.options = core.command.data.options.filter(option => option.name !== "question");
}

module.exports = core;
