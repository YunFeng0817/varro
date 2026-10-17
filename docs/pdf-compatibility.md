# PDF attachment compatibility

Verified October 16, 2026 local time, October 17 UTC. External model receipt remains unverified.

## What Varro sends

Pick, paste, or drop a PDF to attach its native bytes. The composer keeps a PDF label even when the selected model cannot use it. Sending requires an explicit PDF input modality in the model catalog. A missing capability is unknown, not supported. Model names, generic attachment flags, and MIME or filename alone do not establish support.

Unsupported or unknown capability leaves the draft and PDF intact. For V2, the extension checks the location-scoped native catalog before changing the session model, committing an edit, or submitting the PDF. An older backend without that catalog gets a verification error. This is a capability guard, not a claim that every backend advertising PDFs implements them correctly.

V2 one-shot generation does not accept PDFs. PDF submission through configured commands is also blocked: the command catalog does not expose the model/agent overrides needed to verify the receiving model. Send a regular prompt instead.

PDFs travel as `application/pdf` data URLs, with a 20 MiB decoded aggregate limit and a 512-character filename limit. The host checks base64, header, size and aggregate bounds. It does not parse the PDF structure. A corrupt document with a valid header may be admitted and then rejected by the provider. Varro never silently extracts text, rasterizes pages, substitutes a local path, or resends after uncertain admission.

Queued snapshots retain bytes and attachment sequence. Mixed image/PDF pastes reserve sequence numbers before asynchronous reads, so completion order cannot reorder them. Picker selections preserve arrival order across PDFs and other files. V2 separates prompt text from its ordered attachment array; it does not preserve arbitrary interleaving between prompt text segments and files.

Ordinary unsent PDFs are not persisted across window reloads. Queued PDFs are persisted. Existing deferred history/content retrieval remains unchanged; this feature does not add media to session summaries or repair existing history. Separately hosted remote profiles have not been verified. Local `file:` references are not uploads to a remote server.

## Tested combinations

The implementation path is:

| Layer | Source and responsibility |
| --- | --- |
| Selection | `ChatInput.tsx` reads dropped/pasted bytes; `sidebar-provider-context-files.ts` reads picked PDFs and rejects out-of-policy files without a path fallback |
| Validation | `shared/native-pdf.ts`, `extension/util/webview-message.ts`, and `shared/extension-message.ts` validate MIME, header, base64, size and aggregate bounds at transport boundaries |
| Queue | `getQueuedAttachmentSnapshot` in `session-send.ts` copies native PDFs and their sequence; `queued-message-store.ts` persists the authoritative snapshot; `queued-steer.ts` restores routing |
| Dispatch | `buildSessionSendBody` sorts attachments by sequence and sends native PDF file parts; `opencode-v2-adapter.ts` checks native capability and maps file parts to `{ uri, name }` |
| Native retention and conversion | Isolated inbox/history reads preserve the attachment; the bundled OpenAI-compatible converter emits `file.file_data` |
| History | `opencode-v2-projection.ts` restores inline data URLs or retained source URIs with stable content IDs; `rest-proxy.ts` keeps ordinary history deferred and scoped detail requests separate |

| Backend / client | Provider / model | Advertised PDF input | Payload and admission | Provider conversion | Model receipt |
| --- | --- | --- | --- | --- | --- |
| OpenCode 2.0.31 / `@opencode/client` 2.0.32 | Bundled `@opencode/ai/providers/openai-compatible`, local `fixture-pdf` | Explicit `pdf` | Native data URL admitted; pending and delivered history retain bytes | Exact `file.file_data` data URL and filename received for a 591-byte text PDF and a 683-byte image-only PDF | Not tested; HTTP fixture only |
| Same versions | Same local provider, text-only `fixture` | No PDF input | Varro rejects before admission; no model request | Not attempted | Not attempted |
| Same versions | Same local provider, `fixture-pdf-error` | Explicit `pdf` | Native admission succeeds | Receiver returns HTTP 400; clear persisted provider error; one prompt and one provider request, no resend | Not tested |
| V1, older V2, external providers/models, separately hosted remote profiles | Not selected for this verification | Unknown | Not verified | Not verified | Not verified |

The provider implementation is bundled with OpenCode 2.0.31; its independent package version was not exposed by this test. The two synthetic PDFs contain no user data. The text fixture has a document-only marker; the image fixture contains a green square. Fixture acceptance does not establish that a real model can interpret either.

Evidence from the isolated receiver run is in `artifacts/ai-test-data/ai-client-UAfsS2/pdf-compatibility.json`, beside `result.json` with verified database ownership and session cleanup. The database lives under `artifacts/ai-test-data/`; no production sessions or credentials were used. Diagnostics record hashes and sizes, not PDF data URLs or document text.

