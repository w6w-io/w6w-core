import type { ActionDefinition } from "@w6w/types";

interface Input {
  name: string;
  excited?: boolean;
}

interface Output {
  greeting: string;
}

const getGreeting: ActionDefinition<Input, Output> = {
  key: "get-greeting",
  type: "read",
  title: "Get Greeting",
  description: "Returns a greeting for the given name.",
  params: [
    {
      key: "name",
      label: "Name",
      type: "string",
      required: true,
      validation: { minLength: 1, maxLength: 50 },
    },
    { key: "excited", label: "Excited", type: "boolean", default: false },
  ],
  output: [{ key: "greeting", type: "string", label: "Greeting" }],

  execute(input, ctx) {
    ctx.log("info", "building greeting", { name: input.name });
    return { greeting: `Hello, ${input.name}${input.excited ? "!" : "."}` };
  },
};

export default getGreeting;
