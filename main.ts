// A push-optimal Sokoban solver for make.fun's sokoban-solver-01.
//
// How it works: a level is a hallway with 1-4 rooms off it, each room holding
// 3-4 boxes and as many goals, and a box pushed out of a room's door into the
// hallway can never come back (the hallway is one square wide and its far side
// is wall). So the level splits into independent rooms, and the push-optimal
// count is the sum of the rooms' optima. This program finds each room, solves
// it push-optimally, and joins the room solutions with the player's walk
// along the hallway.
//
// Each room is solved by breadth-first search over pushes. A state is the
// boxes' squares plus the player's reachable region (named by its lowest
// square: the player's exact square inside the region does not matter, since
// it can walk anywhere in it). Expanding in order of pushes made, the first
// solved state met is push-optimal. Two prunings keep the search small, and
// neither prunes a solvable state:
//   - dead squares: a square from which no sequence of pushes (ignoring the
//     other boxes) reaches any goal. Computed once by pulling boxes back from
//     the goals. A box on a dead square can never be solved.
//   - frozen 2x2 blocks: four squares of walls and boxes holding a box off
//     its goal can never move again.
// The search is budgeted by WORK (a fixed number of states per room), never
// by the clock, so two runs of the program write identical bytes.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const IN = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUT = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
// The most states one room's search keeps before it gives up: work, never the clock.
const MAX_STATES = 1_000_000;
// A room that gives up gets one retry with this many states: the generator
// guarantees a room solves within 250,000 states in its own search order,
// and this solver's order is close to it, so a retry at four times the
// budget covers a room whose search runs longer than expected instead of
// giving up the whole level for it.
const MAX_STATES_RETRY = 4_000_000;
// The most states a whole-level fallback search keeps.
const MAX_STATES_WHOLE = 200_000;

// The four moves: [dx, dy, step letter, push letter].
const DIRS: [number, number, string, string][] = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

interface Level {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

/** A level in XSB text: its width and height, walls, goals, boxes and player. */
function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  // The outermost frame is wall whatever it shows: nothing leaves the board.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  boxes.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

/**
 * The squares from which a box can be pushed onto some goal, ignoring the
 * other boxes: pull boxes back from the goals. A box at y can be pushed onto
 * a live square x = y + d exactly when the player can stand at y - d, so y is
 * live when y and y - d are both open floor.
 */
function liveSquares(level: Level): Uint8Array {
  const { w, wall, goals } = level;
  const size = wall.length;
  const live = new Uint8Array(size);
  const queue: number[] = [...goals];
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      if (y < 0 || y >= size) continue;
      const behind = y - d;
      if (behind < 0 || behind >= size) continue;
      if (!wall[y] && !wall[behind] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/**
 * Flood-fill the squares the player reaches from `from`, with `occupied`
 * (boxes) in the way, marking them in `seen` with `stamp`; returns the
 * region's lowest square, which names the region. `stack` is scratch.
 */
function flood(
  level: Level,
  occupied: Uint8Array,
  from: number,
  seen: Int32Array,
  stamp: number,
  stack: Int32Array,
): number {
  const { w, wall } = level;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n]!;
    if (p < low) low = p;
    const a = p - w;
    const b = p + w;
    const c = p - 1;
    const d = p + 1;
    if (wall[a] === 0 && occupied[a] === 0 && seen[a] !== stamp) {
      seen[a] = stamp;
      stack[n++] = a;
    }
    if (wall[b] === 0 && occupied[b] === 0 && seen[b] !== stamp) {
      seen[b] = stamp;
      stack[n++] = b;
    }
    if (wall[c] === 0 && occupied[c] === 0 && seen[c] !== stamp) {
      seen[c] = stamp;
      stack[n++] = c;
    }
    if (wall[d] === 0 && occupied[d] === 0 && seen[d] !== stamp) {
      seen[d] = stamp;
      stack[n++] = d;
    }
  }
  return low;
}

/**
 * Whether the box just pushed to `t` sits in a frozen 2x2 block: four
 * squares of walls and boxes holding a box off its goal. Such a block can
 * never move again, so the position is dead.
 */
function frozenBlock(level: Level, occupied: Uint8Array, goal: Uint8Array, t: number): boolean {
  const { w, wall } = level;
  const size = wall.length;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    if (a < 0 || a + w + 1 >= size) continue;
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b]) || !(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b]) || (occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) return true;
  }
  return false;
}

