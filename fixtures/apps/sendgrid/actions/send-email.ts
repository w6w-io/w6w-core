import type { ActionExecuteHook } from "@w6w/types";

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
const execute: ActionExecuteHook<Input> = async (input, ctx) => {
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
    // Surface what the action can see about the connection — used by tests to
    // prove the credential is NOT among the exposed fields.
    connectionKeys: ctx.connection ? Object.keys(ctx.connection) : [],
  };
};

export default execute;
