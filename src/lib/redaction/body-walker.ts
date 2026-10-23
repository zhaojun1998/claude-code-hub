/**
 * Collects the user-content strings of an outbound request body in any supported wire
 * format (Anthropic Messages, OpenAI Chat, OpenAI Responses / Codex, Gemini).
 *
 * Protocol fields (ids, roles, signatures, binary payloads) are never touched: changing them
 * would break tool pairing, thinking signatures or media decoding upstream. Tool call
 * arguments are treated as data, so every string inside them is visited.
 */

export interface TextSlot {
  path: string;
  text: string;
  set(next: string): void;
}

/** Block types whose content must reach the upstream byte-for-byte. */
const SKIP_BLOCK_TYPES = new Set([
  "image",
  "document",
  "thinking",
  "redacted_thinking",
  "input_image",
  "image_url",
  "input_audio",
  "audio",
  "file",
  "input_file",
  "reasoning",
  "compaction",
]);

/** Keys that hold protocol identifiers, opaque data or binary payloads. */
const SKIP_KEYS = new Set([
  "id",
  "type",
  "role",
  "model",
  "name",
  "status",
  "object",
  "signature",
  "thoughtSignature",
  "thought_signature",
  "encrypted_content",
  "cache_control",
  "citations",
  "media_type",
  "mime_type",
  "mimeType",
  "url",
  "image_url",
  "file_url",
  "audio_url",
  "file_data",
  "fileData",
  "inline_data",
  "inlineData",
  "b64_json",
  "format",
  "detail",
]);

/** Root-level request options that never carry conversation content. */
const SKIP_ROOT_KEYS = new Set([
  "tools",
  "tool_choice",
  "metadata",
  "response_format",
  "text",
  "reasoning",
  "include",
  "stop",
  "stop_sequences",
  "generationConfig",
  "generation_config",
  "toolConfig",
  "tool_config",
  "safetySettings",
  "safety_settings",
  "thinking",
  "output_config",
  "context_management",
  "previous_response_id",
  "prompt_cache_key",
  "service_tier",
  "user",
  "safety_identifier",
]);

/** Tool-call argument containers: every string inside is user data. */
const DATA_KEYS = new Set(["input", "args", "arguments", "response", "partial_json"]);

const TOOL_CALL_TYPES = new Set([
  "tool_use",
  "server_tool_use",
  "mcp_tool_use",
  "function_call",
  "custom_tool_call",
  "local_shell_call",
]);

function isIdentifierKey(key: string): boolean {
  return key.endsWith("_id") || (key.length > 2 && key.endsWith("Id"));
}

function joinPath(base: string, key: string | number): string {
  if (typeof key === "number") return `${base}[${key}]`;
  return base ? `${base}.${key}` : key;
}

export function collectTextSlots(body: unknown): TextSlot[] {
  const slots: TextSlot[] = [];
  if (!body || typeof body !== "object" || Array.isArray(body)) return slots;

  const visit = (
    container: Record<string, unknown> | unknown[],
    key: string | number,
    path: string,
    dataMode: boolean,
    depth: number
  ): void => {
    if (depth > 64) return;
    const node = (container as Record<string | number, unknown>)[key];
    if (typeof node === "string") {
      if (node.length === 0) return;
      slots.push({
        path,
        text: node,
        set(next: string) {
          (container as Record<string | number, unknown>)[key] = next;
        },
      });
      return;
    }
    if (!node || typeof node !== "object") return;

    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        visit(node, i, joinPath(path, i), dataMode, depth + 1);
      }
      return;
    }

    const record = node as Record<string, unknown>;
    if (dataMode) {
      for (const childKey of Object.keys(record)) {
        visit(record, childKey, joinPath(path, childKey), true, depth + 1);
      }
      return;
    }

    const blockType = typeof record.type === "string" ? record.type : null;
    if (blockType && SKIP_BLOCK_TYPES.has(blockType)) return;

    for (const childKey of Object.keys(record)) {
      if (childKey.startsWith("_") || SKIP_KEYS.has(childKey) || isIdentifierKey(childKey)) {
        continue;
      }
      const childData =
        DATA_KEYS.has(childKey) &&
        (childKey !== "input" || (blockType !== null && TOOL_CALL_TYPES.has(blockType)));
      visit(record, childKey, joinPath(path, childKey), childData, depth + 1);
    }
  };

  const root = body as Record<string, unknown>;
  for (const key of Object.keys(root)) {
    if (key.startsWith("_") || SKIP_ROOT_KEYS.has(key) || SKIP_KEYS.has(key)) continue;
    if (isIdentifierKey(key)) continue;
    visit(root, key, key, false, 0);
  }
  return slots;
}
