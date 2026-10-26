/**
 * The model-completion contract (`contractVersion: 1`): the provider-neutral, non-streaming
 * request/response shape every host and wrapper agrees on. Structurally mirrors the host's
 * baseline ("bridge") dialect, but core never imports the vendored bridge — a host-side
 * conformance test pins the two together.
 */

/** Bumped only on a breaking change to the shapes below. */
export const MODEL_COMPLETION_CONTRACT_VERSION = 1 as const;

/** Output projections a caller may ask for. `bridge` = the baseline, unprojected. */
export const COMPLETION_OUTPUT_DIALECTS = ["bridge", "openai", "anthropic", "ollama"] as const;
export type CompletionOutputDialect = (typeof COMPLETION_OUTPUT_DIALECTS)[number];

/** Capabilities a request can require of a model. */
export const MODEL_CAPABILITIES = ["toolCalls", "structuredOutput", "streaming"] as const;
export type ModelCapability = (typeof MODEL_CAPABILITIES)[number];

export type CapabilityState = "supported" | "unsupported" | "unknown";

export type CompletionJSONSchema = Record<string, unknown>;
export type CompletionNativeFields = Record<string, Record<string, unknown> | undefined>;

export interface CompletionCacheControl {
  type: "ephemeral";
  ttl?: "5m" | "1h";
}

export type CompletionMediaSource =
  | { type: "url"; url: string }
  | { type: "base64"; mediaType: string; data: string }
  | { type: "file"; id: string };

interface CompletionBlockMetadata {
  cacheControl?: CompletionCacheControl;
  extensions?: CompletionNativeFields;
}

export type CompletionEvaluationAnswer =
  | { type: "boolean"; value: boolean | null; probability?: number }
  | { type: "choice"; value: string; probabilities?: Record<string, number>; confidence?: number }
  | {
    type: "score";
    value: number;
    legend?: Record<string, string>;
    probabilities?: Record<string, number>;
    confidence?: number;
  };

export type CompletionContentBlock =
  & CompletionBlockMetadata
  & (
    | (CompletionBlockMetadata & { id: string } & CompletionEvaluationAnswer)
    | { type: "text"; text: string; citations?: unknown[] }
    | {
      type: "image";
      source: CompletionMediaSource;
      detail?: "auto" | "low" | "high" | "original";
    }
    | { type: "document"; source: CompletionMediaSource; name?: string }
    | { type: "audio"; data: string; format: "wav" | "mp3" }
    | { type: "thinking"; text: string; signature?: string }
    | { type: "redacted-thinking"; data: string }
    | { type: "refusal"; text: string }
    | { type: "tool-call"; id: string; name: string; input: unknown; arguments?: string }
    | {
      type: "tool-result";
      id: string;
      content: string | CompletionContentBlock[];
      isError?: boolean;
    }
    | { type: "native"; dialect: string; value: Record<string, unknown> }
  );

export interface CompletionMessage {
  role: "system" | "developer" | "user" | "assistant";
  content: string | CompletionContentBlock[];
  name?: string;
  extensions?: CompletionNativeFields;
}

export type CompletionTool =
  | {
    type: "function";
    name: string;
    description?: string;
    inputSchema: CompletionJSONSchema;
    strict?: boolean;
    cacheControl?: CompletionCacheControl;
    extensions?: CompletionNativeFields;
  }
  | { type: "native"; dialect: string; value: Record<string, unknown> };

/** The baseline completion input (counterpart of the bridge's `BridgeInput`). */
export interface CompletionInput {
  messages: CompletionMessage[];
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  stop?: string[];
  tools?: CompletionTool[];
  toolChoice?: "auto" | "none" | "required" | { name: string };
  parallelToolCalls?: boolean;
  reasoning?: {
    effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
    mode?: "adaptive" | "enabled" | "disabled";
    budgetTokens?: number;
    display?: "summarized" | "omitted";
  };
  responseFormat?:
    | { type: "text" }
    | { type: "json" }
    | { type: "json-schema"; name: string; schema: CompletionJSONSchema; strict?: boolean };
  cacheControl?: CompletionCacheControl;
  cacheKey?: string;
  cacheRetention?: string;
  seed?: number;
  candidates?: number;
  keepAlive?: string | number;
  runtimeOptions?: Record<string, unknown>;
  extensions?: CompletionNativeFields;
}

/** A request: the baseline input plus the one flag this host rejects (`stream`). */
export type ModelCompletionRequest = CompletionInput & {
  /** Streaming is not supported; `true` fails `model_request_unsupported`. */
  stream?: boolean;
};

/** Counts are inclusive; `null` means the provider did not report the value. */
export interface CompletionUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  cacheWrites?: { fiveMinuteTokens: number; oneHourTokens: number };
  reasoningTokens?: number;
  inputAudioTokens?: number;
  outputAudioTokens?: number;
  acceptedPredictionTokens?: number;
  rejectedPredictionTokens?: number;
  serviceTier?: string;
  inferenceGeo?: string;
  serverToolUsage?: Record<string, unknown>;
  timings?: { totalMs?: number; loadMs?: number; promptMs?: number; generationMs?: number };
  extensions?: CompletionNativeFields;
}

export type CompletionFinishReason =
  | "stop"
  | "length"
  | "tool-calls"
  | "refusal"
  | "content-filter"
  | "pause"
  | "context-limit"
  | "unknown";

export interface CompletionChoice {
  index: number;
  message: CompletionMessage & { role: "assistant" };
  finishReason: CompletionFinishReason;
  stopSequence?: string;
  logprobs?: unknown;
  extensions?: CompletionNativeFields;
}

/** The baseline output (counterpart of the bridge's `BridgeOutput`). */
export interface CompletionOutput<Structured = unknown> {
  id: string;
  model: string;
  createdAt?: string;
  choices: CompletionChoice[];
  usage: CompletionUsage;
  structured?: Structured;
  extensions?: CompletionNativeFields;
}

/** Error codes a completion call can answer with. */
export type CompletionErrorCode =
  | "model_request_invalid"
  | "model_request_unsupported"
  | "model_not_found"
  | "model_provider_failed"
  | "model_budget_exceeded"
  | "model_route_not_found";

/** The response envelope. `output` is the baseline output when `dialect` is `bridge`. */
export interface ModelCompletionEnvelope {
  contractVersion: typeof MODEL_COMPLETION_CONTRACT_VERSION;
  /** The requested route name; `null` on the direct-model path. */
  route: string | null;
  provider: string;
  /** The connection id. */
  key: string;
  /** The provider-native model id. */
  model: string;
  dialect: string;
  output?: unknown;
  usage: CompletionUsage | Record<string, unknown>;
  raw?: unknown;
  meta: Record<string, unknown>;
}
