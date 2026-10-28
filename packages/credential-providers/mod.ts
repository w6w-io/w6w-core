export {
  type CredentialErrorDetails,
  GOOGLE_TOKEN_ENDPOINT,
  type GoogleServiceAccountSource,
  googleServiceAccountV1,
} from "./src/google-service-account.ts";
export { normaliseLegacyGoogleServiceAccount } from "./src/normalise-legacy-google.ts";
export { createCredentialProviderRegistry, defaultCredentialProviders } from "./src/registry.ts";
