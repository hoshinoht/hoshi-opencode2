# openai-long-context (V2-only)

1M-context variants for OpenAI `gpt-5.6-*` and all `gpt-6-*` / `gpt-6.*` model families,
including Astra, Sol 6.1, and future family names. A model transform clones every
matching base model into a `<id>-1m` variant with a 1M-token window:

- `context: 1,000,000`
- `input: 872,000`
- `output: 128,000`

Variants inherit all base-model fields (capabilities, cost, compatibility,
transport settings) and only override identity, display name
(`"<base> (1M context)"`), and limits.

## Install

```sh
opencode2 plugin add 'github:hoshinoht/hoshi-opencode2#main::path:packages/openai-long-context'
```

Or register the local path in `opencode.json`:

```jsonc
{
  "plugins": [
    { "package": "./packages/openai-long-context" },
  ],
}
```

After reload, `opencode2 models` lists e.g.
`openai/gpt-5.6-terra-1m` and `openai/gpt-6-astra-1m` alongside their base
models.

## Options (`opencode.json`)

```jsonc
{
  "package": "./packages/openai-long-context",
  "options": {
    // "enabled": true, // false registers nothing
    // "providerID": "openai",
    // "modelPrefix": "gpt-5.6-",
    // Defaults to ["gpt-5.6-", "gpt-6-", "gpt-6."]; the latter two cover every gpt-6 family,
    // including dotted releases like gpt-6.1-sol.
    // "modelPrefixes": ["gpt-5.6-", "gpt-6-", "gpt-6."],
    // "suffix": "-1m",
    // "nameSuffix": " (1M context)",
    // "limit": { "context": 1000000, "input": 872000, "output": 128000 },
  },
}
```

Invalid options fail fast at setup. The transform never throws for a missing
provider or an empty model list — it simply registers nothing.

## Notes

- V2 model transforms carry no auth context. The V1 sketch this ports gated
  on OAuth (`ctx.auth?.type === "oauth"`); here variants are registered
  unconditionally and inert until selected, so API-key callers can ignore them.
- The transform is idempotent: replays derive the same variant set from the
  same base models and refresh existing variants in place.
- Existing `<id>-1m` models are never used as clone sources.

## Compatibility

V2-only. `@opencode/plugin` is pinned to `2.0.8`, matching the OpenCode
`2.0.8` server (`ctx.model.transform`) and the other local plugins.
Re-test after any OpenCode or plugin-API upgrade.
