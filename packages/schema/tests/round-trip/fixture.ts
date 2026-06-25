/**
 * The canonical App manifest fixture used by every round-trip test. It exercises
 * the full surface a serialization format needs to preserve: nested objects,
 * arrays of objects, mixed-type arrays, kebab-case keys, URLs, hex colors,
 * dates-as-strings, numbers, booleans. The same logical value must round-trip
 * losslessly through every supported format.
 */
export const APP_FIXTURE = {
  manifestVersion: "1",
  id: "com.acme.slack",
  name: "slack",
  displayName: "Slack",
  version: "1.4.2",
  appVersion: "2024-10-22",
  classification: {
    maturity: "beta",
    visibility: "public",
  },
  description: "Send messages and react to events in Slack workspaces.",
  categories: ["communication", "productivity"],
  keywords: ["chat", "messaging", "team"],
  appearance: {
    icon: {
      svg: "./assets/icon.svg",
      sizes: {
        "16x16": "./assets/icon-16.png",
        "128x128": "./assets/icon-128.png",
      },
    },
    brandColor: "#4A154B",
  },
  author: {
    name: "Acme Integrations",
    email: "support@acme.example",
    url: "https://acme.example",
  },
  license: "MIT",
  network: {
    allow: ["slack.com", "api.slack.com"],
  },
} as const;
