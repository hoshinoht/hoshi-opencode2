/** @jsxImportSource @opentui/solid */
import { TextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import { Plugin, usePlugin } from "@opencode/plugin/tui";
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { formatUsagePercent, usageBarSegments, usageBarWidth, usageDialogSize } from "./dashboard.ts";
import { isProviderName, providerLabel, type ProviderName, TUI_PLUGIN_ID } from "./constants.ts";
import { UsageTrackerRpc } from "./rpc.ts";
import type { UsageData, UsageWindow } from "./format.ts";
import type { UsageResult } from "./usage.ts";
import { usageTheme } from "./theme.ts";

const PROVIDER_OPTIONS = [
  { title: "All Providers", value: "all" as const, description: "Compare Copilot, OpenAI/Codex, and Anthropic quotas" },
  { title: "GitHub Copilot", value: "copilot" as const, description: "Premium and chat request quota" },
  { title: "OpenAI/Codex", value: "openai" as const, description: "Five-hour, weekly, and credit usage" },
  { title: "Anthropic", value: "anthropic" as const, description: "Five-hour and weekly Claude usage" },
];

type DashboardState = { readonly kind: "loading" } | UsageResult;

function useUsageTheme() {
  const context = usePlugin();
  return () => usageTheme(context.theme);
}

function usageColor(percent: number, theme: ReturnType<typeof usageTheme>) {
  if (percent >= 90) return theme.error;
  if (percent >= 75) return theme.warning;
  return theme.info;
}

function metadataRows(provider: UsageData): Array<{ readonly label: string; readonly value: string }> {
  const resets = provider.windows.flatMap((window) =>
    window.resetTime ? [{ label: `${window.label} resets`, value: window.resetTime }] : [],
  );
  const extra = Object.entries(provider.extra ?? {}).map(([label, value]) => ({ label, value }));
  return [...resets, ...extra];
}

function UsageBar(props: { readonly window: UsageWindow; readonly terminalWidth: number }) {
  const theme = useUsageTheme();
  const bar = () => usageBarSegments(props.window.usedPercent, usageBarWidth(props.terminalWidth));
  const color = () => usageColor(props.window.usedPercent, theme());

  return (
    <box flexDirection="column" gap={0} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between" gap={1}>
        <text fg={theme().text}>{props.window.label}</text>
        <text fg={color()} attributes={TextAttributes.BOLD}>
          {formatUsagePercent(props.window.usedPercent)}
        </text>
      </box>
      <box flexDirection="row" gap={0}>
        <text fg={color()}>{bar().filled}</text>
        <text fg={theme().border}>{bar().empty}</text>
      </box>
    </box>
  );
}

function MetadataRows(props: { readonly rows: readonly { readonly label: string; readonly value: string }[] }) {
  const theme = useUsageTheme();
  return (
    <For each={props.rows}>
      {(row) => (
        <box flexDirection="row" justifyContent="space-between" gap={2}>
          <text fg={theme().muted} wrapMode="word">
            {row.label}
          </text>
          <text fg={theme().text} wrapMode="word">
            {row.value}
          </text>
        </box>
      )}
    </For>
  );
}

function ProviderCard(props: { readonly provider: UsageData; readonly terminalWidth: number }) {
  const theme = useUsageTheme();
  const rows = () => metadataRows(props.provider);

  return (
    <box
      flexDirection="column"
      padding={1}
      marginBottom={1}
      backgroundColor={theme().background}
      borderColor={props.provider.error ? theme().error : theme().border}
      borderStyle="rounded"
    >
      <box flexDirection="row" justifyContent="space-between" gap={2} paddingBottom={1}>
        <text fg={theme().text} attributes={TextAttributes.BOLD} wrapMode="word">
          {props.provider.provider}
        </text>
        <Show when={props.provider.planType}>
          <text fg={theme().muted} wrapMode="word">
            {props.provider.planType}
          </text>
        </Show>
      </box>

      <Show
        when={!props.provider.error}
        fallback={
          <box flexDirection="column" gap={0}>
            <text fg={theme().error} attributes={TextAttributes.BOLD}>
              Unable to retrieve usage for this provider.
            </text>
            <text fg={theme().muted}>{props.provider.error}</text>
            <text fg={theme().muted} wrapMode="word">
              Check your connection and provider sign-in, then run /usage again.
            </text>
          </box>
        }
      >
        <Show
          when={props.provider.windows.length > 0 || rows().length > 0}
          fallback={<text fg={theme().muted}>No usage windows or account details were reported.</text>}
        >
          <For each={props.provider.windows}>
            {(window) => <UsageBar window={window} terminalWidth={props.terminalWidth} />}
          </For>
          <MetadataRows rows={rows()} />
        </Show>
      </Show>
    </box>
  );
}

function ResultNotice(props: { readonly result: Exclude<UsageResult, { readonly kind: "ok" }> }) {
  const theme = useUsageTheme();
  const isError = () => props.result.kind === "error";
  return (
    <box
      flexDirection="column"
      padding={1}
      backgroundColor={theme().background}
      borderColor={isError() ? theme().error : theme().border}
      borderStyle="rounded"
    >
      <text fg={isError() ? theme().error : theme().text} attributes={TextAttributes.BOLD}>
        {isError() ? "Usage could not be retrieved" : "No provider is connected"}
      </text>
      <text fg={theme().muted} wrapMode="word">
        {props.result.message}
      </text>
      <Show when={isError()}>
        <text fg={theme().muted} wrapMode="word">
          Check your connection and provider sign-in, then run /usage again.
        </text>
      </Show>
    </box>
  );
}

function UsageDashboard(props: { readonly provider: ProviderName }) {
  const context = usePlugin();
  const theme = useUsageTheme();
  const dimensions = useTerminalDimensions();
  const [state, setState] = createSignal<DashboardState>({ kind: "loading" });
  let active = true;

  onMount(() => {
    const usage = context.client.rpc(UsageTrackerRpc);
    void usage
      .fetch({ provider: props.provider })
      .then((result) => {
        if (active) setState(result as unknown as UsageResult);
      })
      .catch(() => {
        if (active) {
          setState({
            kind: "error",
            provider: props.provider,
            message: "The usage request did not complete.",
          });
        }
      });
  });

  onCleanup(() => {
    active = false;
  });

  const maxHeight = () => Math.max(10, Math.floor(dimensions().height * 0.55));
  const terminalWidth = () => dimensions().width;
  const result = () => state();

  return (
    <box flexDirection="column" paddingLeft={2} paddingRight={2} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between" gap={2} paddingBottom={1}>
        <text fg={theme().text} attributes={TextAttributes.BOLD}>
          Usage dashboard
        </text>
        <text fg={theme().muted}>{providerLabel(props.provider)}</text>
      </box>
      <scrollbox maxHeight={maxHeight()}>
        <Show
          when={result().kind !== "loading"}
          fallback={
            <box flexDirection="column" padding={1} borderColor={theme().border} borderStyle="rounded">
              <text fg={theme().text} attributes={TextAttributes.BOLD}>
                Fetching usage data
              </text>
              <text fg={theme().muted}>Contacting {providerLabel(props.provider)}…</text>
            </box>
          }
        >
          <Show
            when={result().kind === "ok"}
            fallback={<ResultNotice result={result() as Exclude<UsageResult, { readonly kind: "ok" }>} />}
          >
            <For each={(result() as Extract<UsageResult, { readonly kind: "ok" }>).providers}>
              {(provider) => <ProviderCard provider={provider} terminalWidth={terminalWidth()} />}
            </For>
          </Show>
        </Show>
      </scrollbox>
    </box>
  );
}

function UsageCommands() {
  const context = usePlugin();
  const openUsage = (provider: ProviderName): void => {
    context.ui.dialog.set({ size: usageDialogSize(context.renderer.width), centered: true });
    context.ui.dialog.show(() => <UsageDashboard provider={provider} />);
  };

  const openPicker = async (): Promise<void> => {
    const provider = await context.ui.dialog.select({
      title: "Usage",
      placeholder: "Choose provider",
      options: PROVIDER_OPTIONS,
    });
    if (isProviderName(provider)) openUsage(provider);
  };

  context.keymap.layer(() => ({
    mode: "global",
    priority: 10,
    commands: [
      {
        id: "usage-tracker.open",
        title: "Usage",
        description: "Show GitHub Copilot, OpenAI/Codex, and Anthropic usage",
        group: "Usage",
        palette: true,
        slash: { name: "usage" },
        suggested: true,
        run: () => {
          void openPicker();
        },
      },
    ],
  }));

  return null;
}

export default Plugin.define({
  id: TUI_PLUGIN_ID,
  setup(context) {
    return context.ui.slot({
      append: "app",
      render: () => <UsageCommands />,
    });
  },
});
