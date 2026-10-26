import {
  COMPLETION_OUTPUT_DIALECTS,
  type CompletionErrorCode,
  MODEL_CAPABILITIES,
  MODEL_COMPLETION_CONTRACT_VERSION,
  type ModelCompletionEnvelope,
  type ModelCompletionRequest,
} from "../mod.ts";

function eq(a: unknown, b: unknown) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }
}

Deno.test("pinned constants", () => {
  eq(MODEL_COMPLETION_CONTRACT_VERSION, 1);
  eq([...COMPLETION_OUTPUT_DIALECTS], ["bridge", "openai", "anthropic", "ollama"]);
  eq([...MODEL_CAPABILITIES], ["toolCalls", "structuredOutput", "streaming"]);
});

Deno.test("types compose", () => {
  const req: ModelCompletionRequest = {
    messages: [{ role: "user", content: "hi" }],
    stream: false,
  };
  const code: CompletionErrorCode = "model_request_unsupported";
  const env: ModelCompletionEnvelope = {
    contractVersion: 1,
    route: null,
    provider: "p",
    key: "k",
    model: "m",
    dialect: "bridge",
    usage: { inputTokens: null, outputTokens: null, totalTokens: null },
    meta: {},
  };
  eq(req.messages.length + code.length > 0, true);
  eq(env.route, null);
});
