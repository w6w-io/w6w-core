import {
  COMPLETION_OUTPUT_DIALECTS,
  type CompletionErrorCode,
  type CompletionStreamTextDelta,
  type CompletionStreamToolCallDelta,
  type CompletionUsageSummary,
  MODEL_CAPABILITIES,
  MODEL_COMPLETION_CONTRACT_VERSION,
  MODEL_COMPLETION_STREAM_EVENTS,
  type ModelCompletionEnvelope,
  type ModelCompletionInvocationFrame,
  type ModelCompletionRequest,
  type ModelCompletionStreamEvent,
  type ModelCompletionStreamEventName,
  type ModelCompletionStreamFinal,
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

Deno.test("stream event names are the pinned 4-tuple", () => {
  eq([...MODEL_COMPLETION_STREAM_EVENTS], ["delta", "tool_call_delta", "final", "error"]);
  eq(MODEL_COMPLETION_STREAM_EVENTS.length, 4);
});

// --- valid stream frames: one of each, exactly as the wire pins them -------------------------

const usageSummary: CompletionUsageSummary = {
  inclusiveInputTokens: 12,
  freshInputTokens: 8,
  cacheReadTokens: 4,
  cacheWriteTokens: 0,
  outputTokens: 7,
  reasoningTokens: null,
  totalTokens: 19,
  source: "reported",
};

const envelopeBase: ModelCompletionEnvelope = {
  contractVersion: 1,
  route: null,
  provider: "openai",
  key: "conn-1",
  model: "gpt-x",
  dialect: "bridge",
  usage: { inputTokens: 12, outputTokens: 7, totalTokens: 19 },
  meta: { requestId: "req-1" },
};

const succeededFrame = {
  invocationId: "inv-1",
  status: "succeeded",
  startedAt: "2026-11-15T00:00:00.000Z",
  finishedAt: "2026-11-15T00:00:01.250Z",
  durationMs: 1250,
} as const satisfies ModelCompletionInvocationFrame;

const failedFrame = {
  invocationId: "inv-1",
  status: "failed",
  startedAt: "2026-11-15T00:00:00.000Z",
  finishedAt: "2026-11-15T00:00:00.500Z",
  durationMs: 500,
} as const satisfies ModelCompletionInvocationFrame;

const deltaFrame: CompletionStreamTextDelta = { type: "delta", choice: 0, text: "Hel" };

/** First fragment of a call: `id`/`name`, no argument text yet. */
const toolCallHead: CompletionStreamToolCallDelta = {
  type: "tool_call_delta",
  choice: 0,
  index: 0,
  id: "call_1",
  name: "lookup",
  arguments: "",
};

/** A later fragment: argument text only, `""` allowed. */
const toolCallTail: CompletionStreamToolCallDelta = {
  type: "tool_call_delta",
  choice: 0,
  index: 0,
  arguments: '{"q":"x"}',
};

const finalFrame: ModelCompletionStreamFinal = {
  ...envelopeBase,
  ...succeededFrame,
  type: "final",
  usageSummary,
};

const errorFrame: ModelCompletionStreamEvent = {
  ...failedFrame,
  type: "error",
  error: { code: "model_provider_failed", message: "upstream closed the stream" },
};

/** The discriminated union is exhaustive over exactly the four event names. */
function describeEvent(e: ModelCompletionStreamEvent): string {
  switch (e.type) {
    case "delta":
      return `delta:${e.choice}:${e.text}`;
    case "tool_call_delta":
      return `tool_call_delta:${e.choice}:${e.index}:${e.arguments}`;
    case "final":
      return `final:${e.invocationId}:${e.usageSummary.totalTokens}`;
    case "error":
      return `error:${e.invocationId}:${e.error.code}`;
    default: {
      const unreachable: never = e;
      return unreachable;
    }
  }
}

/** A terminal's `type` always equals the SSE event name it is carried under. */
function eventName(e: ModelCompletionStreamEvent): ModelCompletionStreamEventName {
  return e.type;
}

Deno.test("valid frames carry the pinned discriminants", () => {
  const events: ModelCompletionStreamEvent[] = [
    deltaFrame,
    toolCallHead,
    toolCallTail,
    finalFrame,
    errorFrame,
  ];
  eq(events.map(eventName), [
    "delta",
    "tool_call_delta",
    "tool_call_delta",
    "final",
    "error",
  ]);
  eq(describeEvent(finalFrame), "final:inv-1:19");
  eq(describeEvent(errorFrame), "error:inv-1:model_provider_failed");
  eq(finalFrame.usageSummary.source, "reported");
  eq(toolCallHead.arguments, "");
});

// --- type fixtures: each block below must stay a real compile error --------------------------

// @ts-expect-error `final` always carries `usageSummary`
const finalWithoutUsageSummary: ModelCompletionStreamEvent = {
  ...envelopeBase,
  ...succeededFrame,
  type: "final",
};

const failedFinal: ModelCompletionStreamEvent = {
  ...envelopeBase,
  ...succeededFrame,
  type: "final",
  // @ts-expect-error `final` is always `status: "succeeded"`; failures use `error`
  status: "failed",
  usageSummary,
};

// @ts-expect-error `arguments` is always present (a `""` fragment is allowed)
const toolCallWithoutArguments: ModelCompletionStreamEvent = {
  type: "tool_call_delta",
  choice: 0,
  index: 0,
  id: "call_1",
  name: "lookup",
};

// @ts-expect-error a `delta` always carries its `choice`
const deltaWithoutChoice: ModelCompletionStreamEvent = { type: "delta", text: "Hel" };

// @ts-expect-error the `error` terminal carries the invocation frame (`invocationId` included)
const errorWithoutInvocationId: ModelCompletionStreamEvent = {
  type: "error",
  status: "failed",
  startedAt: "2026-11-15T00:00:00.000Z",
  finishedAt: "2026-11-15T00:00:00.500Z",
  durationMs: 500,
  error: { code: "model_provider_failed", message: "boom" },
};

// @ts-expect-error `done` is not a stream event
const unknownEventType: ModelCompletionStreamEvent = { type: "done" };

Deno.test("type fixtures stay runtime objects", () => {
  const rejected: unknown[] = [
    finalWithoutUsageSummary,
    failedFinal,
    toolCallWithoutArguments,
    deltaWithoutChoice,
    errorWithoutInvocationId,
    unknownEventType,
  ];
  eq(rejected.length, 6);
});
