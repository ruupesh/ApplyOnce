# Assistant implementation

The feature lives in `ApplyOnce Extension/Resources/llm/`. The editor loads its controller only when the Assistant tab opens. No backend or framework is required.

| File | Responsibility |
| --- | --- |
| `llm-store.js` | Provider catalog, model recommendations, settings, bounded transcript |
| `llm-ui.js` | Chat, model/key controls, attachment toggles, page selection, progress and errors |
| `llm-tools.js` | Read-only context from the profile, resume, applications, and chosen tab |
| `llm-resume.js` | Local PDF, DOCX, and plain-text extraction |
| `llm-providers.js` | Shared SSE reader and three HTTP adapters for five providers |
| `llm-local.js` | Worker client, runtime setup, pipeline reuse/disposal, context limit |
| `llm-worker.js` | Local generation outside the editor's UI thread |
| `llm-agent.js` | Validated action proposals, profile updates, form preview and execution |

To remove the feature, remove these scripts, their script tags, the Assistant tab/toolbar/section and its CSS. The generic tab controller tolerates missing tabs. The content script provides page inspection plus the reviewed `JAA_AGENT_SET_FIELDS` and `JAA_AGENT_FILL_FORM` actions; it does not expose a submit action.

## Local inference

Transformers.js 4.2.0 uses the matching ONNX Runtime asyncify backend for WebGPU and the plain backend for WASM. The build script checks the exact installed runtime dependency before copying files. Browser extensions load executable code from packaged resources; model weights download as data. Builds with no vendor runtime can use API providers.

The general default precision is `q4`, and older stored `q4f16` preferences migrate to that default. Qwen3 and DeepSeek-R1-Distill-Qwen are explicit WebGPU exceptions that use their officially supported `q4f16` graphs. Qwen3's `q4` graph fails in Chrome with an unaligned-access error. DeepSeek 1.5B is pinned to the repository's GQA revision `61425627ba20650f3540d034589d35f00514ba7c`; ONNX Community recommends the revision before the later MHA export for runtime problems. A usable GPU adapter and packaged GPU loader are required; otherwise the worker uses WASM with `q4`. Only one model stays loaded per editor. Switching models disposes the old pipeline; Stop terminates the worker, including pending downloads. Successfully cached files remain for reuse.

The **Model parameters** panel stores separate settings for each on-device model. It controls context window, output limit, sampling, temperature, top-p, top-k, and repetition penalty and can restore the model defaults. Users can select up to a 65,536-token context and 16,384-token output. The effective context remains bounded by the model's own `max_position_embeddings`, and output is kept at least 128 tokens below that effective context. DeepSeek R1 Qwen 1.5B defaults to a 4,096-token context and 512 output tokens without sampling; larger values consume substantially more working memory. Recent local-model history is capped at 8,000 characters, and older turns are removed as needed. Attachments share a 6,000-character budget. These lightweight models are useful for short drafts, but their output quality varies.

## Data boundaries

- `jaaLLM` stores keys and chat separately from `jaaState`; profile exports exclude both.
- Only selected attachments are read. The page selector identifies the web tab, and messaging targets its top frame.
- Hosted providers receive the transcript and selected context. Older assistant replies can retain information from previous attachments.
- PDF and DOCX parsing happens locally. PDF.js is optional and loads only for PDFs. DOCX reads only `word/document.xml`, with a 4 MiB decompressed limit. PDF extraction reads up to 20 pages and stops at the text budget; it does not OCR images.
- Model download removal targets only Hugging Face cache entries for the selected model.

## Agent actions

Direct commands such as `Set my city to Pune`, `In address line 2, add Baner`, and `Fill this form` are parsed locally, so they do not wait for a model. More complex requests can use the same action protocol through a model response. The supported actions are `set_field`, `append_field`, and `fill_form`; malformed, excessive, sensitive, file-field, or unknown actions are rejected.

All actions render as a review card. **Apply actions** is the only path that mutates profile data or a page. Profile changes use one storage transaction and enter the activity log. Before form filling, the selected top-level tab is inspected and its title, URL, and matching fields are shown. Apply fails if that tab navigated after review. The content script fills through the existing site adapters, preserves non-empty user input, excludes sensitive labels, and has no submit action.

The content script exposes one shared field inventory to the popup and Assistant. Each item includes its label, control type, required marker, current filled/empty state, saved profile match, and whether autofill is available. The popup lists filled and empty field names alongside their counts. Targeted chat edits may overwrite the reviewed field on the current page, while general form filling continues to preserve user-entered values. An approved targeted edit also updates the profile, so it is restored on later page loads.

## Reasoning models and Markdown

Qwen3 ONNX models use thinking mode by default with the sampling settings recommended for that model family. Users can change those settings within the browser-safe 4,096-token reply and 8,192-token context limits. During generation the transcript displays **Reasoning…** instead of exposing the model's `<think>` block. Only the final answer is saved and displayed. If thinking consumes the selected reply budget, the UI explains that the request should be shortened, given a larger output limit, or sent with `/no_think`.

Assistant answers render headings, lists, emphasis, links, block quotes, inline code, and fenced code blocks. Rendering uses DOM text nodes and permits only HTTP, HTTPS, and mail links, so model-written HTML or JavaScript is never executed.

## Validation

`npm test` covers storage/manifest/autofill regressions, model disposal and cancellation, settings migration, UTF-8 resume text, streamed provider errors and fragmented SSE, all five request adapters, and page selection.

Chrome DevTools checks exercised local generation inside the installed extension's security policy, Qwen3 WebGPU inference, worker cancellation, local PDF/DOCX extraction using synthetic resumes, missing-key errors, narrow-screen layout, and agent profile-update/form-fill flows. DeepSeek R1 Qwen 1.5B loaded its pinned GQA `q4f16` graph and generated a response on Apple WebGPU; this reproduced and resolved the `std::bad_alloc` session failure seen with the later MHA export. A live Workday regression filled repeated experience rows, segmented dates, education, exact autocomplete skill values, and advanced through site validation without submitting the application. The agent test also confirmed that a reviewed chat command updated a temporary profile field, filled its matching empty input, preserved manually typed text, ignored a password field, and never submitted. SmolLM2 135M and 360M produced readable output with `q4`; Gemma 3 270M also produced a readable answer in Chrome. Hosted API adapters were tested with mocked responses, not paid live requests. Safari/iPhone behavior and live hosted-provider actions still require device testing.

API reference: [Transformers.js](https://huggingface.co/docs/transformers.js/), [PDF.js](https://mozilla.github.io/pdf.js/examples/), [Gemini API](https://ai.google.dev/api).
