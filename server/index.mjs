#!/usr/bin/env node
// Minimal MCP server over stdio (newline-delimited JSON-RPC 2.0).
// No dependencies, so the plugin works right after installation.

import { createInterface } from 'node:readline';
import { tools } from './tools.mjs';
import { VERSION } from './lib/util.mjs';

const SERVER_INFO = { name: 'tools-plus-plus', title: 'tools++', version: VERSION };
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_OUTPUT = 60_000;  // characters; keeps a runaway result from flooding the context

const byName = new Map(tools.map((t) => [t.name, t]));
const listing = tools.map(({ run, ...definition }) => definition);
const inFlight = new Map();  // request id -> AbortController

class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const typeOk = (v, t) => (t === 'integer' ? Number.isInteger(v) : t === 'number' ? typeof v === 'number' && Number.isFinite(v)
  : t === 'array' ? Array.isArray(v) : t === 'object' ? v !== null && typeof v === 'object' && !Array.isArray(v) : typeof v === t);

/** Shallow check of arguments against the tool's schema; null means "not given". */
function checkArgs(schema, raw) {
  if (raw !== undefined && (raw === null || typeof raw !== 'object' || Array.isArray(raw))) throw new Error('arguments must be an object');
  const args = {};
  for (const [k, v] of Object.entries(raw ?? {})) if (v !== null) args[k] = v;
  for (const k of schema.required ?? []) {
    if (args[k] === undefined || args[k] === '') throw new Error(`${k} is required`);
  }
  for (const [k, v] of Object.entries(args)) {
    const prop = schema.properties[k];
    if (!prop) continue;  // unknown keys are ignored, as before
    const types = prop.type ? [].concat(prop.type) : null;
    if (types && !types.some((t) => typeOk(v, t))) throw new Error(`${k} must be ${types.join(' or ')}, got ${Array.isArray(v) ? 'array' : typeof v}`);
    if (prop.enum && !prop.enum.includes(v)) throw new Error(`${k} must be one of: ${prop.enum.join(', ')}`);
    if (Array.isArray(v) && prop.items?.type) {
      const it = [].concat(prop.items.type);
      const bad = v.findIndex((x) => !it.some((t) => typeOk(x, t)));
      if (bad >= 0) throw new Error(`${k}[${bad}] must be ${it.join(' or ')}`);
    }
  }
  return args;
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

async function callTool({ name, arguments: args, _meta } = {}, id) {
  const tool = byName.get(name);
  if (!tool) throw new RpcError(-32602, `Unknown tool: ${name}`);
  const controller = new AbortController();
  inFlight.set(id, controller);
  const token = _meta?.progressToken;
  const ctx = {
    signal: controller.signal,
    progress(progress, total, message) {
      if (token === undefined || controller.signal.aborted) return;
      send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress, total, message } });
    },
  };
  try {
    let text = String(await tool.run(checkArgs(tool.inputSchema, args), ctx));
    if (text.length > MAX_OUTPUT) {
      text = `${text.slice(0, MAX_OUTPUT)}\n… output truncated (${text.length - MAX_OUTPUT} more characters). Narrow the request to see the rest.`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (err) {
    const internal = !(err instanceof Error) || ['TypeError', 'RangeError', 'ReferenceError'].includes(err.name);
    if (internal) process.stderr.write(`[tools-plus-plus] ${name}: ${err?.stack ?? err}\n`);
    return { content: [{ type: 'text', text: `Error: ${err?.message ?? err}` }], isError: true };
  } finally {
    inFlight.delete(id);
  }
}

const handlers = {
  initialize: ({ protocolVersion } = {}) => ({
    protocolVersion: PROTOCOL_VERSIONS.includes(protocolVersion) ? protocolVersion : PROTOCOL_VERSIONS[0],
    capabilities: { tools: { listChanged: false } },
    serverInfo: SERVER_INFO,
    instructions: 'Prefer these tools over mental math, guessed dates and throwaway scripts.',
  }),
  ping: () => ({}),
  'tools/list': () => ({ tools: listing }),
  'tools/call': callTool,
};

async function handle(msg) {
  if (msg === null || typeof msg !== 'object' || msg.jsonrpc !== '2.0') {
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } };
  }
  const isRequest = msg.id !== undefined && msg.id !== null;
  if (!isRequest) {
    if (msg.method === 'notifications/cancelled') inFlight.get(msg.params?.requestId)?.abort();
    return null;  // notifications need no reply
  }
  const handler = handlers[msg.method];
  if (!handler) return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } };
  try {
    const result = await handler(msg.params, msg.id);
    return { jsonrpc: '2.0', id: msg.id, result };
  } catch (err) {
    return { jsonrpc: '2.0', id: msg.id, error: { code: err.code ?? -32603, message: err.message } };
  }
}

createInterface({ input: process.stdin }).on('line', async (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (Array.isArray(msg)) {
    const replies = (await Promise.all(msg.map(handle))).filter(Boolean);
    if (replies.length) send(replies);
  } else {
    const reply = await handle(msg);
    if (reply) send(reply);
  }
});

// A crash in one tool must not take the whole server down.
process.on('uncaughtException', (err) => process.stderr.write(`[tools-plus-plus] uncaught: ${err.stack}\n`));
process.on('unhandledRejection', (err) => process.stderr.write(`[tools-plus-plus] unhandled: ${err?.stack ?? err}\n`));
