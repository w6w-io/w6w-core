# @w6w/credential-providers

Host-side credential providers behind the `CredentialProvider` seam from `@w6w/types`. v1 ships one:
`google-service-account.v1` (Google service-account key -> short-lived access token).

Trust model:

- Host-side only and compiled in. Providers are registered in code (`defaultCredentialProviders()`),
  never loaded from app, pack or database data (D-A1).
- Pure and stateless: no cache, no module state, no ambient fetch. A token is minted only through
  the injected `TokenEgress`.
- The destination is pinned to `GOOGLE_TOKEN_ENDPOINT`. The key's `token_uri` is dropped on
  validation and is never a destination.
- Scope and delegation (`sub`) come from the `approved` binding only; the raw `binding` and any
  `scopes` in a stored payload never widen the JWT (D-D2).
- The registry matches contract ids exactly (a `Map`; no case folding, no prefix match).
- Failures are `W6WError(code, "auth", <fixed message>, details)` with `details` limited to
  `retryable`, `status`, an allowlisted `oauthError` and `field`. Upstream bodies and WebCrypto
  errors are never copied into messages or details (D-C5).
- The private key is imported non-extractable and exists only inside one `deriveAuthorization` call.
- `normaliseLegacyGoogleServiceAccount` is the single pure mapper from the 11 legacy app payload
  shapes to `{ source, binding, approved }` (D-D3). Its scope intersection is for the JWT claim;
  cache keys use `normalizeScopes`.
- `revoke` is not implemented: issued Google tokens cannot be retracted.
