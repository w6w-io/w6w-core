import type { AppDefinition } from "@w6w/types";
import capabilities from "./actions/capabilities.ts";
import readFile from "./actions/read-file.ts";
import createFile from "./actions/create-file.ts";
import createFileRaw from "./actions/create-file-raw.ts";
import sendBinary from "./actions/send-binary.ts";
import evil from "./actions/evil.ts";

export default {
  actions: [capabilities, readFile, createFile, createFileRaw, sendBinary, evil],
} satisfies AppDefinition;
