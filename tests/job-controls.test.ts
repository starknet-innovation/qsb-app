import { describe, expect, it } from "vitest";
import { legacySearchControls } from "../src/lib/jobControls";

describe("legacy search controls", () => {
  it("hides pause and resume for a supervised job", () => {
    const execution = { kind: "qsb-supervised-service-v1" };
    expect(legacySearchControls({ status: "queued", execution })).toEqual({
      authorize: false,
      pause: false,
      resume: false,
    });
    expect(legacySearchControls({ status: "searching", execution })).toEqual({
      authorize: false,
      pause: false,
      resume: false,
    });
    expect(legacySearchControls({ status: "paused", execution })).toEqual({
      authorize: false,
      pause: false,
      resume: false,
    });
  });

  it("hides authorization for persisted supervised jobs but keeps supported jobs actionable", () => {
    expect(legacySearchControls({
      status: "awaiting_authorization",
      execution: { kind: "qsb-supervised-service-v1" },
    })).toEqual({ pause: false, resume: false, authorize: false });
    expect(legacySearchControls({ status: "awaiting_authorization" })).toEqual({
      pause: false, resume: false, authorize: true,
    });
  });

  it("keeps pause and resume for a legacy job", () => {
    expect(legacySearchControls({ status: "queued" })).toEqual({
      authorize: false,
      pause: true,
      resume: false,
    });
    expect(legacySearchControls({ status: "searching" })).toEqual({
      authorize: false,
      pause: true,
      resume: false,
    });
    expect(legacySearchControls({ status: "paused" })).toEqual({
      authorize: false,
      pause: false,
      resume: true,
    });
  });
});
