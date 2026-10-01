import { createApp } from "./app";
import { runScheduled } from "./cron";
import type { Deps } from "./deps";
import { handleEmail, type InboundEmail } from "./email";
import type { Env } from "./env";

const app = createApp();
const liveDeps = (env: Env): Deps => ({ now: () => new Date(), fetch: (...a) => fetch(...a), ai: env.AI });

export default {
  fetch: (req: Request, env: Env, ctx: ExecutionContext) => app.fetch(req, env, ctx),
  // Cloudflare Email Routing -> Email Worker (spec §4.2)
  email: async (message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext) => {
    await handleEmail(message as unknown as InboundEmail, env, liveDeps(env), ctx);
  },
  // Cron Triggers (wrangler.jsonc "triggers")
  scheduled: async (controller: ScheduledController, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(runScheduled(env, liveDeps(env), controller.cron));
  },
} satisfies ExportedHandler<Env>;
