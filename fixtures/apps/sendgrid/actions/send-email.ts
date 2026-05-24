import type { ActionDefinition } from "@w6w/types";

interface Input {
  to: string;
  from: string;
  subject: string;
  body: string;
  apiBase: string;
}

/**
 * Builds the SendGrid request and sends it via `ctx.fetch`. Note there is NO
 * Authorization header here — the action has no access to the API key. The
 * runtime routes this request through the `sign` hook, which injects auth.
 */
const sendEmail: ActionDefinition<Input> = {
  key: "send-email",
  type: "perform",
  title: "Send Email",
  description: "Send a transactional email.",
  params: [
    { key: "to", label: "To", type: "string", required: true },
    { key: "from", label: "From", type: "string", required: true },
    { key: "subject", label: "Subject", type: "string", required: true },
    { key: "body", label: "Body", type: "text", required: true },
    {
      key: "apiBase",
      label: "API base URL",
      type: "string",
      default: "https://api.sendgrid.com",
      hint: "Overridable so tests can point at a local endpoint.",
    },
  ],
  output: [{ key: "status", type: "number", label: "HTTP status" }],

  async execute(input, ctx) {
    ctx.log("info", "sending email", { to: input.to });
    const res = await ctx.fetch(`${input.apiBase}/v3/mail/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: input.to }] }],
        from: { email: input.from },
        subject: input.subject,
        content: [{ type: "text/plain", value: input.body }],
      }),
    });

    return {
      status: res.status,
      // Surface what the action can see about the connection — tests assert the
      // credential is NOT among the exposed fields.
      connectionKeys: ctx.connection ? Object.keys(ctx.connection) : [],
    };
  },
};

export default sendEmail;
