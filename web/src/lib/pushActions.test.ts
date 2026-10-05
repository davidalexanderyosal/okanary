import { describe, expect, it } from "vitest";
import { actionHandled, actionRequest, notificationActions } from "./pushActions";

describe("push actions", () => {
  it("builds Transferred / Skip buttons from the comma list when there is a pledge", () => {
    expect(notificationActions("transfer,skip", "p1")).toEqual([{ action: "transfer", title: "Transferred" }, { action: "skip", title: "Skip" }]);
    expect(notificationActions(" skip ", "p1")).toEqual([{ action: "skip", title: "Skip" }]);
  });
  it("shows nothing without actions or a pledge, and ignores unknown or repeated names", () => {
    expect(notificationActions(undefined, "p1")).toEqual([]);
    expect(notificationActions("transfer,skip", undefined)).toEqual([]);
    expect(notificationActions("delete,transfer,transfer", "p1")).toEqual([{ action: "transfer", title: "Transferred" }]);
  });
  it("maps an action to its API call", () => {
    expect(actionRequest("transfer", "01ABC")).toEqual({ path: "/api/goal-contributions/01ABC/transfer", method: "POST" });
    expect(actionRequest("skip", "01ABC")).toEqual({ path: "/api/goal-contributions/01ABC/skip", method: "POST" });
  });
  it("a body click (empty action) or bad input makes no call", () => {
    expect(actionRequest("", "01ABC")).toBeNull();
    expect(actionRequest(undefined, "01ABC")).toBeNull();
    expect(actionRequest("transfer", undefined)).toBeNull();
    expect(actionRequest("nuke", "01ABC")).toBeNull();
  });
  it("2xx and 409 count as handled", () => {
    expect([200, 204, 409].map(actionHandled)).toEqual([true, true, true]);
    expect([401, 404, 500].map(actionHandled)).toEqual([false, false, false]);
  });
});
