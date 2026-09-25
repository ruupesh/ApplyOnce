import { StateGraph, StateSchema, START, END } from '@langchain/langgraph/web';
import { z } from 'zod/v4';

// All effects live in the extension's handlers. A checkpoint contains only
// JSON task data; keys, callbacks, model tensors and screenshots stay in memory.
const State = new StateSchema({ task: z.any() });
export async function runWorkflow({ task, handlers, checkpoint, signal }) {
  const stages = ['inspect', 'plan', 'validate', 'tool'];
  const route = state => stages.includes(state.task.stage) ? state.task.stage : END;
  const graph = new StateGraph(State);
  for (const stage of stages) {
    graph.addNode(stage, async state => {
      signal?.throwIfAborted();
      const next = await handlers[stage](state.task);
      signal?.throwIfAborted();
      await checkpoint(next);
      return { task: next };
    });
  }
  graph.addConditionalEdges(START, route);
  for (const stage of stages) graph.addConditionalEdges(stage, route);
  const result = await graph.compile().invoke({ task }, {
    signal, recursionLimit: task.maxIterations > 0 ? Math.max(20, task.maxIterations * 4 + 5) : Number.MAX_SAFE_INTEGER
  });
  return result.task;
}
