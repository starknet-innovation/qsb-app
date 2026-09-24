import { describe, expect, it } from "vitest";
import { legacySearchControls } from "../src/lib/jobControls";

describe("legacy search controls", () => {
  it("hides pause and resume for a supervised job", () => {
    const execution = { kind: "qsb-supervised-service-v1" };
    expect(legacySearchControls({ status: "queued", execution })).toEqual({
      pause: false,
      resume: false,
    });
    expect(legacySearchControls({ status: "searching", execution })).toEqual({
      pause: false,
      resume: false,
    });
    expect(legacySearchControls({ status: "paused", execution })).toEqual({
      pause: false,
      resume: false,
    });
  });

  it("keeps pause and resume for a legacy job", () => {
    expect(legacySearchControls({ status: "queued" })).toEqual({
      pause: true,
      resume: false,
    });
    expect(legacySearchControls({ status: "searching" })).toEqual({
      pause: true,
      resume: false,
    });
    expect(legacySearchControls({ status: "paused" })).toEqual({
      pause: false,
      resume: true,
    });
  });
});