/** The shortest walk from `from` to `to` around walls and boxes, in lower LURD letters. */
function walkTo(level: Level, occupied: Uint8Array, from: number, to: number): string {
  const { w, wall } = level;
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how: string[] = new Array(wall.length);
  const queue: number[] = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * w + dx;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: the push square is out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
  return s;
}

/** The square the player stands on after `moves` (LURD, case aside) from `from`. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves.toLowerCase()) p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  return p;
}

/**
 * The push-optimal solution of `level`, searching at most `maxStates`
 * states: {pushes, moves} (moves in LURD: a lower letter a step, an upper
 * one a push), or null when the search gives up or the level has no
 * solution. Breadth-first over pushes, so the first solved state met is
 * push-optimal.
 */
function solvePushOptimal(level: Level, maxStates: number): { pushes: number; moves: string } | null {
  const { w, wall, goals } = level;
  const size = wall.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(level);
  if (level.boxes.some((b) => !live[b])) return null;
  const solved = (boxes: number[]): boolean => boxes.every((b) => goal[b]);
  if (solved(level.boxes)) return { pushes: 0, moves: '' };

  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;

  // A state's key: its region's lowest square, then the boxes' squares, as
  // digits in base `size` (exact while size ** (boxes + 1) stays under 2 ** 53:
  // a room holds at most 4 boxes on any board this generator draws).
  const keyOf = (boxes: number[], low: number): number => {
    let k = low;
    for (const b of boxes) k = k * size + b;
    return k;
  };

  // The states in the order found: their boxes, the player's square after the
  // push that made them, and that push (its box and direction).
  const statesBoxes: number[][] = [level.boxes.slice()];
  const statesPlayer: number[] = [level.player];
  const parent: number[] = [-1];
  const pushBox: number[] = [-1];
  const pushDir: number[] = [-1];
  const index = new Map<number, number>();
  for (const b of level.boxes) occupied[b] = 1;
  const startLow = flood(level, occupied, level.player, seen, ++stamp, stack);
  for (const b of level.boxes) occupied[b] = 0;
  index.set(keyOf(level.boxes, startLow), 0);

  let found = -1;
  for (let head = 0; found < 0 && head < statesBoxes.length; head++) {
    const boxes = statesBoxes[head]!;
    const player = statesPlayer[head]!;
    for (const b of boxes) occupied[b] = 1;
    flood(level, occupied, player, seen, ++stamp, stack);
    const here = stamp;
    for (let bi = 0; bi < boxes.length && found < 0; bi++) {
      const b = boxes[bi]!;
      for (let di = 0; di < DIRS.length; di++) {
        const [dx, dy] = DIRS[di]!;
        const d = dy * w + dx;
        const t = b + d;
        // The player must stand at b - d to make this push.
        if (seen[b - d] !== here) continue;
        if (wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(level, occupied, goal, t);
        let next: number[] | null = null;
        let key = -1;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((x, y) => x - y);
          const low = flood(level, occupied, b, mark, ++stamp, stack);
          key = keyOf(next, low);
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen || next === null || index.has(key)) continue;
        if (statesBoxes.length >= maxStates) {
          for (const x of boxes) occupied[x] = 0;
          return null;
        }
        index.set(key, statesBoxes.length);
        statesBoxes.push(next);
        statesPlayer.push(b);
        parent.push(head);
        pushBox.push(b);
        pushDir.push(di);
        if (solved(next)) {
          found = statesBoxes.length - 1;
          break;
        }
      }
    }
    for (const x of boxes) occupied[x] = 0;
  }
  if (found < 0) return null;

  // The path of states, then the moves: walk to each push's square, then push.
  const path: number[] = [];
  for (let s = found; s > 0; s = parent[s]!) path.push(s);
  path.reverse();
  let moves = '';
  let player = level.player;
  let boxes = level.boxes.slice();
  for (const s of path) {
    const nextBoxes = statesBoxes[s]!;
    const b = pushBox[s]!;
    const di = pushDir[s]!;
    const [dx, dy, , pushLetter] = DIRS[di]!;
    const d = dy * w + dx;
    for (const x of boxes) occupied[x] = 1;
    moves += walkTo(level, occupied, player, b - d);
    for (const x of boxes) occupied[x] = 0;
    moves += pushLetter;
    player = b;
    boxes = nextBoxes;
  }
  return { pushes: path.length, moves };
}

