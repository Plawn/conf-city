import { expect, test } from "bun:test";
import { WebGLPipelineTimer } from "@/components/lighting/WebGLPipelineTimer";

function fixture(supported = true) {
  const state = {
    available: true,
    disjoint: false,
    elapsed: 12_000_000,
    deleted: 0,
    active: null as object | null,
  };
  const gl = {
    CURRENT_QUERY: 1,
    QUERY_RESULT_AVAILABLE: 2,
    QUERY_RESULT: 3,
    getExtension: () => (supported ? { TIME_ELAPSED_EXT: 4, GPU_DISJOINT_EXT: 5 } : null),
    getQuery: () => state.active,
    createQuery: () => ({}),
    beginQuery: (_target: number, query: object) => {
      state.active = query;
    },
    endQuery: () => {
      state.active = null;
    },
    getParameter: () => state.disjoint,
    getQueryParameter: (_query: object, name: number) =>
      name === 2 ? state.available : state.elapsed,
    deleteQuery: () => {
      state.deleted++;
    },
  } as unknown as WebGL2RenderingContext;
  return { state, timer: new WebGLPipelineTimer(gl) };
}

test("whole-pipeline query converts native nanoseconds and avoids nesting", async () => {
  const { timer, state } = fixture();
  const query = timer.begin()!;
  expect(timer.begin()).toBeNull();
  expect(await timer.end(query)).toBe(12);
  expect(state.deleted).toBe(1);
});

test("unsupported, disjoint and corrupt results stay missing, never reuse a prior result", async () => {
  expect(fixture(false).timer.begin()).toBeNull();
  const { timer, state } = fixture();
  expect(await timer.end(timer.begin()!)).toBe(12);
  state.disjoint = true;
  expect(await timer.end(timer.begin()!)).toBeNull();
  state.disjoint = false;
  state.elapsed = Number.NaN;
  expect(await timer.end(timer.begin()!)).toBeNull();
  expect(state.deleted).toBe(3);
});

test("disposal cancels an unavailable readback and deletes its query exactly once", async () => {
  const { timer, state } = fixture();
  state.available = false;
  const pending = timer.end(timer.begin()!);
  timer.dispose();
  expect(await pending).toBeNull();
  expect(state.deleted).toBe(1);
  expect(timer.begin()).toBeNull();
});
