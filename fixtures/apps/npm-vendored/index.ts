import type { AppDefinition } from "@w6w/types";
import remoteImport from "./actions/remote-import.ts";

export default {
  actions: [remoteImport],
} satisfies AppDefinition;
