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

// libs/polygraph/cli/bundle/src/lib/polygraph/drivers/request-permission-mcp-server.ts
var request_permission_mcp_server_exports = {};
__export(request_permission_mcp_server_exports, {
  handleToolCall: () => handleToolCall,
  resetPermissionQueue: () => resetPermissionQueue
});
module.exports = __toCommonJS(request_permission_mcp_server_exports);

// libs/polygraph/cli/bundle/src/lib/polygraph/line-splitter.ts
var LineSplitter = class {
  partial = "";
  /** Push raw text, returns complete lines (excluding the trailing partial). */
  push(text) {
    const combined = this.partial + text;
    const parts = combined.split("\n");
    this.partial = parts[parts.length - 1];
    return parts.slice(0, -1).filter((l) => l.length > 0);
  }
  /** Flush any remaining partial line. */
  flush() {
    if (this.partial.length === 0)
      return null;
    const line = this.partial;
    this.partial = "";
    return line;
  }
};

// libs/polygraph/cli/bundle/src/lib/polygraph/drivers/request-permission-mcp-server.ts
var TOOL_DEFINITION = {
  name: "permission_prompt",
  description: "Internal: invoked by Claude when a tool requires permission. Forwards the request to the parent agent and returns the decision.",
  inputSchema: {
    type: "object",
    properties: {
      tool_name: { type: "string" },
      input: { type: "object" },
      tool_use_id: { type: "string" }
    },
    required: ["tool_name", "input"]
  }
};
function sendResponse(response) {
  process.stdout.write(JSON.stringify(response) + "\n");
}
function denyResult(id, message) {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      content: [
        { type: "text", text: JSON.stringify({ behavior: "deny", message }) }
      ]
    }
  };
}
var queueTail = Promise.resolve();
var queueDepth = 0;
function resetPermissionQueue() {
  queueTail = Promise.resolve();
  queueDepth = 0;
}
async function handleToolCall(request) {
  const { id } = request;
  const params = request.params;
  if (!params || typeof params !== "object") {
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32602, message: "Invalid params" }
    };
  }
  const toolName = params.name;
  if (toolName !== "permission_prompt") {
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: "Tool not found" }
    };
  }
  const toolInput = params.arguments;
  if (!toolInput || typeof toolInput !== "object") {
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32602, message: "Invalid tool input" }
    };
  }
  const requestedTool = toolInput.tool_name;
  if (typeof requestedTool !== "string") {
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32602, message: "tool_name parameter must be a string" }
    };
  }
  const input = toolInput.input;
  const toolUseId = typeof toolInput.tool_use_id === "string" ? toolInput.tool_use_id : void 0;
  queueDepth++;
  const depthAtEnqueue = queueDepth;
  const run = queueTail.then(
    () => forwardPermission(id, requestedTool, input, toolUseId, depthAtEnqueue)
  );
  queueTail = run.catch(() => void 0);
  try {
    return await run;
  } finally {
    queueDepth--;
  }
}
async function forwardPermission(id, toolName, input, toolUseId, depth) {
  const sidecarUrl = process.env.POLYGRAPH_A2A_SIDECAR_URL;
  const taskId = process.env.POLYGRAPH_A2A_TASK_ID;
  if (!sidecarUrl) {
    return denyResult(id, "no sidecar url");
  }
  let decision;
  try {
    const response = await fetch(`${sidecarUrl}/internal/request-permission`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        taskId,
        toolUseId,
        toolName,
        input,
        queueDepth: depth
      })
    });
    if (!response.ok) {
      return denyResult(id, `permission channel error (${response.status})`);
    }
    decision = await response.json();
  } catch (err) {
    return denyResult(
      id,
      `permission channel error: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  const native = decision.decision === "allow" ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: decision.reason ?? "denied" };
  return {
    jsonrpc: "2.0",
    id,
    result: { content: [{ type: "text", text: JSON.stringify(native) }] }
  };
}
async function handleRequest(request) {
  const { id, method } = request;
  switch (method) {
    case "initialize":
      sendResponse({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: {
            name: "polygraph-request-permission",
            version: "0.1.0"
          }
        }
      });
      break;
    case "tools/list":
      sendResponse({
        jsonrpc: "2.0",
        id,
        result: { tools: [TOOL_DEFINITION] }
      });
      break;
    case "tools/call":
      {
        const response = await handleToolCall(request);
        sendResponse(response);
      }
      break;
    default:
      if (id !== void 0) {
        sendResponse({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: "Method not found" }
        });
      }
  }
}
function handleNotification(notification) {
  switch (notification.method) {
    case "notifications/initialized":
      break;
    default:
      break;
  }
}
function parseJsonRpcMessage(line) {
  try {
    const parsed = JSON.parse(line);
    if (parsed && typeof parsed === "object" && parsed.jsonrpc === "2.0") {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}
async function main() {
  const splitter = new LineSplitter();
  process.stdin.on("data", async (chunk) => {
    const lines = splitter.push(chunk.toString("utf-8"));
    for (const line of lines) {
      const message = parseJsonRpcMessage(line);
      if (!message) {
        continue;
      }
      if ("method" in message && message.method) {
        if ("id" in message) {
          await handleRequest(message);
        } else {
          handleNotification(message);
        }
      }
    }
  });
  process.stdin.on("end", () => {
    process.exit(0);
  });
  process.stdin.resume();
}
if (require.main === module) {
  main().catch((error) => {
    console.error("MCP server error:", error);
    process.exit(1);
  });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  handleToolCall,
  resetPermissionQueue
});
