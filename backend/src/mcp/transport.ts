/**
 * External MCP transport (issue #9): stateless JSON-RPC 2.0 over one HTTP
 * POST, implementing the "Stateless Core" profile of the project's MCP
 * security spec. Framing only — every policy decision stays in the gateway.
 *
 * Contract (pinned by backend/tests/mcp-transport.test.ts):
 * - HTTP 401 only for a missing, malformed or unresolvable bearer token on
 *   `tools/call` (the one authenticated method).
 * - HTTP 400 for a malformed JSON-RPC body; batches are rejected because this
 *   stateless core serves exactly one request per POST.
 * - HTTP 200 otherwise. Tool and policy failures are JSON-RPC *results* with
 *   `isError: true` and the gateway's typed `data.errorCode`, never HTTP
 *   errors — an engine rejection must not look like a transport failure.
 * - `initialize`, `tools/list` and `ping` are unauthenticated: they expose
 *   protocol metadata and the public catalog only.
 */

import { toolCatalog, type McpToolDescriptor } from './catalog.ts';
import type { McpGateway } from './McpGateway.ts';

export const MCP_SERVER_INFO = { name: 'gigaforge-mcp', version: 1 } as const;
export const MCP_PROTOCOL_VERSION = '2026-07-28';

export interface McpTransportInput {
  readonly gateway: Pick<McpGateway, 'invokeTool'>;
  /** Resolves whether a bearer token is a live, stored grant. */
  readonly resolveBearer: (token: string) => boolean;
  readonly bearer: string | undefined;
  readonly body: unknown;
}

export interface McpTransportResponse {
  readonly status: number;
  readonly json: unknown;
}

interface JsonRpcRequest {
  readonly jsonrpc: '2.0';
  readonly id?: number | string | null;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

function isJsonRpcRequest(body: unknown): body is JsonRpcRequest {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return false;
  const candidate = body as Record<string, unknown>;
  return candidate.jsonrpc === '2.0' && typeof candidate.method === 'string';
}

function result(id: number | string | null, result: unknown): McpTransportResponse {
  return { status: 200, json: { jsonrpc: '2.0', id, result } };
}

function error(
  id: number | string | null,
  code: number,
  message: string,
  data?: unknown,
): McpTransportResponse {
  return { status: 200, json: { jsonrpc: '2.0', id, error: { code, message, data } } };
}

function toolResult(
  id: number | string | null,
  outcome: { success: boolean; data?: unknown; errorMessage?: string; errorCode?: string },
): McpTransportResponse {
  const text = outcome.success ? JSON.stringify(outcome.data ?? {}) : (outcome.errorMessage ?? 'Unknown error');
  const payload: Record<string, unknown> = {
    content: [{ type: 'text', text }],
    isError: !outcome.success,
  };
  if (!outcome.success && outcome.errorCode) payload.errorCode = outcome.errorCode;
  return result(id, payload);
}

export async function handleMcpPost(input: McpTransportInput): Promise<McpTransportResponse> {
  if (!isJsonRpcRequest(input.body)) {
    return { status: 400, json: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid JSON-RPC request' } } };
  }
  const request = input.body;
  const id = request.id ?? null;

  switch (request.method) {
    case 'initialize': {
      const requested = (request.params as { protocolVersion?: string } | undefined)?.protocolVersion;
      return result(id, {
        protocolVersion: requested === MCP_PROTOCOL_VERSION ? requested : MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: MCP_SERVER_INFO,
      });
    }
    case 'tools/list': {
      return result(id, { tools: toolCatalog() });
    }
    case 'ping': {
      return result(id, {});
    }
    case 'tools/call': {
      const bearer = input.bearer;
      if (typeof bearer !== 'string' || !bearer.startsWith('gf_mcp_') || !input.resolveBearer(bearer)) {
        return { status: 401, json: { jsonrpc: '2.0', id, error: { code: -32001, message: 'A valid MCP bearer token is required.' } } };
      }
      const params = request.params as { name?: unknown; arguments?: unknown } | undefined;
      if (typeof params?.name !== 'string') {
        return error(id, -32602, 'tools/call requires a tool name');
      }
      const outcome = await input.gateway.invokeTool(
        bearer,
        params.name,
        (params.arguments ?? {}) as Record<string, unknown>,
      );
      return toolResult(id, outcome);
    }
    default:
      return error(id, -32601, `Method not found: ${request.method}`);
  }
}

export type { McpToolDescriptor };
