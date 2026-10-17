import assert from 'node:assert/strict';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import test from 'node:test';
import { chromium } from '@playwright/test';
import { AiOpenCodeClient } from './ai-opencode-client.mjs';
import { requireIsolatedTestServer } from './ai-test-isolation.mjs';
import { CdpController, clickOpenInEditor } from './ai-fuzzy-live.mjs';
import { cleanupOwnedHost } from './ai-streaming.mjs';
import { reloadVscodeWindow, reserveLoopbackPort } from './vscode-launch-process.mjs';

const binary = process.env.VARRO_OPENCODE_TEST_BINARY;

test(
  'restart continuity against an isolated native managed V2 service',
  {
    skip: !binary,
    timeout: 240_000,
  },
  async (t) => {
    const version = execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim();
    assert.match(version, /v?2\./, 'This recovery suite requires a native V2 executable');
    const parent = path.resolve('artifacts/ai-test-data');
    await mkdir(parent, { recursive: true });
    const root = await mkdtemp(path.join(parent, 'restart-recovery-'));
    for (const name of [
      'home',
      'data/opencode',
      'state/opencode',
      'config/opencode',
      'cache',
      'workspace',
    ])
      await mkdir(path.join(root, name), { recursive: true });
    const workspace = path.join(root, 'workspace');
    execFileSync('git', ['init', '--quiet'], { cwd: workspace });
    const password = randomUUID();
    const previousPassword = process.env.OPENCODE_SERVER_PASSWORD;
    process.env.OPENCODE_SERVER_PASSWORD = password;
    const evidence = { version, root, cases: [], requests: [], isolation: [] };
    const gates = new Map();
    const requests = [];
    const pendingResponses = new Map();
    const respond = (response, content, tool) => {
      if (response.destroyed) return;
      const chunk = (delta, finish_reason = null) =>
        response.write(
          `data: ${JSON.stringify({
            id: 'chatcmpl-recovery',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'fixture',
            choices: [{ index: 0, delta, finish_reason }],
          })}\n\n`
        );
      if (tool)
        chunk({
          tool_calls: [
            {
              index: 0,
              id: `call_${randomUUID()}`,
              type: 'function',
              function: { name: tool.name, arguments: JSON.stringify(tool.arguments) },
            },
          ],
        });
      else chunk({ content });
      chunk({}, tool ? 'tool_calls' : 'stop');
      response.end('data: [DONE]\n\n');
    };
    const provider = http.createServer(async (request, response) => {
      try {
        const body = JSON.parse(Buffer.concat(await Array.fromAsync(request)).toString());
        requests.push(body);
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.flushHeaders();
        const text = JSON.stringify(body.messages);
        const marker = [...gates.keys()].find((key) => text.includes(key));
        if (marker && gates.get(marker)) {
          pendingResponses.set(marker, response);
          response.write(
            `data: ${JSON.stringify({
              id: 'chatcmpl-recovery',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'fixture',
              choices: [{ index: 0, delta: { content: 'RECOVERY-PARTIAL ' }, finish_reason: null }],
            })}\n\n`
          );
          return;
        }
        const hasTool = body.messages.some((message) => message.role === 'tool');
        const userText = JSON.stringify(body.messages.filter((message) => message.role === 'user'));
        if (userText.includes('RECOVERY-CHILD-PARENT') && !hasTool) {
          const tool = body.tools.find((entry) => entry.function.name.endsWith('subagent'));
          assert.ok(tool, 'Native subagent tool is advertised');
          respond(response, '', {
            name: tool.function.name,
            arguments: {
              agent: 'general',
              description: 'Recovery child approval',
              prompt: 'RECOVERY-CHILD-APPROVAL',
              background: true,
            },
          });
        } else if (
          !userText.includes('RECOVERY-CHILD-PARENT') &&
          userText.includes('RECOVERY-CHILD-APPROVAL') &&
          !body.messages.some(
            (message) =>
              message.role === 'tool' && JSON.stringify(message.content).includes('CHILD-EFFECT')
          )
        ) {
          const tool = body.tools.find((entry) => entry.function.name.endsWith('shell'));
          assert.ok(tool, 'Child shell tool is advertised');
          respond(response, '', {
            name: tool.function.name,
            arguments: {
              command: `python3 -c 'from pathlib import Path; Path("child-effect.txt").write_text("idempotent-child-effect"); print("CHILD-EFFECT")'`,
              workdir: workspace,
            },
          });
        } else if (
          text.includes('RECOVERY-SHELL') &&
          !hasTool &&
          !text.includes('server restarted')
        ) {
          const tool = body.tools.find((entry) => entry.function.name.endsWith('shell'));
          assert.ok(tool, 'Native shell tool is advertised');
          respond(response, '', {
            name: tool.function.name,
            arguments: {
              command: `python3 -c 'from pathlib import Path; import time; Path("recovery-effect.txt").write_text("idempotent-effect"); time.sleep(5)'`,
              workdir: workspace,
              background: true,
            },
          });
        } else
          respond(
            response,
            text.includes('server restarted') ? 'RECOVERY-RESUMED' : 'RECOVERY-COMPLETE'
          );
      } catch (error) {
        response.destroy(error);
      }
    });
    await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
    await writeFile(
      path.join(root, 'config/opencode/opencode.json'),
      JSON.stringify({
        providers: {
          fixture: {
            package: '@opencode/ai/providers/openai-compatible',
            settings: {
              baseURL: `http://127.0.0.1:${provider.address().port}/v1`,
              apiKey: 'fixture-only',
            },
            models: {
              fixture: {
                name: 'Recovery fixture',
                capabilities: { tools: true },
                limit: { context: 32000, output: 1000 },
              },
            },
          },
        },
      })
    );
    // Only this disposable service receives these private registration/configuration paths.
    await writeFile(path.join(root, 'config/opencode/service.json'), JSON.stringify({ password }), {
      mode: 0o600,
    });
    const environment = {
      PATH: process.env.PATH,
      HOME: path.join(root, 'home'),
      XDG_DATA_HOME: path.join(root, 'data'),
      XDG_STATE_HOME: path.join(root, 'state'),
      XDG_CONFIG_HOME: path.join(root, 'config'),
      XDG_CACHE_HOME: path.join(root, 'cache'),
      OPENCODE_DB: path.join(root, 'data/opencode/opencode.db'),
      OPENCODE_TEST_HOME: path.join(root, 'home'),
      OPENCODE_DISABLE_AUTOUPDATE: 'true',
      OPENCODE_DISABLE_MODELS_FETCH: 'true',
      OPENCODE_SERVER_PASSWORD: password,
    };
    const port = await reserveLoopbackPort();
    const url = `http://127.0.0.1:${port}`;
    let client;
    let child;
    let exited;
    let logs = '';
    let launch;
    let cdp;
    const wait = async (predicate, description, timeout = 15_000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const result = await predicate();
        if (result) return result;
        await delay(100);
      }
      throw new Error(`Recovery fixture timeout: ${description}`);
    };
    const verify = async () => {
      const isolation = await requireIsolatedTestServer(
        url,
        workspace,
        parent,
        path.join(root, 'data/opencode')
      );
      assert.equal(
        isolation.serverPid,
        child.pid,
        'Verified listener/database belong to the exact launched process'
      );
      const registration = JSON.parse(
        await readFile(path.join(root, 'state/opencode/service.json'), 'utf8')
      );
      assert.equal(registration.pid, child.pid);
      assert.equal(new URL(registration.url).port, String(port));
      evidence.isolation.push(isolation);
      return isolation;
    };
    const start = async () => {
      assert.ok(
        !child || child.exitCode !== null || child.signalCode !== null,
        'Predecessor is dead before replacement'
      );
      child = spawn(
        binary,
        ['serve', '--service', '--hostname', '127.0.0.1', '--port', String(port)],
        {
          cwd: workspace,
          env: environment,
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );
      exited = once(child, 'exit');
      for (const stream of [child.stdout, child.stderr])
        stream.on('data', (chunk) => {
          logs += chunk.toString().replaceAll(password, '[redacted]');
        });
      await wait(
        async () => {
          try {
            const response = await fetch(`${url}/api/info`, {
              headers: {
                authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`,
              },
              signal: AbortSignal.timeout(500),
            });
            return response.ok;
          } catch {
            return false;
          }
        },
        'authenticated managed-service readiness',
        30_000
      );
      client = new AiOpenCodeClient(url, workspace);
      return verify();
    };
    const stop = async (signal) => {
      await verify();
      child.kill(signal);
      await Promise.race([
        exited,
        delay(10_000, undefined, { ref: false }).then(() => {
          throw new Error('Owned service did not exit');
        }),
      ]);
      assert.ok(child.exitCode !== null || child.signalCode !== null);
    };
    const history = async (id) =>
      (await client.wire('GET', `/api/session/${id}/message?limit=200`)).data;
    const idle = async (id) => !(await client.wire('GET', '/api/session/active')).data[id];
    const shells = async () =>
      (
        await client.wire(
          'GET',
          `/api/shell?location%5Bdirectory%5D=${encodeURIComponent(workspace)}`
        )
      ).data;
    const createSession = async (
      title,
      permissions = [{ action: '*', resource: '*', effect: 'allow' }]
    ) =>
      (
        await client.wire('POST', '/api/session', {
          title,
          location: { directory: workspace },
          model: { providerID: 'fixture', id: 'fixture' },
          permissions,
          metadata: { varro: { permissionMode: 'default' } },
        })
      ).data;
    const send = async (id, text) =>
      client.wire('POST', `/api/session/${id}/prompt`, {
        text,
        model: { providerID: 'fixture', id: 'fixture' },
      });
    const claim = (id) => {
      const database = new DatabaseSync(environment.OPENCODE_DB, { readOnly: true });
      try {
        return database
          .prepare(
            'SELECT id, time_suspended, resume_attempts, idle_outcome FROM session_v2 WHERE id = ?'
          )
          .get(id);
      } finally {
        database.close();
      }
    };
    const capture = async (name, id) => {
      const canonical = await history(id);
      const projected = await client.request('GET', `/session/${id}/message?limit=1000`);
      const state = {
        canonical,
        projected,
        active: (await client.wire('GET', '/api/session/active')).data,
        inbox: (await client.wire('GET', `/api/session/${id}/inbox`)).data,
      };
      if (cdp) {
        state.editor = await readSnapshot();
        const browser = await chromium.connectOverCDP(
          `http://127.0.0.1:${launch.remoteDebuggingPort}`
        );
        try {
          const workbench = browser
            .contexts()
            .flatMap((context) => context.pages())
            .find((page) => page.url().includes('workbench.html'));
          await workbench.screenshot({ path: path.join(root, `${name}.png`) });
        } finally {
          await browser.close();
        }
      }
      await writeFile(path.join(root, `${name}.json`), JSON.stringify(state, null, 2));
      return state;
    };
    const readSnapshot = async (controller = cdp) => {
      const snapshot = await controller.snapshot();
      if (!snapshot.routeSessionId) {
        // Sidebar persistence is workspace-scoped; the older controller fallback
        // only reads the unscoped key used by editor tabs.
        const route = await controller.call('Runtime.evaluate', {
          contextId: controller.mainContextId,
          expression: `(() => {
            const key = ${JSON.stringify(`varro.lastOpenedView:${workspace}`)};
            const saved = globalThis.__vscodeWebviewState?.getState?.()?.[key] ?? JSON.parse(localStorage.getItem(key) || 'null');
            return saved?.type === 'session' ? saved.sessionId : null;
          })()`,
          returnByValue: true,
        });
        snapshot.routeSessionId = route.result?.value ?? null;
      }
      return snapshot;
    };
    const run = async (name, operation) =>
      t.test(name, async () => {
        const result = {
          name,
          status: 'RUNNING',
          editor: Boolean(cdp),
          provider: 'deterministic-local-fixture',
        };
        evidence.cases.push(result);
        await writeFile(path.join(root, 'results.json'), JSON.stringify(evidence, null, 2));
        try {
          await operation(result);
          result.status = 'PASS';
        } catch (error) {
          result.status = 'FAIL';
          result.error = error.stack;
          if (cdp) result.editorFailure = await readSnapshot().catch(() => null);
          if (cdp)
            result.editorFailureText = await cdp
              .evaluate('document.body.innerText.slice(-4000)')
              .catch(() => null);
          if (result.sessionID) {
            result.historyFailure = await history(result.sessionID).catch(() => null);
            await client
              .wire('POST', `/api/session/${result.sessionID}/interrupt?resume=false`, {})
              .catch(() => {});
          }
          throw error;
        } finally {
          await writeFile(path.join(root, 'results.json'), JSON.stringify(evidence, null, 2));
        }
      });
    t.after(async () => {
      try {
        cdp?.close();
        if (launch) await cleanupOwnedHost(launch);
        if (child && child.exitCode === null && child.signalCode === null) await stop('SIGTERM');
        evidence.cleanup = {
          editor: launch ? 'stopped' : 'not-launched',
          serviceStopped: child.exitCode !== null || child.signalCode !== null,
        };
      } finally {
        provider.closeAllConnections();
        await new Promise((resolve) => provider.close(resolve));
        evidence.requests = requests;
        await writeFile(path.join(root, 'server.log'), logs);
        await writeFile(path.join(root, 'results.json'), JSON.stringify(evidence, null, 2));
        if (previousPassword === undefined) delete process.env.OPENCODE_SERVER_PASSWORD;
        else process.env.OPENCODE_SERVER_PASSWORD = previousPassword;
        t.diagnostic(`Recovery evidence: ${root}`);
      }
    });
    await start();
    if (process.env.VARRO_AI_TEST_EDITOR === '1') {
      const { stdout } = await promisify(execFile)(
        process.execPath,
        ['scripts/launch-ai-vscode.mjs'],
        {
          env: {
            ...process.env,
            VARRO_AI_SERVER_URL: url,
            VARRO_AI_WORKSPACE: workspace,
            VARRO_AI_DATA_DIR: path.join(root, 'data/opencode'),
          },
          timeout: 60_000,
        }
      );
      launch = JSON.parse(await readFile(stdout.match(/Launch metadata: (.+)/)[1], 'utf8'));
      cdp = await CdpController.connect(launch.remoteDebuggingPort, {
        surface: 'sidebar',
        viewId: 'sidebar',
      });
    }
    const open = async (session) => {
      if (!cdp) return;
      if ((await readSnapshot()).title === session.title) return;
      await cdp.click('[aria-label="Back to sessions"]');
      await wait(
        async () =>
          (await readSnapshot()).title === session.title ||
          (await cdp.point(`.session-item[data-session-id="${session.id}"] .session-item-main`)),
        'session appears'
      );
      if ((await readSnapshot()).title === session.title) return;
      assert.ok(
        await cdp.click(`.session-item[data-session-id="${session.id}"] .session-item-main`)
      );
      await wait(
        async () => (await readSnapshot()).title === session.title,
        'correct session route'
      );
    };

    for (const signal of ['SIGTERM', 'SIGKILL'])
      await run(`native recovery after ${signal}`, async (result) => {
        const marker = `RECOVERY-${signal}`;
        const session = await createSession(marker);
        result.sessionID = session.id;
        await open(session);
        gates.set(marker, true);
        if (cdp) {
          assert.ok(await cdp.click('[aria-label="Message composer"]'));
          await cdp.call('Input.insertText', { text: marker });
          await wait(() => cdp.point('.chat-send-button:not(.disabled)'), 'Send enabled');
          assert.ok(await cdp.click('.chat-send-button:not(.disabled)'));
        } else await send(session.id, marker);
        await wait(
          async () => (await history(session.id)).some((m) => m.type === 'assistant'),
          'durable unfinished assistant'
        );
        result.claimBefore = claim(session.id);
        assert.notEqual(result.claimBefore.time_suspended, null);
        let editor;
        let editorViewId;
        if (cdp && signal === 'SIGKILL') {
          assert.ok(await cdp.contextClick('.chat-header-session-title'));
          assert.ok(await clickOpenInEditor(cdp));
          editor = await CdpController.connect(launch.remoteDebuggingPort, {
            surface: 'editor',
            sessionId: session.id,
          });
          editorViewId = editor.targetContext.viewId;
          result.viewIds = ['sidebar', editorViewId];
        }
        const beforePid = child.pid;
        await capture(`${signal}-before`, session.id);
        await stop(signal);
        gates.set(marker, false);
        await start();
        assert.notEqual(child.pid, beforePid);
        await wait(
          async () =>
            (await history(session.id)).some((m) => JSON.stringify(m).includes('RECOVERY-RESUMED')),
          'native continuation'
        );
        await wait(() => idle(session.id), 'native terminal outcome');
        if (cdp) {
          editor?.close();
          cdp.close();
          await reloadVscodeWindow(launch.remoteDebuggingPort);
          cdp = await CdpController.connect(launch.remoteDebuggingPort, { viewId: 'sidebar' });
          if (editorViewId) {
            editor = await CdpController.connect(launch.remoteDebuggingPort, {
              viewId: editorViewId,
            });
            assert.equal((await readSnapshot(editor)).routeSessionId, session.id);
            await wait(
              () => editor.evaluate(`document.body.textContent.includes('RECOVERY-RESUMED')`),
              'second webview recovered transcript'
            );
            result.editorAfter = await readSnapshot(editor);
            editor.close();
          } else {
            await wait(
              () => cdp.evaluate(`document.body.textContent.includes('RECOVERY-RESUMED')`),
              'restored recovered transcript'
            );
          }
        }
        const state = await capture(`${signal}-after`, session.id);
        assert.equal(
          state.canonical.filter((m) => m.type === 'user').length,
          1,
          'No Varro continuation user'
        );
        assert.equal(
          state.canonical.filter((m) => m.type === 'synthetic' && m.metadata?.notice === 'restart')
            .length,
          1
        );
        assert.equal(
          requests.filter((body) => JSON.stringify(body.messages).includes(marker)).length,
          2
        );
        assert.equal(state.inbox.length, 0);
        result.claimAfter = claim(session.id);
        assert.equal(result.claimAfter.time_suspended, null);
      });

    await run(
      'brief event subscription loss restores canonical terminal state without restarting',
      async (result) => {
        const marker = 'RECOVERY-SSE';
        const session = await createSession(marker);
        result.sessionID = session.id;
        await open(session);
        gates.set(marker, true);
        const subscription = new AbortController();
        const response = await fetch(
          `${url}/api/event?location%5Bdirectory%5D=${encodeURIComponent(workspace)}`,
          {
            headers: {
              authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`,
            },
            signal: subscription.signal,
          }
        );
        assert.equal(response.status, 200);
        const reader = response.body.getReader();
        await reader.read();
        await send(session.id, marker);
        await wait(() => pendingResponses.has(marker), 'active provider stream');
        const pid = child.pid;
        subscription.abort();
        await reader.cancel().catch(() => {});
        gates.set(marker, false);
        respond(pendingResponses.get(marker), 'RECOVERY-MISSED-TERMINAL');
        await wait(() => idle(session.id), 'terminal outcome during event loss');
        const reattached = new AiOpenCodeClient(url, workspace);
        const canonical = await reattached.request(
          'GET',
          `/session/${session.id}/message?limit=1000`
        );
        assert.ok(
          canonical.some((m) => m.parts.some((p) => p.text?.includes('RECOVERY-MISSED-TERMINAL')))
        );
        assert.equal(canonical.filter((m) => m.info.role === 'user').length, 1);
        assert.equal(child.pid, pid);
        assert.equal(
          requests.filter((body) => JSON.stringify(body.messages).includes(marker)).length,
          1
        );
        await capture('sse-after', session.id);
      }
    );

    await run(
      'native pending inputs survive service and editor restart without execution',
      async (result) => {
        const session = await createSession('RECOVERY-PENDING');
        result.sessionID = session.id;
        await open(session);
        const input = (
          await client.wire('POST', `/api/session/${session.id}/prompt`, {
            text: 'RECOVERY-PENDING-DO-NOT-EXECUTE',
            resume: false,
            delivery: 'queue',
          })
        ).data;
        const before = requests.filter((body) =>
          JSON.stringify(body.messages).includes('RECOVERY-PENDING-DO-NOT-EXECUTE')
        ).length;
        await stop('SIGTERM');
        await start();
        if (cdp) {
          cdp.close();
          await reloadVscodeWindow(launch.remoteDebuggingPort);
          cdp = await CdpController.connect(launch.remoteDebuggingPort, { viewId: 'sidebar' });
          await wait(() => cdp.point(`[data-msg-id="${input.id}"]`), 'native pending fallback');
        }
        const state = await capture('pending-after', session.id);
        assert.deepEqual(
          state.inbox.map((item) => item.id),
          [input.id]
        );
        assert.equal(
          state.projected.find((m) => m.info.id === input.id).info.pendingDelivery,
          'queue'
        );
        assert.equal(
          requests.filter((body) =>
            JSON.stringify(body.messages).includes('RECOVERY-PENDING-DO-NOT-EXECUTE')
          ).length,
          before
        );
      }
    );

    await run(
      'active background shell is cancelled, not presented as a surviving process',
      async (result) => {
        const session = await createSession('RECOVERY-SHELL');
        result.sessionID = session.id;
        await open(session);
        await send(session.id, 'RECOVERY-SHELL');
        await wait(
          async () => (await shells()).some((shell) => shell.status === 'running'),
          'actual running shell'
        );
        await wait(async () => {
          try {
            return (
              (await readFile(path.join(workspace, 'recovery-effect.txt'), 'utf8')) ===
              'idempotent-effect'
            );
          } catch {
            return false;
          }
        }, 'actual disposable side effect');
        await wait(() => idle(session.id), 'background command admitted and owner idle');
        assert.ok(
          (await shells()).some((shell) => shell.status === 'running'),
          'Shell is still active at the death boundary'
        );
        await stop('SIGKILL');
        await start();
        await wait(
          async () =>
            JSON.stringify(await client.wire('GET', `/api/session/${session.id}/inbox`)).includes(
              'Command cancelled because the server restarted'
            ),
          'canonical lost-shell notice'
        );
        const state = await capture('shell-after', session.id);
        assert.ok(!(await shells()).some((shell) => shell.status === 'running'));
        assert.equal(
          await readFile(path.join(workspace, 'recovery-effect.txt'), 'utf8'),
          'idempotent-effect'
        );
        assert.ok(
          state.projected.some((m) =>
            m.parts.some((part) =>
              part.text?.includes('Command cancelled because the server restarted')
            )
          )
        );
        if (cdp) {
          const notice = state.inbox.find((item) => item.type === 'synthetic');
          await wait(
            () => cdp.point(`[data-msg-id="${notice.id}"] .assistant-activity-summary`),
            'lost shell visible without waking idle owner'
          );
          assert.ok(await cdp.click(`[data-msg-id="${notice.id}"] .assistant-activity-summary`));
          await wait(
            () =>
              cdp.evaluate(`document.body.textContent.includes('Background command cancelled:')`),
            'honest lost-shell label'
          );
          await wait(
            () => cdp.evaluate(`!document.querySelector('.stop-button')`),
            'lost shell no longer owns the busy indicator'
          );
          await capture('shell-visible', session.id);
        }
      }
    );

    await run(
      'actual background child restores an actionable approval in its parent',
      async (result) => {
        const session = await createSession('RECOVERY-CHILD-PARENT', [
          { action: '*', resource: '*', effect: 'allow' },
          { action: 'shell', resource: '*', effect: 'ask' },
        ]);
        result.sessionID = session.id;
        await open(session);
        await send(session.id, 'RECOVERY-CHILD-PARENT');
        const children = await wait(async () => {
          const childSessions = (await client.wire('GET', `/api/session?parentID=${session.id}`))
            .data;
          return childSessions.length === 1 && childSessions;
        }, 'actual model-created child');
        const childID = children[0].id;
        result.childID = childID;
        const pending = async () =>
          (await client.wire('GET', `/api/session/${childID}/permission`)).data;
        await wait(async () => (await pending()).length === 1, 'child approval before restart');
        await stop('SIGKILL');
        await start();
        const restored = await wait(async () => {
          const pendingRequests = await pending();
          return pendingRequests.length === 1 && pendingRequests[0];
        }, 'native child recovery approval');
        assert.equal(restored.sessionID, childID);
        result.restoredPermissionID = restored.id;
        if (cdp) {
          cdp.close();
          await reloadVscodeWindow(launch.remoteDebuggingPort);
          cdp = await CdpController.connect(launch.remoteDebuggingPort, { viewId: 'sidebar' });
          await wait(
            () => cdp.point('[aria-label="Allow once"]'),
            'parent actionable child fallback'
          );
          assert.equal((await readSnapshot()).routeSessionId, session.id);
          await capture('child-permission-restored', session.id);
          assert.ok(await cdp.click('[aria-label="Allow once"]'));
        } else
          await client.wire('POST', `/api/session/${childID}/permission/${restored.id}/reply`, {
            decision: 'once',
          });
        await wait(
          async () => (await pending()).length === 0 && (await idle(childID)),
          'acknowledged child continuation'
        );
        assert.equal(
          await readFile(path.join(workspace, 'child-effect.txt'), 'utf8'),
          'idempotent-child-effect'
        );
        assert.equal(
          (await client.wire('GET', `/api/session?parentID=${session.id}`)).data.length,
          1,
          'No duplicate child'
        );
        await capture('child-after', session.id);
        await capture('child-history', childID);
      }
    );

    await run('native recovery exhausts its unchanged durable retry budget', async (result) => {
      const marker = 'RECOVERY-EXHAUST';
      const session = await createSession(marker);
      result.sessionID = session.id;
      await open(session);
      gates.set(marker, true);
      await send(session.id, marker);
      await wait(
        async () => (await history(session.id)).some((m) => m.type === 'assistant'),
        'initial claim'
      );
      for (let attempt = 1; attempt <= 11; attempt += 1) {
        const count = requests.filter((body) =>
          JSON.stringify(body.messages).includes(marker)
        ).length;
        await stop('SIGKILL');
        await start();
        if (attempt <= 10)
          await wait(
            () =>
              requests.filter((body) => JSON.stringify(body.messages).includes(marker)).length >
              count,
            `native recovery attempt ${attempt}`
          );
      }
      await wait(() => idle(session.id), 'bounded exhausted recovery');
      const state = await capture('exhausted-after', session.id);
      assert.ok(state.canonical.some((m) => m.type === 'idle' && m.outcome === 'failed'));
      assert.ok(
        state.projected.some((m) => m.info.error),
        'Exhaustion projects failure, never success'
      );
      assert.equal(
        requests.filter((body) => JSON.stringify(body.messages).includes(marker)).length,
        11
      );
      // Read-only evidence of claims and attempt accounting; never adjust native limits or records.
      result.claimAfter = claim(session.id);
      assert.equal(result.claimAfter.time_suspended, null);
      if (cdp) {
        // Rapid deaths can leave SSE at its existing 30-second maximum backoff.
        // Include admission/snapshot time without changing transport or native retry limits.
        await wait(
          () =>
            cdp.evaluate(
              `/OpenCode execution failed|Execution was interrupted repeatedly/.test(document.body.textContent)`
            ),
          'exhausted recovery is visibly failed',
          45_000
        );
        await wait(
          () => cdp.evaluate(`!document.querySelector('.stop-button')`),
          'terminal recovery stops busy state'
        );
        await capture('exhausted-visible', session.id);
      }
    });
  }
);
