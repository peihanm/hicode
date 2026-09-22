# Models and credentials

## Recommended configuration flow

Use `/providers` in the interactive CLI to configure a provider's API key, API endpoint and model list. Built-in provider sources are Alibaba Bailian (`qwen`), Zhipu GLM (`glm`), DeepSeek (`deepseek`) and OpenRouter (`openrouter`).

Choose the source that actually serves the API request. A model's brand or displayed name does not determine which provider key or endpoint it uses.

- Enter the provider's API base URL when the offered default does not match the account or deployment.
- Add a model with its exact API **Model ID** and an optional display name. Adding an ID does not activate that product in the provider account or implement a new API protocol.
- Model/provider configuration can be managed from `/providers`, including removing configured models. Inspect any warning about a model still selected as primary/fast/reviewer before deletion.
- Use `/model` to select an available model after configuration. This changes the primary model and persists the selection.
- With no explicit fast model, fast work follows the current primary model. Users do not need two different model configurations to get started.

Provider credentials and configuration are available across project directories by default. A project model override can select a different configured model.

## Where configuration goes

| Data | Default CLI location |
| --- | --- |
| Provider labels, endpoints, model lists and user defaults | `~/.hicode/settings.json` |
| API keys saved through `/providers` | `~/.hicode/.env` |
| Shared project settings | `<cwd>/.hicode/settings.json` |
| Local project overrides | `<cwd>/.hicode/settings.local.json` |

If the key's variable already exists in the current project's `.env`, `/providers` updates that existing project variable instead of the user credential file. Do not publish either credential file.

`/model` normally saves the choice in user settings. If the project already overrides the primary model, it saves to project-local settings so that the selection takes effect there.

Ordinary settings resolve from built-in defaults, then user settings, project settings, local project settings, and applicable CLI overrides. There are field-specific restrictions: provider source definitions are user/Host configuration; project settings cannot replace the permission-review model or select Full Access.

Credential precedence at CLI startup is: existing process environment, then current project `.env`, then missing values from `~/.hicode/.env`. An exported old key can therefore take precedence over an edited file. Diagnose variable presence and source without printing the secret.

## Manual configuration when needed

Prefer the UI. A minimal user settings fragment selecting a built-in model is:

```json
{
  "models": {
    "primary": {"source": "qwen", "model": "qwen3.8-flash"}
  }
}
```

Provider model IDs must exist in the configured source's model list. To declare a custom endpoint/list, merge a `sources.<source>` entry into user settings using `baseUrl`, `apiKeyEnv`, and `models: [{"id": "...", "label": "..."}]`. A supplied model list replaces that source's list; it is not an additive patch. Keep key values out of settings.

Default key variable names: `DASHSCOPE_API_KEY`, `GLM_API_KEY`, `DEEPSEEK_API_KEY`, `OPENROUTER_API_KEY`. The configured `apiKeyEnv` can change the name.

`hicode --source <source> --model <id>` overrides the primary selection for that invocation. Headless/SDK callers must configure credentials through their environment/Host; `/providers` is an interactive CLI UI.

## Common API errors

- **401/403:** check the selected source, endpoint and credential source. Do not assume every 403 is a local sandbox error.
- **Product not activated / unknown model:** verify the exact model ID and account entitlement with the provider.
- **Invalid tool schema:** investigate provider protocol compatibility and the named tool; changing the key usually does not solve it.
- **Timeout or fetch failed:** separate the main provider request from a Bash command's network access; `/sandbox` configures the latter.

Support for images, reasoning output and continuation depends on the selected provider/model. Do not promise features merely because the model can be added to the list.
