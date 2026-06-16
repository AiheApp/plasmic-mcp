import type { z } from "zod";
import type { PlasmicClient } from "../client.js";

export interface ToolDef<S extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>> {
  name: string;
  description: string;
  schema: S;
  handler: (client: PlasmicClient, args: z.infer<S>) => Promise<unknown>;
}

export function defineTool<S extends z.ZodObject<z.ZodRawShape>>(def: ToolDef<S>): ToolDef {
  return def as unknown as ToolDef;
}
