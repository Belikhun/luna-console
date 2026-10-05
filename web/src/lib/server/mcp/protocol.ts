// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * The MCP server, as a JSON-RPC dispatcher with no transport of its own.
 *
 * Hand-rolled rather than built on the SDK because the stateless subset luna
 * serves is small (initialize, ping, tools, prompts, resources) and the stack is
 * locked; a dependency that drags in its own schema library for ten methods is
 * a poor trade. The transport (`/api/mcp`) hands every parsed message here with
 * the principal it already authorized and gets back the response to send, or
 * null for a notification.
 *
 * Every `tools/call` is checked against the token's scope **here**, at the call,
 * not at `tools/list`: a client that cached the list before a scope was
 * narrowed must still be refused.
 */

import { knowledgeFor, mcpInstructions, mcpServerVersion, recordMcpCall } from '$core/mcp';
import type { McpOnBehalfOf, McpPrincipal } from '$core/mcp';
import { mcpTool, scopeCoversInstance, validateMcpArgs } from '$shared/mcptools';
import { TOOL_HANDLERS, ToolError } from './handlers';
import type { ToolArgs } from './handlers';

/** Protocol revisions this server speaks, newest first. */
export const MCP_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26'];

/** The `_meta` key a client uses to say who a call is on behalf of. */
export const ON_BEHALF_OF_META = 'dev.belikhun.luna/onBehalfOf';

/** Longest tool result returned in one piece; past it the text is cut and says so. */
const MAX_RESULT_CHARS = 60_000;

