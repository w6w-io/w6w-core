# Categories

**Status:** Final
**Author:** Segev Shmueli
**Date:** 2026-06-01

The controlled vocabulary for App `categories`. An [App](./app.md) MUST declare 1–3 entries; hosts SHOULD warn on out-of-vocabulary entries but MAY accept them (private hosts may extend the taxonomy without forking the spec).

## Vocabulary

| Slug | Label | Examples |
|---|---|---|
| `ai` | AI & Machine Learning | Anthropic, OpenAI, Hugging Face, Replicate |
| `analytics` | Analytics & BI | Amplitude, Mixpanel, Looker, Metabase |
| `calendar` | Calendar & Scheduling | Google Calendar, Cal.com, Calendly |
| `cms` | Content Management | Sanity, Contentful, WordPress, Notion |
| `communication` | Communication | Slack, Discord, Microsoft Teams, Twilio |
| `commerce` | Commerce & Payments | Shopify, Stripe, PayPal, WooCommerce |
| `crm` | Customer Relationship Management | Salesforce, HubSpot, Pipedrive |
| `databases` | Databases | Postgres, MySQL, MongoDB, Supabase |
| `data-warehousing` | Data Warehousing & ETL | Snowflake, BigQuery, Fivetran, dbt |
| `developer-tools` | Developer Tools | GitHub, GitLab, Linear, Jira, Sentry |
| `devops` | DevOps & Infrastructure | AWS, GCP, Vercel, Cloudflare, Datadog |
| `documents` | Documents & Files | Google Drive, Dropbox, Box, OneDrive |
| `email` | Email | Gmail, SendGrid, Postmark, Resend |
| `finance` | Finance & Accounting | QuickBooks, Xero, Plaid |
| `forms` | Forms & Surveys | Typeform, Google Forms, SurveyMonkey |
| `hr` | Human Resources | BambooHR, Workday, Greenhouse, Rippling |
| `iot` | IoT & Hardware | Home Assistant, Particle, MQTT brokers |
| `legal` | Legal & Compliance | DocuSign, Ironclad, Vanta |
| `marketing` | Marketing | Mailchimp, ActiveCampaign, Klaviyo |
| `monitoring` | Monitoring & Observability | Datadog, Grafana, PagerDuty, New Relic |
| `productivity` | Productivity | Notion, Asana, Todoist, Trello |
| `project-management` | Project Management | Jira, Linear, Asana, Monday |
| `search` | Search | Algolia, Meilisearch, Elasticsearch |
| `security` | Security & Identity | Auth0, Okta, 1Password, Snyk |
| `social-media` | Social Media | X, LinkedIn, Bluesky, Mastodon |
| `spreadsheets` | Spreadsheets | Google Sheets, Airtable, Excel |
| `storage` | Storage | S3, R2, GCS, Azure Blob |
| `support` | Customer Support | Zendesk, Intercom, Help Scout, Front |
| `version-control` | Version Control | GitHub, GitLab, Bitbucket |
| `video` | Video & Streaming | Zoom, Loom, YouTube, Mux, Vimeo |
| `other` | Other | Use only when no other slug fits. |

## Rules

1. **1–3 entries.** Validators reject `categories` arrays outside this range.
2. **Order matters.** The first entry is the primary category — hosts SHOULD use it as the default marketplace bucket. The remaining entries are secondary tags.
3. **Slugs are stable.** A slug never changes its meaning. New slugs are added by editing this file and bumping the App `manifestVersion` only if existing apps need to migrate.
4. **`other` is a last resort.** If `other` is being used widely for a single concept, that concept earns its own slug in a follow-up.
5. **Out-of-vocabulary values** are not an error — hosts MAY accept them — but they SHOULD log a warning so the vocabulary can grow.

## Evolution

This file is part of the spec. Changes go through the same RFC process. Adding a slug is **non-breaking**; renaming or removing one is **breaking** and requires a `manifestVersion` bump with a migration note.
