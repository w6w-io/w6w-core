/**
 * Model-provider designation — optional structured metadata an App declares to say
 * "I am a provider of AI models". Designation is NOT runtime support and is never
 * inferred from `categories`; absence of the field means "not designated".
 */

/** What kind of model an app serves. */
export const MODEL_TYPES = [
  "llm",
  "embedding",
  "reranking",
  "image-generation",
  "video-generation",
  "speech-to-text",
  "text-to-speech",
  "audio-generation",
  "moderation",
] as const;

/** Architecture family of the models an app serves. */
export const MODEL_FAMILIES = ["transformer", "diffusion", "flow-matching", "other"] as const;

export type ModelType = typeof MODEL_TYPES[number];
export type ModelFamily = typeof MODEL_FAMILIES[number];

/** The `modelProvider` block of an App manifest. */
export interface ModelProviderMeta {
  /** At least one; unique. */
  modelTypes: ModelType[];
  /** Optional; unique when present. */
  modelFamilies?: ModelFamily[];
}
