/**
 * One chat-completions call, answered by Claude through Anthropic's own SDK.
 *
 * The browser's agent loop speaks one wire format (OpenAI chat completions),
 * because a second format would be a second loop to keep honest. An owner with
 * an Anthropic key still has to be served, so the translation happens HERE, at
 * the one place that holds their key — against the Messages API proper, not an
 * OpenAI-compatibility endpoint, so thinking, tool use and refusals behave the
 * way Anthropic documents them.
 *
 * Thinking blocks have to be replayed unchanged on the next turn, and the
 * chat-completions shape has nowhere to put them. So the assistant message we
 * return carries the raw content blocks in `anthropic_content`; the loop sends
 * its history back verbatim, and when that field is present it is used as-is
 * instead of being rebuilt from `content` and `tool_calls`.
 */
import Anthropic from "@anthropic-ai/sdk";

import { anthropicClient } from "./byok.js";

/** Chosen for the owner: they are asked for a key, not a model. */
export const ANTHROPIC_MODEL = "claude-opus-5";
/** Non-streaming, so bounded by the HTTP timeout rather than by the model. */
const MAX_TOKENS = 16_000;

type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: unknown;
  tool_calls?: { id: string; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
  anthropic_content?: Anthropic.Beta.BetaContentBlockParam[];
};
type ChatTool = { function: { name: string; description?: string; parameters?: Record<string, unknown> } };
export type ChatRequest = { messages?: ChatMessage[]; tools?: ChatTool[] };

const text = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("")
      : "";

function parseArguments(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** chat-completions history -> Messages API `system` + `messages`. */
export function toAnthropic(request: ChatRequest): { system: string; messages: Anthropic.Beta.BetaMessageParam[]; tools: Anthropic.Beta.BetaTool[] } {
  const system: string[] = [];
  const messages: Anthropic.Beta.BetaMessageParam[] = [];
  for (const message of request.messages ?? []) {
    if (message.role === "system") {
      system.push(text(message.content));
    } else if (message.role === "user") {
      messages.push({ role: "user", content: text(message.content) || " " });
    } else if (message.role === "assistant") {
      if (message.anthropic_content?.length) {
        messages.push({ role: "assistant", content: message.anthropic_content });
        continue;
      }
      const blocks: Anthropic.Beta.BetaContentBlockParam[] = [];
      if (text(message.content)) blocks.push({ type: "text", text: text(message.content) });
      for (const call of message.tool_calls ?? []) {
        blocks.push({ type: "tool_use", id: call.id, name: call.function.name, input: parseArguments(call.function.arguments) });
      }
      if (blocks.length) messages.push({ role: "assistant", content: blocks });
    } else if (message.role === "tool") {
      const result: Anthropic.Beta.BetaToolResultBlockParam = { type: "tool_result", tool_use_id: message.tool_call_id ?? "", content: text(message.content) };
      // Every result of one assistant turn goes back in ONE user message:
      // splitting them teaches the model to stop calling tools in parallel.
      const last = messages[messages.length - 1];
      if (last?.role === "user" && Array.isArray(last.content) && last.content.every((block) => block.type === "tool_result")) {
        last.content.push(result);
      } else {
        messages.push({ role: "user", content: [result] });
      }
    }
  }
  const tools = (request.tools ?? []).map((tool) => ({
    name: tool.function.name,
    description: tool.function.description ?? "",
    input_schema: { type: "object" as const, ...(tool.function.parameters ?? {}) },
  }));
  return { system: system.filter(Boolean).join("\n\n"), messages, tools };
}

const FINISH: Record<string, string> = { end_turn: "stop", tool_use: "tool_calls", max_tokens: "length", stop_sequence: "stop", refusal: "content_filter" };

/** A Messages API reply, in the shape the agent loop reads. */
export function toChatCompletion(reply: Anthropic.Beta.BetaMessage) {
  const said = reply.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
  const calls = reply.content.flatMap((block) =>
    block.type === "tool_use"
      ? [{ id: block.id, type: "function" as const, function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) } }]
      : [],
  );
  const refused = reply.stop_reason === "refusal";
  return {
    id: reply.id,
    object: "chat.completion",
    model: reply.model,
    provider: "anthropic",
    choices: [
      {
        index: 0,
        finish_reason: FINISH[reply.stop_reason ?? "end_turn"] ?? "stop",
        message: {
          role: "assistant",
          content: refused ? said || "The model declined this request." : said,
          ...(calls.length ? { tool_calls: calls } : {}),
          // Replayed verbatim next turn — see the note at the top of this file.
          anthropic_content: reply.content,
        },
      },
    ],
    usage: { prompt_tokens: reply.usage.input_tokens, completion_tokens: reply.usage.output_tokens },
  };
}

/** The provider's refusal, status and words intact, in the error shape the app
 *  already knows how to explain ("that key was rejected", "out of quota"). */
function failure(error: unknown): Response {
  if (error instanceof Anthropic.APIError) {
    const type =
      error instanceof Anthropic.AuthenticationError ? "authentication_error"
      : error instanceof Anthropic.RateLimitError ? "rate_limit_error"
      : error instanceof Anthropic.BadRequestError ? "invalid_request_error"
      : "api_error";
    return Response.json({ error: { type, message: error.message, provider: "anthropic" } }, { status: error.status ?? 502 });
  }
  return Response.json({ error: { type: "api_error", message: "Could not reach Anthropic.", provider: "anthropic" } }, { status: 502 });
}

export async function anthropicChat(secret: string, request: ChatRequest): Promise<Response> {
  const { system, messages, tools } = toAnthropic(request);
  try {
    const reply = await anthropicClient(secret).beta.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: MAX_TOKENS,
      // Thinking is adaptive by default on this model; left that way, because
      // switching it off is what makes it write tool calls as prose.
      ...(system ? { system } : {}),
      messages,
      ...(tools.length ? { tools } : {}),
      // A policy decline re-runs the same request on the model's default
      // fallback inside this call, instead of ending the owner's teach.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    return Response.json(toChatCompletion(reply));
  } catch (error) {
    return failure(error);
  }
}
