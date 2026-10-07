import type { RGBA } from "@opentui/core";

type Color = string | RGBA;
type Feedback = "error" | "warning" | "info";

type DialogTheme = {
  text: { base: Color; muted: Color; feedback: Record<Feedback, { base: Color }> };
  background: { raised: { base: Color } };
  border: { base: Color };
};

type EarlierTheme = {
  text: { default: Color; subdued: Color; feedback: Record<Feedback, { default: Color }> };
  background: { surface: { offset: Color } };
  border: { default: Color };
};

type ThemeSource = { surface(name: "dialog"): DialogTheme } | (EarlierTheme & {
  contextual?: { overlay: EarlierTheme };
});

/** Normalize both OpenCode theme APIs; newer hosts resolve colors per surface. */
export function usageTheme(source: ThemeSource) {
  if ("surface" in source) {
    const theme = source.surface("dialog");
    return {
      text: theme.text.base,
      muted: theme.text.muted,
      background: theme.background.raised.base,
      border: theme.border.base,
      error: theme.text.feedback.error.base,
      warning: theme.text.feedback.warning.base,
      info: theme.text.feedback.info.base,
    };
  }

  const theme = source.contextual?.overlay ?? source;
  return {
    text: theme.text.default,
    muted: theme.text.subdued,
    background: theme.background.surface.offset,
    border: theme.border.default,
    error: theme.text.feedback.error.default,
    warning: theme.text.feedback.warning.default,
    info: theme.text.feedback.info.default,
  };
}
