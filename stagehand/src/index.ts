#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  CallToolResult,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";

import { Stagehand } from "@browserbasehq/stagehand";

import { AnyZodObject } from "zod";
import { jsonSchemaToZod } from "./utils.js";
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Get the directory name for the current module
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Configure logging
const LOG_DIR = path.join(__dirname, '../logs');
const LOG_FILE = path.join(LOG_DIR, `stagehand-${new Date().toISOString().split('T')[0]}.log`);

// Ensure log directory exists
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

// Define the Stagehand tools
const TOOLS: Tool[] = [
  {
    name: "stagehand_navigate",
    description: "Navigate to a URL in the browser",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to navigate to" },
      },
      required: ["url"],
    },
  },
  {
    name: "stagehand_act",
    description: "Performs an action on the web page",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "The action to perform" },
        variables: {
          type: "object",
          additionalProperties: true,
          description: "Variables used in the action template",
        },
      },
      required: ["action"],
    },
  },
  {
    name: "stagehand_extract",
    description: `Extracts structured data from the web page based on an instruction and a JSON schema.`,
    inputSchema: {
      type: "object",
      description: `**Instructions for providing the schema:**
  
  - The \`schema\` should be a valid JSON Schema object that defines the structure of the data to extract.
  - Use standard JSON Schema syntax.
  - The server will convert the JSON Schema to a Zod schema internally.
  
  **Example schemas:**
  
  1. **Extracting a list of search result titles:**
  
  \`\`\`json
  {
    "type": "object",
    "properties": {
      "searchResults": {
        "type": "array",
        "items": {
          "type": "string",
          "description": "Title of a search result"
        }
      }
    },
    "required": ["searchResults"]
  }
  \`\`\`
  
  2. **Extracting product details:**
  
  \`\`\`json
  {
    "type": "object",
    "properties": {
      "name": { "type": "string" },
      "price": { "type": "string" },
      "rating": { "type": "number" },
      "reviews": {
        "type": "array",
        "items": { "type": "string" }
      }
    },
    "required": ["name", "price", "rating", "reviews"]
  }
  \`\`\`
  
  **Example usage:**
  
  - **Instruction**: "Extract the titles and URLs of the main search results, excluding any ads."
  - **Schema**:
    \`\`\`json
    {
      "type": "object",
      "properties": {
        "results": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "title": { "type": "string", "description": "The title of the search result" },
              "url": { "type": "string", "description": "The URL of the search result" }
            },
            "required": ["title", "url"]
          }
        }
      },
      "required": ["results"]
    }
    \`\`\`
  
  **Note:**
  
  - Ensure the schema is valid JSON.
  - Use standard JSON Schema types like \`string\`, \`number\`, \`array\`, \`object\`, etc.
  - You can add descriptions to help clarify the expected data.
  `,
      properties: {
        instruction: {
          type: "string",
          description:
            "Clear instruction for what data to extract from the page",
        },
        schema: {
          type: "object",
          description:
            "A JSON Schema object defining the structure of data to extract",
          additionalProperties: true,
        },
      },
      required: ["instruction", "schema"],
    },
  },
  {
    name: "stagehand_observe",
    description: "Observes actions that can be performed on the web page",
    inputSchema: {
      type: "object",
      properties: {
        instruction: {
          type: "string",
          description: "Instruction for observation",
        },
      },
    },
  },
];

// Global state
let stagehand: Stagehand | undefined;
const consoleLogs: string[] = [];
const operationLogs: string[] = [];

