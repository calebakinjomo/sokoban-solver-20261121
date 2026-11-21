[![make.fun](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/calebakinjomo/sokoban-solver-20261121/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/calebakinjomo/sokoban-solver-20261121/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)

# Sokoban solver

A push-optimal Sokoban solver for [make.fun's "Build the best Sokoban solver, 21 November 2026" bounty](https://make.fun/bounty/sokoban-solver-01-run-20261121).

## How it works

A level is a hallway with 1–4 rooms off it, each room holding 3–4 boxes and as many goals, and a box pushed out of a room's door into the hallway can never come back (the hallway is one square wide and its far side is wall). So the level splits into independent rooms, and the push-optimal count is the sum of the rooms' optima. This program finds each room, solves it push-optimally, and joins the room solutions with the player's walk along the hallway.

Each room is solved by breadth-first search over pushes. A state is the boxes' squares plus the player's reachable region (named by its lowest square). Expanding in order of pushes made, the first solved state met is push-optimal. Two prunings keep the search small, and neither prunes a solvable state:

- **Dead squares**: a square from which no sequence of pushes (ignoring the other boxes) reaches any goal, computed once by pulling boxes back from the goals.
- **Frozen 2×2 blocks**: four squares of walls and boxes holding a box off its goal can never move again.

The search is budgeted by work (a fixed number of states per room, with one retry at four times the budget for a room that gives up), never by the clock, so two runs write identical bytes.

## Run it

```sh
node main.ts
```

It reads every instance under `/input/<id>/level.txt` and writes its answer as `/output/<id>/solution.txt` (the player's moves in LURD, an upper letter marking a push). `MAKEFUN_INPUT_DIR` and `MAKEFUN_OUTPUT_DIR` stand in for `/input` and `/output` outside the sandbox.

## Results

Practice set (in the kit): **1,000,000** — every instance solved in exactly its push-optimal count (13, 16, 29, 47, 60 pushes). Three further sets drawn fresh from the kit's generator also score 1,000,000 each, all in exactly P* pushes, in under a second per set. The house baseline (plain-astar 1.0.0) scores 200,000 on the practice set.
