# AI Diagram Studio

**Turn ideas into editable diagrams with natural language.**

AI Diagram Studio combines the flexibility of the draw.io canvas with AI-assisted creation and editing. Build a diagram from a prompt, refine an existing design, and review proposed changes before applying them—all in one workspace.

Built with **Next.js, React, TypeScript, and the OpenAI Responses API**.

## Highlights

- **Natural-language diagramming** — Create diagrams and update labels, styles, layouts, and connections through conversational prompts.
- **Visual context** — Combine the current canvas with optional reference images to guide AI suggestions.
- **Review and apply** — Inspect proposed changes and choose when to apply them to your diagram.
- **Full canvas editing** — Use draw.io's familiar tools alongside AI assistance for precise control.
- **Thoughtful recovery** — Continue from tab-scoped drafts and restore the previous diagram with a dedicated AI undo action.
- **Portable files** — Import existing diagrams and download editable `.drawio` files.

## Getting started

Use **Node.js 24**, as specified in `.nvmrc`.

```sh
npm ci
npm run dev
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000) to start diagramming.

To enable AI assistance, open **Settings** and enter your OpenAI API key. AI requests use your account's API billing. The workspace connects to the hosted draw.io editor and OpenAI over the internet.

### Model configuration

The default model is `gpt-6-luna`. To configure another model, copy the example environment file:

```sh
cp .env.example .env.local
```

Set `OPENAI_MODEL` to a model that supports image inputs and the structured response format used in `lib/ai/propose.ts`.

## A typical workflow

1. Start with a blank canvas or import an existing diagram through draw.io's **File** menu.
2. Describe your idea or an update, such as “Add a cache between the API server and database.”
3. Attach reference images when additional visual context is useful.
4. Review the proposal and apply the changes when ready.
5. Save your work as an editable `.drawio` file through **Files and recovery → Download .drawio**.

The dedicated **Undo AI change** action restores the latest pre-apply snapshot, and tab-scoped recovery helps you resume work after a refresh.

## Engineering approach

AI Diagram Studio pairs structured AI output with a deterministic diagram editing engine. The browser captures diagram XML and a matching canvas image; the server uses both to produce a proposal grounded in the current document.

Each proposal contains explicit operations to update, add, replace, or remove diagram elements. The server validates the complete batch, constructs a candidate document, and derives a change summary from the result. The browser checks for intervening edits before applying the proposal and verifies the loaded document afterward.

This workflow brings together multimodal AI, structured validation, document preservation, and user-controlled editing.

| Area | Responsibility |
| --- | --- |
| `components/DiagramWorkspace.tsx` | Workspace state, proposal lifecycle, recovery, and AI undo |
| `components/DrawioEditor.tsx` | Embedded draw.io integration |
| `components/AiPanel.tsx` | Prompts, image references, proposal review, and settings |
| `app/api/propose/route.ts` | Request validation and proposal orchestration |
| `lib/ai/` | OpenAI integration and image validation |
| `lib/diagram/` | XML parsing, structured changes, and content validation |
| `lib/drawio/` | Editor messaging, snapshots, and file downloads |
| `lib/tab-storage.ts` | Tab-scoped settings and recovery records |
| `tests/` | Unit, component, and browser coverage |

## Data handling

API keys and draft recovery records use tab-scoped browser session storage. API keys pass through the application server to OpenAI and remain separate from the embedded draw.io editor.

AI requests include the prompt, diagram XML, canvas snapshot, and any selected reference images. The application processes this content without persisting it on the server and sets `store: false` on OpenAI requests. Downloaded `.drawio` files provide a durable copy of your work.

## Development

Run the project checks locally:

```sh
npm test
npm run typecheck
npm run build
npm run format:check
```

Install Chromium and run the browser suite:

```sh
npx playwright install chromium
npm run test:browser
```

The browser suite uses a controlled editor iframe and mocked AI responses for repeatable verification. Set `PLAYWRIGHT_CHROME=1` to use installed Chrome, or `TEST_HOSTED_EDITOR=1` to include the hosted-editor integration test.

GitHub Actions runs unit tests, type checking, a production build, browser tests, and formatting checks.

## Deployment

Deploy as a Next.js application using Node.js 24:

```sh
npm ci
npm run build
npm start
```

Configure `OPENAI_MODEL` as needed. Each visitor supplies an OpenAI API key through Settings, while draft recovery stays in the browser. The proposal endpoint is stateless, enabling deployment without a diagram database.

For public hosting, configure provider-level rate limiting for `POST /api/propose` and support the route's declared 50-second execution window.

## License

Released under the [MIT License](LICENSE).
