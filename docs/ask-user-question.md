# ask_user_question

pi-forge ships a browser-native implementation of the
`ask_user_question` tool: a structured questionnaire the agent can put
to the user when its instructions are underspecified. Picking
"PostgreSQL" from a four-option list beats parsing an ambiguous
free-form reply.

## How it works

When the agent invokes `ask_user_question`, pi-forge:

1. Validates the questionnaire (caps on question / option counts,
   reserved-label guard, byte limits).
2. Pushes the questions over SSE to every browser tab watching the
   session.
3. Displays an inline panel directly above the chat composer:
   vertical option list for single-select, checkbox list for
   `multiSelect: true`, side-by-side preview pane when any option
   carries a `preview` markdown string. The chat scroll stays
   interactive so the user can reread context while answering.
4. Holds the agent open until the user submits — or until they click
   **Chat about this** to abandon the questionnaire and continue in
   free-form chat.
5. Returns the structured envelope to the agent so it can branch on
   `details.answers[].kind` and `details.cancelled`.

## Disabling the tool

The tool appears under **Settings → Tools → Built-in tools**. Toggle
it off there to filter `ask_user_question` out of every new session's
tool allowlist. Live sessions keep the tool list they were created
with.

## Relationship to `@juicesharp/rpiv-ask-user-question`

The wire contract — tool name, parameter schema (question / option
shape, header / label byte caps, reserved labels), and response
envelope (`{ content: [{type:"text",text}], details: { answers,
cancelled, error? } }` with answer kinds `option | custom | chat |
multi`) — is contract-compatible with the upstream Pi extension
[`@juicesharp/rpiv-ask-user-question`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-ask-user-question)
(MIT). An agent prompt authored against that plugin works against
this implementation unchanged.

Implementation is independent. The TUI plugin can't render into a
browser session (`ctx.hasUI` is false), so installing the plugin
alongside pi-forge has no effect — pi-forge's `customTools`
registration takes the `ask_user_question` slot for browser sessions.

Prompt snippet and guidelines (the strings the model sees) are
adapted from the plugin with attribution preserved in
`packages/server/src/ask-user-question/prompt-strings.ts`. The
plugin's wording has been tuned against real model behavior; matching
it avoids regressions in tool-call quality.