export interface JsonRpcRequest {
	jsonrpc: '2.0';
	id?: string | number | null;
	method: string;
	params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
	jsonrpc: '2.0';
	id: string | number | null;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

/** What the transport knows about the request the message arrived in. */
export interface RequestContext {
	principal: McpPrincipal;
	ip?: string;
	/** `clientInfo` from the session's initialize, when the client sends it as a header */
	client?: string;
}

export const RPC_PARSE_ERROR = -32700;
export const RPC_INVALID_REQUEST = -32600;
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INVALID_PARAMS = -32602;
export const RPC_INTERNAL_ERROR = -32603;

function reply(id: JsonRpcRequest['id'], result: unknown): JsonRpcResponse {
	return { jsonrpc: '2.0', id: id ?? null, result };
}

function fail(id: JsonRpcRequest['id'], code: number, message: string): JsonRpcResponse {
	return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

/** Whether a parsed value is shaped like a JSON-RPC request or notification. */
export function isJsonRpcMessage(value: unknown): value is JsonRpcRequest {
	if (typeof value !== 'object' || value === null) {
		return false;
	}

	const record = value as Record<string, unknown>;

	return record.jsonrpc === '2.0' && typeof record.method === 'string';
}

function textResult(payload: unknown, isError = false): Record<string, unknown> {
	let text = typeof payload === 'string'
		? payload
		: JSON.stringify(payload, null, 1);

	if (text.length > MAX_RESULT_CHARS) {
		text = `${text.slice(0, MAX_RESULT_CHARS)}\n… [truncated: ${text.length - MAX_RESULT_CHARS} more characters]`;
	}

	return { content: [{ type: 'text', text }], isError };
}

function onBehalfOf(params: Record<string, unknown> | undefined): McpOnBehalfOf | undefined {
	const meta = params?._meta;

	if (typeof meta !== 'object' || meta === null) {
		return undefined;
	}

	const value = (meta as Record<string, unknown>)[ON_BEHALF_OF_META];

	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return undefined;
	}

	// recorded, never trusted: it is whatever the client claims, capped so a client
	// cannot grow the call log with it
	const text = JSON.stringify(value);

	return text.length > 1024
		? { label: text.slice(0, 1024) }
		: (value as McpOnBehalfOf);
}

async function initialize(request: JsonRpcRequest, ctx: RequestContext): Promise<JsonRpcResponse> {
	const asked = typeof request.params?.protocolVersion === 'string'
		? request.params.protocolVersion
		: '';
	const protocolVersion = MCP_PROTOCOL_VERSIONS.includes(asked)
		? asked
		: MCP_PROTOCOL_VERSIONS[0];
	const [instructions, version] = await Promise.all([mcpInstructions(ctx.principal), mcpServerVersion()]);

	return reply(request.id, {
		protocolVersion,
		capabilities: {
			tools: { listChanged: false },
			prompts: { listChanged: false },
			resources: { listChanged: false, subscribe: false }
		},
		serverInfo: { name: 'luna', title: 'Luna cluster', version },
		...(instructions ? { instructions } : {})
	});
}

function listTools(request: JsonRpcRequest, ctx: RequestContext): JsonRpcResponse {
	const tools = ctx.principal.tools
		.map((name) => mcpTool(name))
		.filter((tool) => tool !== undefined)
		.map((tool) => ({
			name: tool.name,
			description: tool.description,
			inputSchema: tool.inputSchema,
			annotations: tool.annotations
		}));

	return reply(request.id, { tools });
}

async function callTool(request: JsonRpcRequest, ctx: RequestContext): Promise<JsonRpcResponse> {
	const name = typeof request.params?.name === 'string'
		? request.params.name
		: '';
	const args = (request.params?.arguments ?? {}) as ToolArgs;
	const started = performance.now();
	const tool = mcpTool(name);

	const finish = async (ok: boolean, payload: unknown, error?: string): Promise<JsonRpcResponse> => {
		await recordMcpCall({
			token: ctx.principal.id,
			tokenName: ctx.principal.name,
			tool: name || '(none)',
			args,
			ok,
			error,
			durationMs: Math.round(performance.now() - started),
			onBehalfOf: onBehalfOf(request.params),
			client: ctx.client,
			ip: ctx.ip
		});

		return reply(request.id, textResult(payload, !ok));
	};

	// an unknown tool and a tool outside the scope read the same, so the list of
	// what exists is not discoverable by probing names
	if (!tool || !ctx.principal.tools.includes(name)) {
		return await finish(false, `tool "${name}" is not available to this token`, 'not in scope');
	}

	const problem = validateMcpArgs(tool.inputSchema, args);

	if (problem) {
		return await finish(false, `invalid arguments: ${problem}`, problem);
	}

	if (tool.instanceArg) {
		const instance = args[tool.instanceArg];

		if (typeof instance === 'string' && instance !== '' && !scopeCoversInstance(ctx.principal.scope, instance)) {
			return await finish(false, `this token may not reach the instance "${instance}"`, 'instance not in scope');
		}
	}

	const handler = TOOL_HANDLERS[name];

	if (!handler) {
		return await finish(false, `tool "${name}" has no implementation on this build`, 'no handler');
	}

	try {
		const payload = await handler(args, { principal: ctx.principal, actor: `mcp:${ctx.principal.name}` });

		return await finish(true, payload ?? { ok: true });
	} catch (err) {
		const message = err instanceof Error
			? err.message
			: String(err);

		if (!(err instanceof ToolError)) {
			console.error(`[mcp] ${name} failed for ${ctx.principal.name}:`, err);
		}

		return await finish(false, message, message);
	}
}

async function listPrompts(request: JsonRpcRequest, ctx: RequestContext): Promise<JsonRpcResponse> {
	if (!ctx.principal.tools.includes('skill_get')) {
		return reply(request.id, { prompts: [] });
	}

	const skills = await knowledgeFor(ctx.principal.id, 'skill');

	return reply(request.id, {
		prompts: skills.map((skill) => ({ name: skill.title, description: skill.description }))
	});
}

async function getPrompt(request: JsonRpcRequest, ctx: RequestContext): Promise<JsonRpcResponse> {
	const name = request.params?.name;
	const skills = ctx.principal.tools.includes('skill_get')
		? await knowledgeFor(ctx.principal.id, 'skill')
		: [];
	const skill = skills.find((entry) => entry.title === name);

	if (!skill) {
		return fail(request.id, RPC_INVALID_PARAMS, `unknown prompt: ${String(name)}`);
	}

	return reply(request.id, {
		description: skill.description,
		messages: [{ role: 'user', content: { type: 'text', text: skill.body } }]
	});
}

const CONTEXT_URI = 'luna://context/';

async function listResources(request: JsonRpcRequest, ctx: RequestContext): Promise<JsonRpcResponse> {
	if (!ctx.principal.tools.includes('context_get')) {
		return reply(request.id, { resources: [] });
	}

	const items = await knowledgeFor(ctx.principal.id, 'context');

	return reply(request.id, {
		resources: items.map((item) => ({
			uri: `${CONTEXT_URI}${item.id}`,
			name: item.title,
			description: item.description || undefined,
			mimeType: 'text/markdown'
		}))
	});
}

async function readResource(request: JsonRpcRequest, ctx: RequestContext): Promise<JsonRpcResponse> {
	const uri = String(request.params?.uri ?? '');
	const items = ctx.principal.tools.includes('context_get')
		? await knowledgeFor(ctx.principal.id, 'context')
		: [];
	const item = items.find((entry) => `${CONTEXT_URI}${entry.id}` === uri);

	if (!item) {
		return fail(request.id, RPC_INVALID_PARAMS, `unknown resource: ${uri}`);
	}

	return reply(request.id, { contents: [{ uri, mimeType: 'text/markdown', text: item.body }] });
}

/**
 * Answer one message. Returns null for a notification (no id), which the
 * transport acknowledges with 202 and no body.
 */
export async function dispatch(request: JsonRpcRequest, ctx: RequestContext): Promise<JsonRpcResponse | null> {
	const isNotification = request.id === undefined;

	if (isNotification) {
		return null;
	}

	switch (request.method) {
		case 'initialize':
			return await initialize(request, ctx);

		case 'ping':
			return reply(request.id, {});

		case 'tools/list':
			return listTools(request, ctx);

		case 'tools/call':
			return await callTool(request, ctx);

		case 'prompts/list':
			return await listPrompts(request, ctx);

		case 'prompts/get':
			return await getPrompt(request, ctx);

		case 'resources/list':
			return await listResources(request, ctx);

		case 'resources/templates/list':
			return reply(request.id, { resourceTemplates: [] });

		case 'resources/read':
			return await readResource(request, ctx);

		default:
			return fail(request.id, RPC_METHOD_NOT_FOUND, `method not found: ${request.method}`);
	}
}

/** A JSON-RPC error with no request to answer, for the transport's own refusals. */
export function rpcError(code: number, message: string): JsonRpcResponse {
	return fail(null, code, message);
}
