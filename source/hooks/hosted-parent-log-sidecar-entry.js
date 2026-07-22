#!/usr/bin/env node
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// libs/polygraph/cli/bundle/src/lib/polygraph/hosted-parent-log-sidecar-entry.ts
var hosted_parent_log_sidecar_entry_exports = {};
__export(hosted_parent_log_sidecar_entry_exports, {
  mapClaudeTranscriptRecords: () => mapClaudeTranscriptRecords,
  readCompleteTranscriptRecords: () => readCompleteTranscriptRecords
});
module.exports = __toCommonJS(hosted_parent_log_sidecar_entry_exports);
var import_node_crypto = require("node:crypto");
var import_node_fs = require("node:fs");
var import_node_path = require("node:path");

// libs/polygraph/cli/bundle/src/lib/api/secret-redactor.ts
var REDACTED = "[REDACTED]";
var BEARER_JWT_PATTERN = /\b(Bearer\s+)[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gi;
var PEM_PRIVATE_KEY_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
var PEM_PRIVATE_KEY_BEGIN_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
var PEM_PRIVATE_KEY_END_PATTERN = /-----END [A-Z ]*PRIVATE KEY-----/;
var PROVIDER_TOKEN_PATTERN = /(^|[^A-Za-z0-9_]|\\[nrt])((?:pypi-[A-Za-z0-9._-]{8,}|hf_[A-Za-z0-9]{8,}|vercel_[A-Za-z0-9._-]{8,}|sbp_[A-Za-z0-9._-]{8,}|trk_[A-Za-z0-9._-]{8,}|github_pat_[A-Za-z0-9_]{20,}|gh[oprsu]_[A-Za-z0-9]{20,}|npm_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{30,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}))(?=$|[^A-Za-z0-9._-]|\\[nrt])/g;
var CREDENTIAL_URL_PATTERN = /\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^/@\s:]+):([^/@\s]+)@/g;
var REGISTRY_AUTH_PATTERN = /((?:_authToken|_password|_auth)\s*=\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s\n]+)/gi;
var QUERY_PARAM_SECRET_PATTERN = /([?&](?:access_?token|api[_-]?key|auth_?token|client_secret|secret|password|pwd|token)=)(?:[^&\s#"']+)/gi;
var EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
var SECRET_ENV_ASSIGNMENT_PATTERN = /(^|[;"'\\\s])((?:export\s+)?[A-Za-z_][A-Za-z0-9_]*(?:SECRET|PASSWORD|PASSWD|TOKEN|CREDENTIAL|PRIVATE|_KEY)[A-Za-z0-9_]*\s*=\s*)(?:"[^"\n;]*"|'[^'\n;]*'|[^\s;\n]+)/gim;
var CONNECTION_ENV_ASSIGNMENT_PATTERN = /(^|[;"'\\\s])((?:export\s+)?[A-Za-z_][A-Za-z0-9_]*(?:_DSN|_URL|_URI|_ENDPOINT|_HOST|_CONN|_CONNECTION)\s*=\s*)(?:"[^"\n;]*"|'[^'\n;]*'|[^\s;\n]+)/gim;
function redactSecretString(value) {
  return value.replace(PEM_PRIVATE_KEY_PATTERN, REDACTED).replace(BEARER_JWT_PATTERN, `$1${REDACTED}`).replace(PROVIDER_TOKEN_PATTERN, `$1${REDACTED}`).replace(CREDENTIAL_URL_PATTERN, `$1${REDACTED}@`).replace(REGISTRY_AUTH_PATTERN, `$1${REDACTED}`).replace(QUERY_PARAM_SECRET_PATTERN, `$1${REDACTED}`).replace(CONNECTION_ENV_ASSIGNMENT_PATTERN, `$1$2${REDACTED}`).replace(SECRET_ENV_ASSIGNMENT_PATTERN, `$1$2${REDACTED}`).replace(EMAIL_PATTERN, REDACTED);
}
function redactSecretLines(lines) {
  let inPemPrivateKeyBlock = false;
  return lines.map((line) => {
    const startsPemPrivateKeyBlock = PEM_PRIVATE_KEY_BEGIN_PATTERN.test(line);
    const endsPemPrivateKeyBlock = PEM_PRIVATE_KEY_END_PATTERN.test(line);
    if (inPemPrivateKeyBlock || startsPemPrivateKeyBlock) {
      inPemPrivateKeyBlock = !endsPemPrivateKeyBlock;
      return REDACTED;
    }
    return redactSecretString(line);
  });
}

// libs/polygraph/cli/bundle/src/lib/polygraph/parent-transcript-adapter.ts
var import_node_util = require("node:util");

// libs/polygraph/model-agent-sessions/src/lib/agent-log-types.ts
function parseTaskNotificationText(text) {
  const match = text.match(
    /<task-notification>\s*([\s\S]*?)\s*<\/task-notification>/
  );
  if (!match)
    return null;
  const body = match[1] ?? "";
  const summary = readXmlTag(body, "summary");
  if (!summary)
    return null;
  const result = readXmlTag(body, "result");
  const detail = result ? decodeBasicXmlEntities(result) : void 0;
  return {
    type: "task-notification",
    taskId: readXmlTag(body, "task-id") ?? void 0,
    toolUseId: readXmlTag(body, "tool-use-id") ?? void 0,
    outputFile: readXmlTag(body, "output-file") ?? void 0,
    status: readXmlTag(body, "status") ?? void 0,
    summary: decodeBasicXmlEntities(summary),
    text: match[0],
    ...detail ? { detail } : {}
  };
}
function decodeBasicXmlEntities(text) {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}
function readXmlTag(text, tag) {
  const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(
    new RegExp(`<${escapedTag}>\\s*([\\s\\S]*?)\\s*<\\/${escapedTag}>`)
  );
  const value = match?.[1]?.trim();
  return value && value.length > 0 ? value : null;
}

// libs/polygraph/cli/bundle/src/lib/polygraph/polygraph-utils.ts
var SENSITIVE_HEADER_NAMES = new Set(
  ["authorization", "nx-cloud-personal-access-token", "x-api-key"].map(
    (h) => h.toLowerCase()
  )
);

// libs/polygraph/cli/bundle/src/lib/polygraph/drivers/claude/claude-utils.ts
function blockToUpdate(block) {
  if (!block || typeof block !== "object")
    return null;
  const b = block;
  if (typeof b.type !== "string")
    return null;
  switch (b.type) {
    case "text": {
      if (typeof b.text !== "string")
        return null;
      return { type: "text", content: b.text, raw: block };
    }
    case "thinking": {
      if (typeof b.thinking !== "string")
        return null;
      return { type: "thinking", content: b.thinking, raw: block };
    }
    case "tool_use": {
      const toolName = typeof b.name === "string" ? b.name : "unknown";
      const toolCallId = typeof b.id === "string" ? b.id : "";
      const content = typeof b.input === "string" ? b.input : JSON.stringify(b.input ?? {});
      return {
        type: "tool_call",
        content,
        toolName,
        toolCallId,
        raw: block
      };
    }
    case "tool_result": {
      const toolCallId = typeof b.tool_use_id === "string" ? b.tool_use_id : "";
      const content = typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "");
      return {
        type: "tool_result",
        content,
        toolCallId,
        isError: b.is_error === true,
        raw: block
      };
    }
    default:
      return null;
  }
}

// libs/polygraph/cli/bundle/src/lib/polygraph/parent-transcript-adapter.ts
var CODEX_STATE_ENTRY_LIMIT = 200;
function createClaudeTranscriptEntryMapper() {
  const state = { pendingSkillLoads: /* @__PURE__ */ new Map() };
  return {
    map: (entry) => transcriptEntryToLogLinesWithClaudeState(entry, state),
    flushPending: () => flushPendingClaudeSkillLoads(state)
  };
}
function transcriptEntryToLogLinesWithClaudeState(entry, state) {
  if (!entry || typeof entry !== "object")
    return [];
  const record = entry;
  if (state) {
    const skillLoad = claudeSkillBodyFromMetaEntry(record, state);
    if (skillLoad)
      return [skillLoad];
  }
  const topLevelLines = topLevelEntryToLogLines(record);
  if (topLevelLines)
    return topLevelLines;
  const role = readRole(record);
  const content = readContent(record);
  if (role === "assistant") {
    return contentBlocks(content).flatMap(
      (block) => blockToLogLines(block, state)
    );
  }
  if (role === "user") {
    if (typeof content === "string") {
      const stripped = (0, import_node_util.stripVTControlCharacters)(content);
      const taskNotification = parseTaskNotificationText(stripped);
      if (taskNotification)
        return [taskNotification];
      return stripped ? [{ type: "user-prompt", text: stripped }] : [];
    }
    return contentBlocks(content).flatMap((block) => {
      if (isToolResultBlock(block)) {
        const output = (0, import_node_util.stripVTControlCharacters)(
          toolResultContentToText(block["content"])
        );
        if (isClaudeSkillLaunchOutput(output))
          return [];
        const toolUseId = block["tool_use_id"];
        const line = {
          type: "tool-result",
          toolName: readToolName(block),
          output,
          isError: block["is_error"] === true,
          toolUseId: typeof toolUseId === "string" && toolUseId.length > 0 ? toolUseId : void 0
        };
        if (isJsonOutput(output))
          line.outputFormat = "json";
        return [line];
      }
      return blockToLogLines(block, state);
    });
  }
  if (role === "system" || role === "summary") {
    const text = summarizeSystemEntry(record);
    return text ? [{ type: "system", text: (0, import_node_util.stripVTControlCharacters)(text) }] : [];
  }
  return [];
}
function blockToLogLines(block, state = null) {
  const update = blockToUpdate(block);
  if (!update)
    return [];
  const content = (0, import_node_util.stripVTControlCharacters)(update.content);
  switch (update.type) {
    case "text":
      return [{ type: "text", role: "assistant", text: content }];
    case "thinking":
      return [{ type: "thinking", text: content }];
    case "tool_call": {
      const claudeSkillName = update.toolName === "Skill" ? parseClaudeSkillName(content) : null;
      if (claudeSkillName) {
        if (state && update.toolCallId) {
          rememberClaudeSkillLoad(state, update.toolCallId, claudeSkillName);
          return [];
        }
        return [{ type: "skill-load", skillName: claudeSkillName }];
      }
      return [
        {
          type: "tool-use",
          toolName: update.toolName ?? "unknown",
          input: content,
          toolUseId: update.toolCallId || void 0
        }
      ];
    }
    case "tool_result": {
      const output = (0, import_node_util.stripVTControlCharacters)(
        toolResultContentToText(block["content"])
      );
      if (isClaudeSkillLaunchOutput(output))
        return [];
      const line = {
        type: "tool-result",
        toolName: update.toolName ?? update.toolCallId ?? "tool_result",
        output,
        isError: update.isError === true,
        toolUseId: update.toolCallId || void 0
      };
      if (isJsonOutput(output))
        line.outputFormat = "json";
      return [line];
    }
    case "user-prompt":
      return [{ type: "user-prompt", text: content }];
    default:
      return [];
  }
}
function topLevelEntryToLogLines(record) {
  const type = record["type"];
  if (type === "task-notification") {
    return topLevelTaskNotificationToLogLines(record);
  }
  if (type === "permission-mode") {
    return permissionModeToLogLines(record);
  }
  if (type === "attachment") {
    return attachmentToLogLines(record["attachment"]);
  }
  if (isKnownDroppedTopLevelType(type)) {
    return [];
  }
  return null;
}
function topLevelTaskNotificationToLogLines(record) {
  const summary = readString(record, "summary");
  if (!summary)
    return [];
  return [
    {
      type: "task-notification",
      taskId: readString(record, "taskId") ?? readString(record, "task-id") ?? void 0,
      toolUseId: readString(record, "toolUseId") ?? readString(record, "tool-use-id") ?? void 0,
      outputFile: readString(record, "outputFile") ?? readString(record, "output-file") ?? void 0,
      status: readString(record, "status") ?? void 0,
      summary,
      text: stringifyContent(record)
    }
  ];
}
function readRole(record) {
  const type = record["type"];
  if (typeof type === "string") {
    if (type === "summary")
      return "summary";
    if (type === "system" || type === "meta")
      return type;
  }
  const message = readMessage(record);
  const role = message?.["role"];
  if (typeof role === "string")
    return role;
  return null;
}
function readContent(record) {
  const message = readMessage(record);
  if (message && "content" in message)
    return message["content"];
  return record["content"];
}
function readMessage(record) {
  const message = record["message"];
  return message && typeof message === "object" ? message : null;
}
function contentBlocks(content) {
  if (Array.isArray(content))
    return content;
  if (content && typeof content === "object")
    return [content];
  return [];
}
function isToolResultBlock(block) {
  return !!block && typeof block === "object" && block["type"] === "tool_result";
}
function readToolName(block) {
  const name = block["name"];
  if (typeof name === "string" && name.length > 0)
    return name;
  const toolUseId = block["tool_use_id"];
  return typeof toolUseId === "string" && toolUseId.length > 0 ? toolUseId : "tool_result";
}
function permissionModeToLogLines(record) {
  const mode = readString(record, "permissionMode");
  if (!mode)
    return [];
  return [
    {
      type: "event",
      label: "Permission mode",
      detail: formatPermissionMode(mode)
    }
  ];
}
function attachmentToLogLines(attachment) {
  if (!attachment || typeof attachment !== "object")
    return [];
  const record = attachment;
  const type = readString(record, "type");
  if (!type)
    return [];
  switch (type) {
    case "file": {
      return attachmentEvent("Attached file", formatFileReference(record));
    }
    case "compact_file_reference": {
      return attachmentEvent("Referenced file", formatFileReference(record));
    }
    case "opened_file_in_ide": {
      return attachmentEvent("Opened file", formatFileReference(record));
    }
    case "selected_lines_in_ide": {
      const file = formatFileReference(record);
      const lineStart = readNumber(record, "lineStart");
      const lineEnd = readNumber(record, "lineEnd");
      const range = lineStart !== null && lineEnd !== null ? `${file ?? "unknown"}:${lineStart}-${lineEnd}` : file;
      return attachmentEvent("Selected lines", range);
    }
    case "edited_text_file": {
      return attachmentEvent("Edited file", formatFileReference(record));
    }
    case "hook_non_blocking_error": {
      return attachmentEvent("Hook warning", formatHookWarning(record));
    }
    default:
      return [];
  }
}
function attachmentEvent(label, detail) {
  return [
    detail && detail.length > 0 ? { type: "event", label, detail } : { type: "event", label }
  ];
}
function formatPermissionMode(mode) {
  switch (mode) {
    case "acceptEdits":
      return "Accept edits";
    case "bypassPermissions":
      return "Bypass permissions";
    case "default":
      return "Default";
    case "plan":
      return "Plan";
    default:
      return mode.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  }
}
function formatFileReference(record) {
  return readString(record, "displayPath") ?? readString(record, "filename") ?? readString(record, "path") ?? readString(record, "url");
}
function formatHookWarning(record) {
  const parts = [
    readString(record, "hookName"),
    readString(record, "hookEvent"),
    formatExitCode(readNumber(record, "exitCode")),
    formatDurationMs(readNumber(record, "durationMs"))
  ].filter((part) => !!part);
  return parts.length > 0 ? parts.join(" - ") : null;
}
function formatExitCode(value) {
  return value === null ? null : `exit ${value}`;
}
function formatDurationMs(value) {
  return value === null ? null : `${value}ms`;
}
function readString(record, key) {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}
function readNumber(record, key) {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function stringifyContent(value) {
  if (typeof value === "string")
    return value;
  try {
    return JSON.stringify(value ?? "");
  } catch {
    return String(value);
  }
}
function toolResultContentToText(content) {
  if (typeof content === "string")
    return content;
  if (Array.isArray(content)) {
    return content.map((entry) => {
      if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        const record = entry;
        const text = record["text"];
        if (record["type"] === "text" && typeof text === "string") {
          return text;
        }
        const type = readString(record, "type");
        return type ? `[${type}]` : stringifyContent(record);
      }
      return stringifyContent(entry);
    }).join("\n");
  }
  return stringifyContent(content);
}
var JSON_OUTPUT_SNIFF_LIMIT = 262144;
function isJsonOutput(output) {
  const trimmed = output.trim();
  if (trimmed.length === 0 || trimmed.length > JSON_OUTPUT_SNIFF_LIMIT) {
    return false;
  }
  const first = trimmed[0];
  if (first !== "{" && first !== "[")
    return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}
function parseClaudeSkillName(input) {
  const trimmed = input.trim();
  if (!trimmed.startsWith("{"))
    return null;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const ref = parsed && typeof parsed === "object" ? parsed["skill"] : null;
  if (typeof ref !== "string" || !ref)
    return null;
  const lastColon = ref.lastIndexOf(":");
  return lastColon >= 0 ? ref.slice(lastColon + 1) : ref;
}
function isClaudeSkillLaunchOutput(output) {
  return /^Launching skill:/.test(output.trim());
}
var POLYGRAPH_PLUGIN_PACKAGES = {
  claude: "@polygraph/claude-plugin",
  codex: "@polygraph/codex-plugin",
  opencode: "@polygraph/opencode-plugin"
};
var POLYGRAPH_PLUGIN_CACHE_PATH = /plugins[\\/]cache[\\/]polygraph-plugins[\\/]polygraph[\\/]([^\\/]+)[\\/]/;
var POLYGRAPH_PLUGIN_VERSIONED_PACKAGE_PATH = /@polygraph[\\/](?:claude|codex|opencode)-plugin@(\d[^\\/]*)[\\/]/;
var POLYGRAPH_PLUGIN_PACKAGE_PATH = /node_modules[\\/]@polygraph[\\/](?:claude|codex|opencode)-plugin[\\/]/;
function detectPolygraphPluginSkill(path, pluginPackage) {
  if (!path)
    return null;
  const cache = POLYGRAPH_PLUGIN_CACHE_PATH.exec(path);
  if (cache)
    return { pluginPackage, pluginVersion: cache[1] };
  const versioned = POLYGRAPH_PLUGIN_VERSIONED_PACKAGE_PATH.exec(path);
  if (versioned)
    return { pluginPackage, pluginVersion: versioned[1] };
  if (POLYGRAPH_PLUGIN_PACKAGE_PATH.test(path))
    return { pluginPackage };
  return null;
}
var CLAUDE_SKILL_BODY_PREAMBLE = /^Base directory for this skill:[^\n]*\n*/;
function rememberClaudeSkillLoad(state, toolUseId, skillName) {
  rememberCodexMapValue(state.pendingSkillLoads, toolUseId, skillName);
}
function claudeSkillBodyFromMetaEntry(record, state) {
  if (record["isMeta"] !== true)
    return null;
  const sourceToolUseId = record["sourceToolUseID"];
  if (typeof sourceToolUseId !== "string")
    return null;
  const skillName = state.pendingSkillLoads.get(sourceToolUseId);
  if (skillName === void 0)
    return null;
  state.pendingSkillLoads.delete(sourceToolUseId);
  const rawText = (0, import_node_util.stripVTControlCharacters)(
    claudeTextFromContent(readContent(record))
  );
  const baseDir = /^Base directory for this skill:\s*([^\n]+)/.exec(
    rawText
  )?.[1];
  const pluginRef = detectPolygraphPluginSkill(
    baseDir,
    POLYGRAPH_PLUGIN_PACKAGES.claude
  );
  if (pluginRef) {
    return { type: "skill-load", skillName, ...pluginRef };
  }
  const body = stripClaudeSkillPreamble(rawText);
  return body ? { type: "skill-load", skillName, body } : { type: "skill-load", skillName };
}
function claudeTextFromContent(content) {
  if (typeof content === "string")
    return content;
  return contentBlocks(content).map((block) => {
    if (block && typeof block === "object") {
      const b = block;
      if (b["type"] === "text" && typeof b["text"] === "string") {
        return b["text"];
      }
    }
    return "";
  }).join("");
}
function stripClaudeSkillPreamble(text) {
  return text.replace(CLAUDE_SKILL_BODY_PREAMBLE, "").trimEnd();
}
function flushPendingClaudeSkillLoads(state) {
  if (!state || state.pendingSkillLoads.size === 0)
    return [];
  const lines = [];
  for (const skillName of state.pendingSkillLoads.values()) {
    lines.push({ type: "skill-load", skillName });
  }
  state.pendingSkillLoads.clear();
  return lines;
}
function rememberCodexMapValue(map, key, value) {
  map.set(key, value);
  if (map.size <= CODEX_STATE_ENTRY_LIMIT)
    return;
  const first = map.keys().next().value;
  if (first !== void 0)
    map.delete(first);
}
function summarizeSystemEntry(record) {
  const summary = record["summary"];
  if (typeof summary === "string" && summary.length > 0)
    return summary;
  const content = readContent(record);
  if (typeof content === "string" && content.length > 0)
    return content;
  return null;
}
function isKnownDroppedTopLevelType(type) {
  return type === "last-prompt" || type === "file-history-snapshot" || type === "ai-title" || type === "meta";
}

// libs/polygraph/cli/bundle/src/lib/polygraph/hosted-parent-log-sidecar-entry.ts
var POLL_INTERVAL_MS = 250;
var DEFAULT_IDLE_CLOSE_MS = 36e5;
var MAX_READ_BYTES = 4 * 1024 * 1024;
var MAX_BATCH_BYTES = 2 * 1024 * 1024;
function mapClaudeTranscriptRecords(records, mapper = createClaudeTranscriptEntryMapper()) {
  const mapped = [];
  for (const record of records) {
    let entry;
    try {
      entry = JSON.parse(record.raw);
    } catch {
      entry = {
        type: "system",
        content: record.raw
      };
    }
    const sourceHash = (0, import_node_crypto.createHash)("sha256").update(record.raw).digest("hex").slice(0, 20);
    const lines = mapper.map(entry).map(
      (line, index) => JSON.stringify({
        ...line,
        eventId: `transcript:${record.startOffset}:${sourceHash}:${index}`
      })
    );
    const redacted = redactSecretLines(lines);
    for (const line of redacted) {
      mapped.push({ sourceEndOffset: record.endOffset, line });
    }
  }
  return mapped;
}
function readCompleteTranscriptRecords(transcriptPath, byteOffset) {
  const size = (0, import_node_fs.statSync)(transcriptPath).size;
  if (size <= byteOffset)
    return { records: [], nextOffset: byteOffset };
  const bytesToRead = Math.min(MAX_READ_BYTES, size - byteOffset);
  const buffer = Buffer.allocUnsafe(bytesToRead);
  const fd = (0, import_node_fs.openSync)(transcriptPath, "r");
  let bytesRead = 0;
  try {
    bytesRead = (0, import_node_fs.readSync)(fd, buffer, 0, bytesToRead, byteOffset);
  } finally {
    (0, import_node_fs.closeSync)(fd);
  }
  if (bytesRead === 0)
    return { records: [], nextOffset: byteOffset };
  const chunk = buffer.subarray(0, bytesRead);
  const finalNewline = chunk.lastIndexOf(10);
  if (finalNewline < 0)
    return { records: [], nextOffset: byteOffset };
  const records = [];
  let start = 0;
  for (let cursor = 0; cursor <= finalNewline; cursor += 1) {
    if (chunk[cursor] !== 10)
      continue;
    const raw = chunk.subarray(start, cursor).toString("utf8");
    if (raw.trim()) {
      records.push({
        raw,
        startOffset: byteOffset + start,
        endOffset: byteOffset + cursor + 1
      });
    }
    start = cursor + 1;
  }
  return { records, nextOffset: byteOffset + finalNewline + 1 };
}
function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value)
    throw new Error(`${name} is required`);
  return value;
}
function validateCaptureHookUrl(value) {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || !/^\/(?:nx-cloud\/polygraph\/)?hooks\/capture\/pch_[A-Za-z0-9_-]{32,}$/.test(parsed.pathname) || value.includes("?") || value.includes("#")) {
    throw new Error("POLYGRAPH_PARENT_LOG_CAPTURE_HOOK_URL is invalid");
  }
  return parsed.toString().replace(/\/$/, "");
}
function writeRuntimeState(path, state) {
  (0, import_node_fs.mkdirSync)((0, import_node_path.dirname)(path), { recursive: true, mode: 448 });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  (0, import_node_fs.writeFileSync)(temporaryPath, `${JSON.stringify(state)}
`, {
    encoding: "utf8",
    mode: 384
  });
  (0, import_node_fs.renameSync)(temporaryPath, path);
}
function batchMappedLines(lines) {
  const batches = [];
  let batch = [];
  let byteLength = 0;
  for (const line of lines) {
    const lineBytes = Buffer.byteLength(line.line) + 64;
    if (batch.length > 0 && byteLength + lineBytes > MAX_BATCH_BYTES) {
      batches.push(batch);
      batch = [];
      byteLength = 0;
    }
    batch.push(line);
    byteLength += lineBytes;
  }
  if (batch.length > 0)
    batches.push(batch);
  return batches;
}
async function postBatch(captureHookUrl, providerSessionId, lines) {
  const response = await fetch(`${captureHookUrl}/transcript`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      session_id: providerSessionId,
      source: "claude-transcript-v1",
      lines: lines.map((entry) => entry.line)
    }),
    signal: AbortSignal.timeout(3e4)
  });
  if (!response.ok) {
    throw new Error(
      `Polygraph transcript append returned HTTP ${response.status}`
    );
  }
}
async function main() {
  const providerSessionId = requiredEnv(
    "POLYGRAPH_PARENT_LOG_PARENT_SESSION_ID"
  );
  const transcriptPath = requiredEnv("POLYGRAPH_PARENT_LOG_PATH");
  const runtimeStatePath = requiredEnv("POLYGRAPH_PARENT_LOG_RUNTIME_PATH");
  const captureHookUrl = validateCaptureHookUrl(
    requiredEnv("POLYGRAPH_PARENT_LOG_CAPTURE_HOOK_URL")
  );
  const idleCloseMs = Number.parseInt(
    process.env["POLYGRAPH_PARENT_LOG_IDLE_CLOSE_MS"] ?? String(DEFAULT_IDLE_CLOSE_MS),
    10
  );
  if (!(0, import_node_fs.existsSync)(transcriptPath)) {
    throw new Error(`Claude transcript does not exist at ${transcriptPath}`);
  }
  const startOffset = Number.parseInt(
    process.env["POLYGRAPH_PARENT_LOG_START_OFFSET"] ?? "0",
    10
  );
  if (!Number.isSafeInteger(startOffset) || startOffset < 0 || startOffset > (0, import_node_fs.statSync)(transcriptPath).size) {
    throw new Error("POLYGRAPH_PARENT_LOG_START_OFFSET is invalid");
  }
  const mapper = createClaudeTranscriptEntryMapper();
  let byteOffset = startOffset;
  let lastActivityAt = Date.now();
  let stopped = false;
  const persist = () => writeRuntimeState(runtimeStatePath, {
    version: 1,
    providerSessionId,
    transcriptPath,
    captureHookUrl,
    pid: process.pid,
    startOffset,
    byteOffset,
    updatedAt: Date.now()
  });
  const processAvailableRecords = async () => {
    const { records, nextOffset } = readCompleteTranscriptRecords(
      transcriptPath,
      byteOffset
    );
    if (nextOffset === byteOffset)
      return;
    const mapped = mapClaudeTranscriptRecords(records, mapper);
    for (const batch of batchMappedLines(mapped)) {
      await postBatch(captureHookUrl, providerSessionId, batch);
    }
    byteOffset = nextOffset;
    lastActivityAt = Date.now();
    persist();
  };
  const shutdown = () => {
    if (stopped)
      return;
    stopped = true;
    persist();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  await processAvailableRecords();
  persist();
  process.stdout.write(
    `${JSON.stringify({ status: "ready", pid: process.pid, byteOffset })}
`
  );
  while (!stopped) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    try {
      await processAvailableRecords();
    } catch (error) {
      process.stderr.write(
        `[hosted-parent-log-sidecar] ${error instanceof Error ? error.message : String(error)}
`
      );
    }
    if (Number.isFinite(idleCloseMs) && idleCloseMs > 0 && Date.now() - lastActivityAt >= idleCloseMs) {
      shutdown();
    }
  }
}
if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(
      `${JSON.stringify({
        status: "error",
        message: error instanceof Error ? error.message : String(error)
      })}
`
    );
    process.exitCode = 1;
  });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  mapClaudeTranscriptRecords,
  readCompleteTranscriptRecords
});
