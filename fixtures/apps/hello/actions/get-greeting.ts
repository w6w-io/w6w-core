import type { ActionExecuteHook } from "@w6w/types";

interface Input {
  name: string;
  excited?: boolean;
}

interface Output {
  greeting: string;
}

const execute: ActionExecuteHook<Input, Output> = (input, ctx) => {
  ctx.log("info", "building greeting", { name: input.name });
  const punctuation = input.excited ? "!" : ".";
  return { greeting: `Hello, ${input.name}${punctuation}` };
};

export default execute;
