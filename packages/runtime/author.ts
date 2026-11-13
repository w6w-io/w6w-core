/**
 * @w6w/runtime/author — the type-only surface an App author writes against.
 *
 * Everything here is a `export type` re-export of `@w6w/types`, so importing
 * this entry adds nothing to an App's runtime graph: it is the same logical
 * model the host uses, reached without pulling `@w6w/runtime`'s root module.
 *
 * ```ts
 * import type { AppDefinition, ActionDefinition } from "@w6w/runtime/author";
 * ```
 */
export type {
  ActionDefinition,
  ActionExecuteHook,
  AnyActionDefinition,
  AnyTriggerDefinition,
  AppDefinition,
  AuthDefinition,
  AuthHookKind,
  AuthType,
  DynamicOutput,
  HandleIngestHook,
  HealthCheckDefinition,
  HealthCheckHook,
  HealthReport,
  HookContext,
  OnSubscribeHook,
  OnUnsubscribeHook,
  Option,
  OptionsSourceHook,
  Output,
  OutputField,
  OutputSourceHook,
  Param,
  ParamDefinition,
  ParamSection,
  ParseOutputHook,
  PollHook,
  PortCount,
  Ports,
  RefreshHook,
  SignableRequest,
  SignHook,
  TriggerDefinition,
  Validation,
  ValidationHook,
} from "@w6w/types";
