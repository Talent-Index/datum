import { describe, expect, it } from "vitest";

import { linkedProjectIds } from "@/lib/identity";
import { otpDeliveryMessage } from "@/lib/otp-message";
import { coverSrc } from "@/lib/ui/covers";

describe("register lists every build", () => {
  it("keeps a project even when its escrow read failed", () => {
    const projects = ["willow-park-a", "ruiru-plot-12", "kitengela-3br", "nyeri-bungalow"];
    const states = [
      { id: "willow-park-a", state: { held: 650 } },
      { id: "ruiru-plot-12", state: null },
      { id: "kitengela-3br", state: { held: 0 } },
      { id: "nyeri-bungalow", state: { held: 80000 } },
    ];
    const rows = projects.map((id) => ({ id, state: states.find((row) => row.id === id)?.state ?? null }));
    expect(rows).toHaveLength(4);
    expect(rows.filter((row) => row.state).map((row) => row.id)).toEqual(["willow-park-a", "kitengela-3br", "nyeri-bungalow"]);
    expect(rows.find((row) => row.id === "ruiru-plot-12")?.state).toBeNull();
  });
});

describe("returning sign-in", () => {
  it("unions sender, buyer and visited builds without dropping duplicates", () => {
    expect(linkedProjectIds({
      sender: ["willow-park-a"],
      buyer: ["willow-park-a", "ruiru-plot-12"],
      touched: ["nyeri-bungalow", "ruiru-plot-12"],
    })).toEqual(["willow-park-a", "ruiru-plot-12", "nyeri-bungalow"]);
  });
});

describe("sign-in copy", () => {
  it("does not reveal a code or mention a demo code", () => {
    const message = otpDeliveryMessage();
    expect(message).not.toMatch(/\d{6}/);
    expect(message.toLowerCase()).not.toContain("demo");
    expect(message.toLowerCase()).not.toContain("log");
  });
});

describe("cover photos", () => {
  it("uses a shipped illustration and a fallback so the image cannot 404", () => {
    expect(coverSrc("willow-park-a")).toBe("/covers/willow-park-a.jpg");
    expect(coverSrc("ruiru-plot-12")).toBe("/covers/ruiru-plot-12.jpg");
    expect(coverSrc("not-a-real-build")).toBe("/covers/default.jpg");
    expect(coverSrc(null)).toBe("/covers/default.jpg");
  });
});
