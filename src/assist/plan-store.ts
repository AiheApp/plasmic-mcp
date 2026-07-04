/**
 * In-memory store for validated-but-unapplied plans (the two-phase
 * plan → confirm → apply protocol). Ops stay server-side, keyed by an opaque
 * planId — the browser can only reference a plan, never redefine one.
 *
 * A restart drops pending plans (the user just re-asks; nothing was written).
 * The TTL is memory/UX hygiene only — the real correctness guard at apply
 * time is applyMutationsCore's expectedRevision check.
 */

import { randomUUID } from "node:crypto";
import type { MutationOp } from "../model/index.js";
import type { PageSummary } from "./integrity.js";

export type StoredPlanStatus =
  | "pending"
  | "applied"
  | "conflict"
  | "refused";

export interface StoredPlan {
  id: string;
  projectId: string;
  ops: MutationOp[];
  baseRevision: number;
  /** pre-plan page snapshot — the apply step diffs against this */
  before: PageSummary[];
  summary: string;
  preview: string;
  request: string;
  createdAt: number;
  expiresAt: number;
  status: StoredPlanStatus;
  /** cached apply outcome, replayed on duplicate confirms */
  applyResult?: unknown;
}

export const DEFAULT_PLAN_TTL_MS = 15 * 60_000;

export class PlanStore {
  private readonly plans = new Map<string, StoredPlan>();

  constructor(
    private readonly ttlMs = DEFAULT_PLAN_TTL_MS,
    private readonly now: () => number = Date.now
  ) {}

  create(
    plan: Omit<StoredPlan, "id" | "createdAt" | "expiresAt" | "status">
  ): StoredPlan {
    const createdAt = this.now();
    const stored: StoredPlan = {
      ...plan,
      id: randomUUID(),
      createdAt,
      expiresAt: createdAt + this.ttlMs,
      status: "pending",
    };
    this.plans.set(stored.id, stored);
    return stored;
  }

  /** Returns undefined for unknown OR expired ids (expired entries are dropped). */
  get(id: string): StoredPlan | undefined {
    const plan = this.plans.get(id);
    if (!plan) return undefined;
    if (plan.expiresAt <= this.now()) {
      this.plans.delete(id);
      return undefined;
    }
    return plan;
  }

  /** Drop expired entries; returns how many were removed. */
  sweep(): number {
    let removed = 0;
    for (const [id, plan] of this.plans) {
      if (plan.expiresAt <= this.now()) {
        this.plans.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  get size(): number {
    return this.plans.size;
  }
}
