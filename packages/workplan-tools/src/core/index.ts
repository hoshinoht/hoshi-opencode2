// SPDX-License-Identifier: GPL-3.0-or-later
// Barrel for the workplan core: tool definitions, schemas and shared runtime types.
import { workplan_checkpoint } from "./checkpoint";
import { workplan_compact } from "./compact";
import { workplan_create } from "./create";
import { workplan_doctor } from "./doctor";
import { workplan_inspect } from "./inspect";
import { workplan_list } from "./list";
import { workplan_patch } from "./patch";
import { workplan_read } from "./read";
import { workplan_reset } from "./reset";
import { workplan_resume } from "./resume";
import { workplan_update } from "./update";
import { workplan_validate } from "./validate";

export {
  workplan_checkpoint,
  workplan_compact,
  workplan_create,
  workplan_doctor,
  workplan_inspect,
  workplan_list,
  workplan_patch,
  workplan_read,
  workplan_reset,
  workplan_resume,
  workplan_update,
  workplan_validate,
};

export const workplanToolDefinitions = {
  workplan_create,
  workplan_update,
  workplan_patch,
  workplan_reset,
  workplan_checkpoint,
  workplan_compact,
  workplan_resume,
  workplan_read,
  workplan_inspect,
  workplan_list,
  workplan_validate,
  workplan_doctor,
} as const;

export {
  createNativeWorkplanInputSchema,
  formatWorkplanInputError,
  nativeWorkplanInputSchemas,
  parseWorkplanToolInput,
  validateWorkplanStructure,
  workplanInputJsonSchema,
  workplanInputSchemas,
  workplanToolArgs,
} from "./schemas";
export { WorkplanMutationAbortedError, WorkplanRecoveryRequiredError } from "./transaction";
export type { MutationResult, MutationTarget, WorkplanMutationIntent, WorkplanMutationInvocation } from "./transaction";
export { readWorkplanSnapshot } from "./snapshot";
export type { WorkplanSnapshot } from "./snapshot";
export type { WorkplanDoctorRuntimeFacts } from "./doctor";
export { defineWorkplanTool } from "./tool";
export type { WorkplanToolContext, WorkplanToolResult } from "./tool";
