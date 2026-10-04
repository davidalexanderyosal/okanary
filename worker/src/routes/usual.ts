import { Hono } from "hono";
import type { AppEnv } from "../env";
import { loadUsual } from "../usual";

export const usual = new Hono<AppEnv>();

/** "Vs your usual" (v2 U): month to date and week to date against the average of the same point in recent complete periods. */
usual.get("/usual", async (c) => {
  const { month, week } = await loadUsual(c.env.DB, c.var.deps.now());
  return c.json({ month, week });
});
