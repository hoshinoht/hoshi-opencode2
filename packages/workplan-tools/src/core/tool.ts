// SPDX-License-Identifier: GPL-3.0-or-later
// Local tool-definition helper for the workplan core (no V1 plugin dependency).
import type { z } from "zod";

import type { WorkplanMutationInvocation } from "./transaction";

export type WorkplanToolContext = WorkplanMutationInvocation & {
  directory: string;
  metadata(input: { title?: string; metadata?: Record<string, unknown> }): void;
  runtimeFacts?: unknown;
};

export type WorkplanToolResult = string | { output: string; metadata?: Record<string, unknown> };

export type WorkplanToolDefinition<Shape extends z.ZodRawShape> = {
  description: string;
  args: Shape;
  execute(args: z.output<z.ZodObject<Shape>>, context: WorkplanToolContext): Promise<WorkplanToolResult>;
};

/** Identity helper that only exists to type a workplan tool definition. */
export function defineWorkplanTool<Shape extends z.ZodRawShape>(def: WorkplanToolDefinition<Shape>): WorkplanToolDefinition<Shape> {
  return def;
}

export { defineWorkplanTool as tool };