## Findings fixed

| Severity / behavior | Expected versus observed before the fix | Fix and verification |
| --- | --- | --- |
| Medium, unsupported PDF sending | Native bytes or a visible rejection; path-backed PDFs instead became text references and unbacked PDFs could be omitted by the payload builder | Reject unsupported/unknown input while preserving the draft. V2 also reads native capabilities before mutations. `session-send.test.ts`, `session-send-factory.test.ts`, `opencode-v2.test.ts`, and the browser regression pass. |
| Medium, picker bounds | Oversized PDFs should fail locally; they instead fell through to ordinary path context | Reject before reading or posting a path, with visible feedback. `sidebar-provider-context-files.test.ts` checks zero reads and zero attachment posts. |
| Low, picker order | Mixed selections should retain selection order; PDFs were posted before other files | Post consecutive type groups in order, retaining one message for adjacent files of the same type. The picker tests check order and batching. |
| Medium, paste order | Image/PDF/image should retain clipboard order; a PDF that finished first received the first sequence | Reserve sequences before reads. The controlled completion regression in `ChatInput.test.ts` reproduced the old reversal and now passes. |

These fixes have deterministic regressions. No further fix is indicated by the passing checks; rerun the listed cases when changing attachment admission or sequence allocation.

## Upstream source versus documentation

The [V2 attachment guide](https://opencode.ai/v2/docs/attachments/#formats), checked on the verification date, still says PDFs are not included in model requests. That disagrees with the tested 2.0.31 native path. The available source checkout, commit `07bbd0fd166c82d87e79f053dc70e6fdb66f88ac`, also includes PDF materialization, media conversion, and a PDF input capability check. The checkout was read only and was not the tested executable.

The distinction matters: accepting a PDF in a composer proves neither native admission nor provider conversion. Receiving bytes at a local fixture proves conversion, not model comprehension. No universal provider-support claim or inferred minimum backend version follows from this result. No upstream issue was filed.

## Verification and remaining work

Run the deterministic validation, composer, ordering, prompt, inbox, queue-persistence and history tests. The browser regression is `e2e/tests/pdf-compatibility.spec.ts`; it checks blocked sending, visible feedback, draft preservation and explicit removal at 380px and 1280px.

To repeat native conversion without provider credentials:

```sh
VARRO_OPENCODE_TEST_BINARY=/absolute/path/to/opencode node --test scripts/ai-opencode-client.integration.test.mjs
```

This creates its own server, database, workspace and local HTTP receiver, verifies listener/database ownership, and deletes only its disposable sessions. V2 runs five PDF cases and saves the exact server/client versions with the evidence. It never sends a document to an external service.

A real-model receipt check still needs an explicitly selected supported combination in a verified isolated backend, following [AI verification](ai-test-workflow.md) and the OpenAI subscription policy. Use an allowed configured OpenAI model only if its authoritative catalog advertises `pdf`. Ask it to report the text fixture's marker without putting the marker in the prompt, disable tools, and make at most one request per fixture. Test the image-only fixture separately. Record exact versions, capability, admission, conversion and answer independently. Do not substitute a correct fixture HTTP response for that result.

| Scope | Tested behavior | Issues found | All cases complete |
| --- | --- | --- | --- |
| Deterministic and browser checks | OK in tested cases | Silent PDF path fallback, picker bounds/order, and mixed-paste completion ordering fixed with regressions | Yes, 1,392 targeted tests and 2 browser cases |
| V2 local fixture provider | OK | None remaining in five PDF cases | Yes, 5/5 |
| External model receipt and remote profiles | Not verified | Unknown | No, no explicit live combination selected |

No additional product fixes follow from the passing receiver checks. Remaining work is verification, not a demonstrated provider or model defect. Disabling native sending must not remove stored attachments, queues or native history.

Commands run after implementation:

| Command | Result |
| --- | --- |
| `npm run lint` | Passed; output redirected to a local log after the tool renderer could not parse the direct output |
| `npm run fmt` | Passed |
| `npm run test --` with the 16 PDF/attachment-related suites | Passed, 1,392 tests |
| `npm run typecheck` | Passed |
| `npm run typecheck:suggestions` | Passed, zero diagnostics |
| `npm run build` | Passed |
| `npm run test:e2e -- e2e/tests/pdf-compatibility.spec.ts` | Passed, 2 cases |
| `VARRO_OPENCODE_TEST_BINARY=/Users/andrew/.bun/bin/opencode node --test scripts/ai-opencode-client.integration.test.mjs` | Passed, 6 tests including 5 PDF cases; disposable sessions deleted |
| `git diff --check` | Passed |
