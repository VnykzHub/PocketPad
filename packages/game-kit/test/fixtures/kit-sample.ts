/**
 * Headless sample game built only from `@lanpad/game-kit` (spec 24 ER-24-08).
 *
 * This is a test fixture, not a game folder: it proves that a playable game
 * needs no lifecycle, scoring, pack, pool or panel code of its own. The caller
 * drives time; the fixture never touches a clock, DOM or network.
 */
import type { GameContext } from "@lanpad/sdk";
import {
  clearPanel,
  countdownLabel,
  createMatch,
  createPack,
  createPool,
  createScoreboard,
  onChoice,
  resultsRows,
  showChoice,
  type Match,
  type ResultsRow,
  type Scoreboard,
} from "../../src/index.js";

export interface QuizQuestion {
  readonly id: string;
  readonly prompt: string;
  readonly answer: string;
  readonly options: readonly { readonly id: string; readonly label: string }[];
}

export const SAMPLE_SEED = 7;
export const SAMPLE_COUNTDOWN_MS = 2_000;
export const SAMPLE_ROUND_MS = 4_000;
export const SAMPLE_REVEAL_MS = 1_200;

export const SAMPLE_QUESTIONS: readonly QuizQuestion[] = [
  {
    id: "q1",
    prompt: "Which planet is called the red planet?",
    answer: "mars",
    options: [
      { id: "mars", label: "Mars" },
      { id: "venus", label: "Venus" },
    ],
  },
  {
    id: "q2",
    prompt: "What is 2 + 2?",
    answer: "four",
    options: [
      { id: "four", label: "Four" },
      { id: "five", label: "Five" },
    ],
  },
  {
    id: "q3",
    prompt: "Which ocean is the largest?",
    answer: "pacific",
    options: [
      { id: "pacific", label: "Pacific" },
      { id: "atlantic", label: "Atlantic" },
    ],
  },
];

interface AnswerState {
  slot: number;
  choice: string | null;
}

export interface SampleGame {
  readonly match: Match;
  readonly scoreboard: Scoreboard;
  update(nowMs: number, connectedSlots: readonly number[]): void;
  answer(slot: number, optionId: string): void;
  readonly countdown: string;
  readonly rows: readonly ResultsRow[];
  dispose(): void;
}

/** Builds the sample game around a host context; subscribe once per game. */
export function createSampleGame(ctx: GameContext): SampleGame {
  const match = createMatch({
    minPlayers: 1,
    maxPlayers: 8,
    countdownMs: SAMPLE_COUNTDOWN_MS,
    roundsToWin: 2,
  });
  const scoreboard = createScoreboard();
  const pack = createPack(SAMPLE_QUESTIONS, { seed: SAMPLE_SEED });
  const answers = createPool<AnswerState>(
    () => ({ slot: 0, choice: null }),
    (answer) => {
      answer.slot = 0;
      answer.choice = null;
    },
    8,
  );
  let activeSlots: number[] = [];
  let question: QuizQuestion | null = null;
  let deadline = 0;
  let revealUntil = 0;

  function answer(slot: number, optionId: string): void {
    if (match.phase !== "playing" || question === null) {
      return;
    }
    if (!question.options.some((option) => option.id === optionId)) {
      return;
    }
    answers.forEachActive((state) => {
      if (state.slot === slot && state.choice === null) {
        state.choice = optionId;
      }
    });
  }

  function beginQuestion(nowMs: number, slots: readonly number[]): void {
    answers.clear();
    const drawn = pack.draw();
    question = drawn;
    deadline = nowMs + SAMPLE_ROUND_MS;
    activeSlots = slots.slice();
    for (const slot of activeSlots) {
      const state = answers.acquire();
      state.slot = slot;
      showChoice(ctx, slot, drawn.options, drawn.prompt);
    }
  }

  function endQuestion(nowMs: number): void {
    let winner: number | null = null;
    const expected = question?.answer;
    answers.forEachActive((state) => {
      if (state.choice !== null && state.choice === expected) {
        scoreboard.add(state.slot, 1);
        if (winner === null) {
          winner = state.slot;
        }
      }
    });
    match.finishRound(winner);
    for (const slot of activeSlots) {
      clearPanel(ctx, slot);
    }
    answers.clear();
    question = null;
    revealUntil = nowMs + SAMPLE_REVEAL_MS;
  }

  const unsubscribe = onChoice(ctx, answer);

  return {
    match,
    scoreboard,
    get countdown() {
      return countdownLabel(match.countdownRemainingMs);
    },
    get rows() {
      return resultsRows(scoreboard.ranked, match.winnerSlot);
    },
    update(nowMs, connectedSlots) {
      match.update(nowMs, connectedSlots);
      if (match.phase === "lobby") {
        if (match.start(nowMs)) {
          scoreboard.reset();
          for (const slot of connectedSlots) {
            scoreboard.set(slot, 0);
          }
        }
        return;
      }
      if (match.phase === "playing") {
        if (question === null) {
          beginQuestion(nowMs, connectedSlots);
        } else if (nowMs >= deadline) {
          endQuestion(nowMs);
        }
        return;
      }
      if (match.phase === "results" && nowMs >= revealUntil) {
        match.nextRound(nowMs);
      }
    },
    answer,
    dispose() {
      unsubscribe();
      answers.clear();
      for (const slot of activeSlots) {
        clearPanel(ctx, slot);
      }
      activeSlots = [];
    },
  };
}
