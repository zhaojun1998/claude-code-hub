import { describe, expect, test } from "vitest";
import { collectTextSlots } from "@/lib/redaction/body-walker";

function paths(body: unknown) {
  return collectTextSlots(body).map((slot) => slot.path);
}

describe("collectTextSlots", () => {
  test("Anthropic Messages body", () => {
    const body = {
      model: "claude-opus-5-5",
      system: [{ type: "text", text: "system prompt", cache_control: { type: "ephemeral" } }],
      metadata: { user_id: "user_abc" },
      tools: [{ name: "Bash", description: "run", input_schema: { type: "object" } }],
      messages: [
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "secret thoughts", signature: "sig" },
            { type: "text", text: "reply" },
            { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls", name: "x" } },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: [{ type: "text", text: "out" }],
            },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
          ],
        },
      ],
    };
    expect(paths(body)).toEqual([
      "system[0].text",
      "messages[0].content",
      "messages[1].content[1].text",
      "messages[1].content[2].input.command",
      "messages[1].content[2].input.name",
      "messages[2].content[0].content[0].text",
    ]);
  });

  test("OpenAI chat and Responses bodies", () => {
    expect(
      paths({
        model: "gpt",
        user: "u-1",
        messages: [
          { role: "system", content: "sys" },
          {
            role: "assistant",
            tool_calls: [
              { id: "c1", type: "function", function: { name: "f", arguments: '{"a":1}' } },
            ],
          },
          { role: "tool", tool_call_id: "c1", content: "result" },
        ],
      })
    ).toEqual([
      "messages[0].content",
      "messages[1].tool_calls[0].function.arguments",
      "messages[2].content",
    ]);

    expect(
      paths({
        model: "gpt",
        instructions: "be nice",
        previous_response_id: "resp_1",
        input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
          {
            type: "reasoning",
            summary: [{ type: "summary_text", text: "x" }],
            encrypted_content: "e",
          },
          { type: "function_call", call_id: "c", name: "f", arguments: "{}" },
          { type: "function_call_output", call_id: "c", output: "done" },
        ],
      })
    ).toEqual([
      "instructions",
      "input[0].content[0].text",
      "input[2].arguments",
      "input[3].output",
    ]);
  });

  test("Gemini body", () => {
    expect(
      paths({
        systemInstruction: { parts: [{ text: "sys" }] },
        generationConfig: { responseMimeType: "application/json" },
        contents: [
          { role: "user", parts: [{ text: "hi" }, { inlineData: { mimeType: "x", data: "AAA" } }] },
          {
            role: "model",
            parts: [{ functionCall: { name: "f", args: { q: "v" } }, thoughtSignature: "s" }],
          },
        ],
      })
    ).toEqual([
      "systemInstruction.parts[0].text",
      "contents[0].parts[0].text",
      "contents[1].parts[0].functionCall.args.q",
    ]);
  });

  test("slots write back in place; non-objects yield nothing", () => {
    const body = { messages: [{ role: "user", content: "a" }], _private: "x" };
    const [slot] = collectTextSlots(body);
    slot.set("b");
    expect(body.messages[0].content).toBe("b");
    expect(collectTextSlots(null)).toEqual([]);
    expect(collectTextSlots([1, 2])).toEqual([]);
    expect(collectTextSlots({ messages: [{ role: "user", content: "" }] })).toEqual([]);
  });

  test("deeply nested input is bounded", () => {
    let node: Record<string, unknown> = { content: "deep" };
    for (let i = 0; i < 100; i++) node = { content: [node] };
    expect(() => collectTextSlots({ messages: [node] })).not.toThrow();
  });
});