interface Room {
  boxes: number[];
  goals: number[];
  done: boolean;
}

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway:
 * a box there reaches no goal) out of the floor, and each part left that
 * holds a box is a room, its boxes and goals. Null when some part holds more
 * or fewer boxes than goals, or a box starts in the hallway: then the level
 * is no set of rooms.
 */
function roomsOf(level: Level): Room[] | null {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) {
    if (!wall[i] && !live[i]) cut[i] = 1;
  }
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares: number[] = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      const p = squares[i]!;
      for (const [dx, dy] of DIRS) {
        const q = p + dy * w + dx;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ boxes: [], goals: [], done: false });
  }
  for (const b of boxes) rooms[part[b]!]!.boxes.push(b);
  for (const g of goals) {
    if (part[g]! < 0) return null;
    rooms[part[g]!]!.goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/**
 * The level solved room by room: each room's push-optimal solution in turn,
 * the other rooms' boxes standing as walls (on their goals once their room
 * is done), the player walking on from where the last room left it. A box
 * never leaves its room, so the rooms' optima add up to the level's:
 * {pushes, moves}, or null when a room's search gives up, or the level is
 * no set of rooms and the search over the whole level gives up.
 */
function solveByRooms(level: Level, maxStates: number): { pushes: number; moves: string } | null {
  const rooms = roomsOf(level);
  if (rooms === null) return solvePushOptimal(level, maxStates);
  let player = level.player;
  let pushes = 0;
  let moves = '';
  for (const room of rooms) {
    const wall = level.wall.slice();
    for (const other of rooms) {
      if (other === room) continue;
      for (const b of other.done ? other.goals : other.boxes) wall[b] = 1;
    }
    const sub: Level = {
      w: level.w,
      h: level.h,
      wall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    // A room that gives up on its first budget gets one retry with four
    // times the states: a hard room is worth a second, deeper search rather
    // than losing the whole level for it.
    let solved = solvePushOptimal(sub, maxStates);
    if (solved === null) solved = solvePushOptimal(sub, MAX_STATES_RETRY);
    if (solved === null) return null;
    pushes += solved.pushes;
    moves += solved.moves;
    player = endOf(level.w, player, solved.moves);
    room.done = true;
  }
  return { pushes, moves };
}

/** The moves that solve a level, or '' when it cannot be solved. */
function solveLevel(text: string): string {
  const level = parseLevel(text);
  if (level.boxes.every((b) => level.goals.includes(b))) return '';
  const byRooms = solveByRooms(level, MAX_STATES);
  if (byRooms !== null) return byRooms.moves;
  const whole = solvePushOptimal(level, MAX_STATES_WHOLE);
  return whole === null ? '' : whole.moves;
}

for (const id of readdirSync(IN).sort()) {
  const moves = solveLevel(readFileSync(join(IN, id, 'level.txt'), 'utf8'));
  mkdirSync(join(OUT, id), { recursive: true });
  writeFileSync(join(OUT, id, 'solution.txt'), `${moves}\n`);
}
