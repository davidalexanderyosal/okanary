/** Injectable side-effects so integration tests don't touch the network or the AI binding. */
export interface AiLike { run(model: string, input: unknown): Promise<unknown> }

export interface Deps {
  now: () => Date;
  fetch: typeof fetch;
  ai?: AiLike;
}
