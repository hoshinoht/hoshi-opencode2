import { describe, expect, it } from "bun:test";
import { usageTheme } from "./theme.ts";

const colors = {
  text: "#ffffff",
  muted: "#aaaaaa",
  background: "#222222",
  border: "#444444",
  error: "#ff0000",
  warning: "#ffff00",
  info: "#00ffff",
};

const earlier = {
  text: {
    default: colors.text,
    subdued: colors.muted,
    feedback: {
      error: { default: colors.error },
      warning: { default: colors.warning },
      info: { default: colors.info },
    },
  },
  background: { surface: { offset: colors.background } },
  border: { default: colors.border },
};

describe("usage dashboard theme compatibility", () => {
  it("reads the dialog surface without accessing the removed nested tokens", () => {
    const source = {
      surface(name: "dialog") {
        expect(name).toBe("dialog");
        return {
          text: {
            base: colors.text,
            muted: colors.muted,
            feedback: {
              error: { base: colors.error },
              warning: { base: colors.warning },
              info: { base: colors.info },
            },
          },
          background: { raised: { base: colors.background } },
          border: { base: colors.border },
        };
      },
      get background(): never {
        throw new Error("The old background API is unavailable");
      },
    };
    expect(usageTheme(source)).toEqual(colors);
  });

  it("supports earlier themes and prefers their overlay context", () => {
    expect(usageTheme(earlier)).toEqual(colors);
    expect(usageTheme({
      ...earlier,
      background: { surface: { offset: "#000000" } },
      contextual: { overlay: earlier },
    })).toEqual(colors);
  });
});
