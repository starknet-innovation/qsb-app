import { describe, expect, it } from "vitest";
import { legacySearchControls } from "../src/lib/jobControls";

describe("legacy search controls", () => {
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
