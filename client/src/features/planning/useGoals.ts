/**
 * Savings goals, projected against the budget's dependable surplus.
 *
 * Goals are funded in priority order rather than in parallel — see
 * `allocateAcrossGoals`. Funding three goals at the full surplus each is the
 * arithmetic mistake that makes every projection optimistic by however many
 * goals exist.
 */
import { useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { Goal, GoalProjection } from '@aminfinance/shared';
import { db } from '@/lib/db';
import { allocateAcrossGoals } from '@/lib/calc/goals';
import { useSurplus } from './useSurplus';

export interface GoalRow {
  goal: Goal;
  projection: GoalProjection;
  /** Share of the monthly surplus this goal receives. */
  allocated: number;
}

export interface GoalsState {
  rows: GoalRow[];
  /** The rate projections assume — dependable surplus, not the median. */
  monthlyRate: number | null;
  isLoading: boolean;
  isEmpty: boolean;
  currency: string;
}

export function useGoals(): GoalsState {
  const goals = useLiveQuery(() => db.goals.toArray(), []);
  const surplus = useSurplus();

  // Dependable, not `reliable`: committing the median overcommits half the
  // time, and a goal date built on it slips by construction.
  const monthlyRate = surplus.dependable;

  const rows = useMemo<GoalRow[]>(() => {
    const list = [...(goals ?? [])].sort((a, b) => a.createdAt - b.createdAt);
    return allocateAcrossGoals(list, monthlyRate).map((result, index) => ({
      // `allocateAcrossGoals` preserves input order, so index alignment holds.
      goal: list[index]!,
      projection: result.projection,
      allocated: result.allocated,
    }));
  }, [goals, monthlyRate]);

  return {
    rows,
    monthlyRate,
    isLoading: goals === undefined || surplus.isLoading,
    isEmpty: goals !== undefined && goals.length === 0,
    currency: surplus.currency,
  };
}