function log(message: string, level: 'info' | 'error' | 'debug' = 'info') {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] [${level.toUpperCase()}] ${message}`;
  operationLogs.push(logMessage);
  
  // Write to file
  fs.appendFileSync(LOG_FILE, logMessage + '\n');
  
  // Console output if debug is enabled
  if (process.env.DEBUG || level === 'error') {
    console.error(logMessage);
  }
}

function logRequest(type: string, params: any) {
  const requestLog = {
    timestamp: new Date().toISOString(),
    type,
    params,
  };
  log(`REQUEST: ${JSON.stringify(requestLog, null, 2)}`, 'debug');
}

function logResponse(type: string, response: any) {
  const responseLog = {
    timestamp: new Date().toISOString(),
    type,
    response,
  };
  log(`RESPONSE: ${JSON.stringify(responseLog, null, 2)}`, 'debug');
}

// Ensure Stagehand is initialized
async function ensureStagehand() {
  log("Ensuring Stagehand is initialized...");
  if (!stagehand) {
    log("Initializing Stagehand...");
    stagehand = new Stagehand({
      env: "BROWSERBASE",
      headless: true,
      verbose: 2,
      debugDom: true,
      modelName: "claude-3-5-sonnet-20241022",
    });
    log("Running init()");
    await stagehand.init();
    log("Stagehand initialized successfully");
  }
  return stagehand;
}

// Add message validation utilities
function isValidJsonRpcMessage(message: any): boolean {
  return (
    message &&
    typeof message === 'object' &&
    'jsonrpc' in message &&
    message.jsonrpc === '2.0' &&
    'id' in message
  );
}

function sanitizeMessage(message: any): string {
  try {
    // Ensure the message is properly stringified JSON
    if (typeof message === 'string') {
      JSON.parse(message); // Validate JSON structure
      return message;
    }
    return JSON.stringify(message);
  } catch (error) {
    log(`Invalid message format: ${error}`, 'error');
    return JSON.stringify({
      jsonrpc: '2.0',
      error: {
        code: -32700,
        message: 'Parse error',
      },
      id: null,
    });
  }
}

// Handle tool calls
async function handleToolCall(
  name: string,
  args: any
): Promise<CallToolResult> {
  log(`Handling tool call: ${name} with args: ${JSON.stringify(args)}`);

  try {
    stagehand = await ensureStagehand();
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    log(`Failed to initialize Stagehand: ${errorMsg}`, 'error');
    return {
      content: [
        {
          type: "text",
          text: `Failed to initialize Stagehand: ${errorMsg}`,
        },
        {
          type: "text",
          text: `Operation logs:\n${operationLogs.join("\n")}`,
        },
      ],
      isError: true,
    };
  }

  switch (name) {
    case "stagehand_navigate":
      try {
        log(`Navigating to URL: ${args.url}`);
        await stagehand.page.goto(args.url);
        log("Navigation successful");
        return {
          content: [
            {
              type: "text",
              text: `Navigated to: ${args.url}`,
            },
          ],
          isError: false,
        };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        log(`Navigation failed: ${errorMsg}`);
        return {
          content: [
            {
              type: "text",
              text: `Failed to navigate: ${errorMsg}`,
            },
            {
              type: "text",
              text: `Operation logs:\n${operationLogs.join("\n")}`,
            },
          ],
          isError: true,
        };
      }

    case "stagehand_act":
      try {
        log(`Performing action: ${args.action}`);
        await stagehand.act({
          action: args.action,
          variables: args.variables,
        });
        log("Action completed successfully");
        return {
          content: [
            {
              type: "text",
              text: `Action performed: ${args.action}`,
            },
          ],
          isError: false,
        };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        log(`Action failed: ${errorMsg}`);
        return {
          content: [
            {
              type: "text",
              text: `Failed to perform action: ${errorMsg}`,
            },
            {
              type: "text",
              text: `Operation logs:\n${operationLogs.join("\n")}`,
            },
          ],
          isError: true,
        };
      }

    case "stagehand_extract":
      try {
        log(`Extracting data with instruction: ${args.instruction}`);
        log(`Schema: ${JSON.stringify(args.schema)}`);
        // Convert the JSON schema from args.schema to a zod schema
        const zodSchema = jsonSchemaToZod(args.schema) as AnyZodObject;
        const data = await stagehand.extract({
          instruction: args.instruction,
          schema: zodSchema,
        });
        if (!data || typeof data !== "object" || !("data" in data)) {
          throw new Error("Invalid extraction response format");
        }
        const extractedData = data.data;
        log(`Data extracted successfully: ${JSON.stringify(extractedData)}`);
        return {
          content: [
            {
              type: "text",
              text: `Extraction result: ${JSON.stringify(extractedData)}`,
            },
            {
              type: "text",
              text: `Operation logs:\n${operationLogs.join("\n")}`,
            },
          ],
          isError: false,
        };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        log(`Extraction failed: ${errorMsg}`);
        return {
          content: [
            {
              type: "text",
              text: `Failed to extract: ${errorMsg}`,
            },
            {
              type: "text",
              text: `Operation logs:\n${operationLogs.join("\n")}`,
            },
          ],
          isError: true,
        };
      }
    case "stagehand_observe":
      try {
        log(`Starting observation with instruction: ${args.instruction}`);
        const observations = await stagehand.observe({
          instruction: args.instruction,
        });
        log(
          `Observation completed successfully: ${JSON.stringify(observations)}`
        );
        return {
          content: [
            {
              type: "text",
              text: `Observations: ${JSON.stringify(observations)}`,
            },
          ],
          isError: false,
        };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        log(`Observation failed: ${errorMsg}`);
        return {
          content: [
            {
              type: "text",
              text: `Failed to observe: ${errorMsg}`,
            },
            {
              type: "text",
              text: `Operation logs:\n${operationLogs.join("\n")}`,
            },
          ],
          isError: true,
        };
      }

    default:
      log(`Unknown tool called: ${name}`);
      return {
        content: [
          {
            type: "text",
            text: `Unknown tool: ${name}`,
          },
          {
            type: "text",
            text: `Operation logs:\n${operationLogs.join("\n")}`,
          },
        ],
        isError: true,
      };
  }
}

// Create the server
const server = new Server(
  {
    name: "stagehand",
    version: "0.1.0",
  },
  {
    capabilities: {
      resources: {},
      tools: {},
    },
  }
);

// Setup request handlers
server.setRequestHandler(ListToolsRequestSchema, async (request) => {
  try {
    logRequest('ListTools', request.params);
    const response = { tools: TOOLS };
    const sanitizedResponse = sanitizeMessage(response);
    logResponse('ListTools', JSON.parse(sanitizedResponse));
    return JSON.parse(sanitizedResponse);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    log(`ListTools handler error: ${errorMsg}`, 'error');
    return {
      error: {
        code: -32603,
        message: `Internal error: ${errorMsg}`,
      },
    };
  }
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    logRequest('CallTool', request.params);
    operationLogs.length = 0; // Clear logs for new operation
    
    if (!request.params?.name || !TOOLS.find(t => t.name === request.params.name)) {
      throw new Error(`Invalid tool name: ${request.params?.name}`);
    }

    const result = await handleToolCall(
      request.params.name,
      request.params.arguments ?? {}
    );

    const sanitizedResult = sanitizeMessage(result);
    logResponse('CallTool', JSON.parse(sanitizedResult));
    return JSON.parse(sanitizedResult);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    log(`CallTool handler error: ${errorMsg}`, 'error');
    return {
      error: {
        code: -32603,
        message: `Internal error: ${errorMsg}`,
      },
    };
  }
});

// Run the server
async function runServer() {
  log("Starting Stagehand MCP server...", 'info');
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("Server started successfully", 'info');
}

runServer().catch((error) => {
  const errorMsg = error instanceof Error ? error.message : String(error);
  log(`Server error: ${errorMsg}`, 'error');
  console.error(error);
});
