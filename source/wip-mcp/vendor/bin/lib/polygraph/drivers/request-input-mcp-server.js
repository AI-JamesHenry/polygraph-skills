#!/usr/bin/env node
"use strict";

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

// libs/polygraph/cli/bundle/src/lib/polygraph/drivers/request-input-mcp-server.ts
var TOOL_DEFINITION = {
  name: "polygraph_request_input",
  description: "Signal that you need input from the parent agent before continuing. Call this when you encounter a decision or question that requires the parent agent's guidance. After calling this tool, finish your current turn \u2014 the parent will provide the answer in your next prompt.",
  inputSchema: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description: "The question or decision point requiring parent agent input"
      }
    },
    required: ["question"]
  }
};
function sendResponse(response) {
  process.stdout.write(JSON.stringify(response) + "\n");
}
async function handleToolCall(request) {
  const { id } = request;
  const params = request.params;
  if (!params || typeof params !== "object") {
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32602,
        message: "Invalid params"
      }
    };
  }
  const toolName = params.name;
  const toolInput = params.arguments;
  if (toolName !== "polygraph_request_input") {
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32601,
        message: "Tool not found"
      }
    };
  }
  if (!toolInput || typeof toolInput !== "object") {
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32602,
        message: "Invalid tool input"
      }
    };
  }
  const question = toolInput.question;
  if (typeof question !== "string") {
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32602,
        message: "question parameter must be a string"
      }
    };
  }
  const sidecarUrl = process.env.POLYGRAPH_A2A_SIDECAR_URL;
  const taskId = process.env.POLYGRAPH_A2A_TASK_ID;
  if (sidecarUrl && sidecarUrl.length > 0) {
    try {
      const response = await fetch(`${sidecarUrl}/internal/request-input`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ taskId, question })
      });
      if (!response.ok) {
        console.error(
          `[request-input] Callback failed (${response.status}), but sidecar will detect tool call synchronously`
        );
      }
    } catch (error) {
      console.error(
        `[request-input] Callback error: ${error instanceof Error ? error.message : String(error)}, but sidecar will detect tool call synchronously`
      );
    }
  }
  return {
    jsonrpc: "2.0",
    id,
    result: {
      content: [
        {
          type: "text",
          text: `Input requested: "${question}". Finish your current turn now. The parent agent will provide the answer in your next prompt.`
        }
      ]
    }
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
          capabilities: {
            tools: {}
          },
          serverInfo: {
            name: "polygraph-request-input",
            version: "0.1.0"
          }
        }
      });
      break;
    case "tools/list":
      sendResponse({
        jsonrpc: "2.0",
        id,
        result: {
          tools: [TOOL_DEFINITION]
        }
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
          error: {
            code: -32601,
            message: "Method not found"
          }
        });
      }
  }
}
function handleNotification(notification) {
  const { method } = notification;
  switch (method) {
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
main().catch((error) => {
  console.error("MCP server error:", error);
  process.exit(1);
});
