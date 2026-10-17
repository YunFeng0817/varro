import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAppState } from './app-state';
import { flushInputDraft, readInputDraft } from './input-draft-persistence';
import { STORAGE_KEYS } from './state-storage';
import type { UnknownRecord } from '../../shared/type-utils';

beforeEach(() => {
  flushInputDraft();
  window.localStorage.clear();
  // SAFETY: The fixture provides the unknown fields read by this statement.
  delete (window as { __vscodeWebviewState?: unknown }).__vscodeWebviewState;
  // SAFETY: The fixture provides the unknown fields read by this statement.
  delete (window as { __initialWebviewState?: unknown }).__initialWebviewState;
});

afterEach(() => {
  flushInputDraft();
  vi.useRealTimers();
});

describe('empty-state histogram configuration', () => {
  it('defaults to disabled', () => {
    expect(createAppState().showEmptyStateHistogram()).toBe(false);
  });

  it.each([true, false])('restores the host opt-in value %s', (showEmptyStateHistogram) => {
    // SAFETY: The fixture provides the host-owned initial webview state.
    (window as { __initialWebviewState?: unknown }).__initialWebviewState = {
      showEmptyStateHistogram,
    };

    expect(createAppState().showEmptyStateHistogram()).toBe(showEmptyStateHistogram);
  });
});

describe('composer draft persistence', () => {
  it('uses host session models instead of stale editor-local variants', () => {
    window.localStorage.setItem(
      STORAGE_KEYS.sessionSelectedModels,
      JSON.stringify({
        'session-1': { providerID: 'openai', modelID: 'gpt-5.6-sol', variant: 'medium' },
      })
    );
    // SAFETY: The fixture provides the host-owned initial webview state.
    (window as { __initialWebviewState?: unknown }).__initialWebviewState = {
      webviewContext: {
        viewId: 'editor-1',
        surface: 'editor',
        initialRoute: { type: 'session', sessionId: 'session-1' },
      },
      sessionSelectedModels: {
        'session-1': { providerID: 'openai', modelID: 'gpt-5.6-sol', variant: 'xhigh' },
      },
    };

    const appState = createAppState();

    expect(appState.state.sessionSelectedModels['session-1']).toEqual({
      providerID: 'openai',
      modelID: 'gpt-5.6-sol',
      variant: 'xhigh',
    });
  });

  it('uses host model preferences instead of stale editor-local settings', () => {
    window.localStorage.setItem(STORAGE_KEYS.pinnedModels, JSON.stringify(['openai:stale']));
    window.localStorage.setItem(STORAGE_KEYS.hiddenProviders, JSON.stringify(['openai']));
    // SAFETY: The fixture provides the host-owned initial webview state.
    (window as { __initialWebviewState?: unknown }).__initialWebviewState = {
      webviewContext: {
        viewId: 'editor-1',
        surface: 'editor',
        initialRoute: { type: 'new-session' },
      },
      modelPreferences: {
        modelVariantSelections: {},
        providerOrder: ['openai'],
        modelOrder: ['openai:gpt-5.6-sol'],
        hiddenProviders: [],
        hiddenModels: [],
        addedModels: [],
        pinnedModels: ['openai:gpt-5.6-sol'],
        modelDisplayNames: {},
      },
    };

    const appState = createAppState();

    expect(appState.state.hiddenProviders).toEqual([]);
    expect(appState.state.providerOrder).toEqual(['openai']);
    expect(appState.state.modelOrder).toEqual(['openai:gpt-5.6-sol']);
    expect(appState.state.pinnedModels).toEqual(['openai:gpt-5.6-sol']);
  });

  it('does not restore a selected model from another project', () => {
    window.localStorage.setItem(
      `${STORAGE_KEYS.selectedModel}:/repo-a`,
      JSON.stringify({ providerID: 'openai', modelID: 'repo-a-model' })
    );
    window.localStorage.setItem(
      STORAGE_KEYS.selectedModel,
      JSON.stringify({ providerID: 'openai', modelID: 'legacy-global-model' })
    );
    // SAFETY: The fixture provides the host-owned initial webview state.
    (window as { __initialWebviewState?: unknown }).__initialWebviewState = {
      editorContext: {
        workspacePath: '/repo-b',
        activeFile: null,
        selection: null,
        diagnostics: [],
      },
    };

    expect(createAppState().state.selectedModel).toBeNull();
  });

  it('loads the shared last model separately from the project and session choices', () => {
    const lastSelectedModel = { providerID: 'openai', modelID: 'sol', variant: 'high' };
    // SAFETY: The fixture provides the host-owned initial webview state.
    (window as { __initialWebviewState?: unknown }).__initialWebviewState = {
      editorContext: {
        workspacePath: '/new-project',
        activeFile: null,
        selection: null,
        diagnostics: [],
      },
      modelPreferences: { lastSelectedModel },
    };
    const appState = createAppState();
    expect(appState.state.lastSelectedModel).toEqual(lastSelectedModel);
    expect(appState.state.selectedModel).toBeNull();
  });

  it('restores draft text when app state is recreated', () => {
    const first = createAppState();
    first.setInputText('Keep this draft');

    const restored = createAppState();

    expect(restored.inputText()).toBe('Keep this draft');
    flushInputDraft();
    expect(window.localStorage.getItem(STORAGE_KEYS.inputDraft)).toBe(
      JSON.stringify('Keep this draft')
    );
  });

  it('restores the queued edit identity with its draft', () => {
    window.localStorage.setItem(STORAGE_KEYS.inputDraft, JSON.stringify('Edit this follow-up'));
    window.localStorage.setItem(
      STORAGE_KEYS.queuedMessages,
      JSON.stringify([{ id: 'queue-1', sessionId: 'session-1', text: 'Edit this follow-up' }])
    );
    window.localStorage.setItem(
      STORAGE_KEYS.queuedMessageEdit,
      JSON.stringify({ id: 'queue-1', sessionId: 'session-1' })
    );

    const restored = createAppState();

    expect(restored.inputText()).toBe('Edit this follow-up');
    expect(restored.state.queuedMessageEdit).toEqual({ id: 'queue-1', sessionId: 'session-1' });
  });

  it('discards a queued edit draft missing from the authoritative host queue', () => {
    window.localStorage.setItem(STORAGE_KEYS.inputDraft, JSON.stringify('Stale queued draft'));
    window.localStorage.setItem(
      STORAGE_KEYS.queuedMessageEdit,
      JSON.stringify({ id: 'queue-1', sessionId: 'session-1' })
    );
    // SAFETY: The fixture provides the host-owned initial webview state.
    (window as { __initialWebviewState?: unknown }).__initialWebviewState = {
      queuedMessages: [],
    };

    const restored = createAppState();

    expect(restored.inputText()).toBe('');
    expect(restored.state.queuedMessages).toEqual([]);
    expect(restored.state.queuedMessageEdit).toBeNull();
    expect(window.localStorage.getItem(STORAGE_KEYS.inputDraft)).toBeNull();
    expect(window.localStorage.getItem(STORAGE_KEYS.queuedMessageEdit)).toBeNull();
  });

  it('restores draft text from VS Code webview state', () => {
    let vscodeState: UnknownRecord = {};
    // SAFETY: The fixture provides the host-owned initial webview state.
    (window as { __initialWebviewState?: unknown }).__initialWebviewState = {
      webviewContext: {
        viewId: 'sidebar',
        surface: 'sidebar',
        initialRoute: { type: 'new-session' },
      },
    };
    // SAFETY: The fixture provides the unknown fields read by this statement.
    (
      window as {
        __vscodeWebviewState: {
          getState(): UnknownRecord;
          setState(state: UnknownRecord): void;
        };
      }
    ).__vscodeWebviewState = {
      getState: () => vscodeState,
      setState: (state) => {
        vscodeState = state;
      },
    };
    const first = createAppState();
    first.setInputText('Keep this VS Code draft');
    flushInputDraft();
    window.localStorage.clear();

    const restored = createAppState();

    expect(restored.inputText()).toBe('Keep this VS Code draft');
    expect(vscodeState[STORAGE_KEYS.inputDraft]).toBe('Keep this VS Code draft');
  });

  it.each(['sidebar', 'editor'] as const)(
    'checkpoints the latest %s draft before a reload can snapshot the old value',
    (surface) => {
      vi.useFakeTimers();
      let vscodeState: UnknownRecord = {
        [STORAGE_KEYS.inputDraft]: 'Older persisted draft',
        unrelated: 'Preserve other webview state',
      };
      // SAFETY: These fixtures provide the native host context and state API.
      (window as { __initialWebviewState?: unknown }).__initialWebviewState = {
        webviewContext: { viewId: surface, surface, initialRoute: { type: 'new-session' } },
      };
      const setState = vi.fn((state: UnknownRecord) => {
        vscodeState = state;
      });
      // SAFETY: These fixtures provide the native host context and state API.
      (window as { __vscodeWebviewState?: unknown }).__vscodeWebviewState = {
        getState: () => vscodeState,
        setState,
      };
      const appState = createAppState();
      setState.mockClear();

      appState.setInputText('Newest visible draft');

      // VS Code can snapshot state before pagehide or the draft debounce fires.
      expect(vscodeState[STORAGE_KEYS.inputDraft]).toBe('Newest visible draft');
      expect(vscodeState.unrelated).toBe('Preserve other webview state');
      expect(setState).toHaveBeenCalledOnce();
      expect(window.localStorage.getItem(STORAGE_KEYS.inputDraft)).toBeNull();

      appState.setInputText('Newest visible draft');
      vi.runAllTimers();
      window.dispatchEvent(new Event('pagehide'));
      expect(setState).toHaveBeenCalledOnce();
      expect(readInputDraft()).toBe('Newest visible draft');

      appState.setInputText('');
      expect(vscodeState[STORAGE_KEYS.inputDraft]).toBeUndefined();
      expect(createAppState().inputText()).toBe('');
      vi.runAllTimers();
      expect(readInputDraft()).toBeNull();
    }
  );

  it('coalesces browser draft writes, keeps pending reads coherent, and flushes on pagehide', () => {
    vi.useFakeTimers();
    const appState = createAppState();
    const setState = vi.spyOn(Storage.prototype, 'setItem');
    setState.mockClear();

    appState.setInputText('a');
    appState.setInputText('ab');
    appState.setInputText('abc');

    expect(readInputDraft()).toBe('abc');
    expect(setState).not.toHaveBeenCalled();
    expect(createAppState().inputText()).toBe('abc');
    expect(setState).not.toHaveBeenCalled();
    setState.mockClear();

    vi.advanceTimersByTime(99);
    expect(setState).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(setState).toHaveBeenCalledOnce();
    expect(window.localStorage.getItem(STORAGE_KEYS.inputDraft)).toBe(JSON.stringify('abc'));

    appState.setInputText('flush before unload');
    window.dispatchEvent(new Event('pagehide'));

    expect(setState).toHaveBeenCalledTimes(2);
    expect(window.localStorage.getItem(STORAGE_KEYS.inputDraft)).toBe(
      JSON.stringify('flush before unload')
    );
    setState.mockRestore();
  });

  it('cancels a pending draft write when the draft is cleared', () => {
    vi.useFakeTimers();
    const appState = createAppState();
    const setState = vi.spyOn(Storage.prototype, 'setItem');
    setState.mockClear();

    appState.setInputText('do not restore this');
    appState.setInputText('');
    vi.runAllTimers();

    expect(readInputDraft()).toBeNull();
    expect(window.localStorage.getItem(STORAGE_KEYS.inputDraft)).toBeNull();
    expect(setState).not.toHaveBeenCalled();
    setState.mockRestore();
  });

  it('restores a manual editor workspace selection across path spelling changes', () => {
    let vscodeState: UnknownRecord = {
      [STORAGE_KEYS.workspacePath]: 'C:\\Users\\Andrew\\Repo',
      [STORAGE_KEYS.manualWorkspaceSelection]: true,
    };
    // SAFETY: The fixture provides the unknown fields read by this statement.
    (
      window as {
        __vscodeWebviewState: {
          getState(): UnknownRecord;
          setState(state: UnknownRecord): void;
        };
      }
    ).__vscodeWebviewState = {
      getState: () => vscodeState,
      setState: (state) => {
        vscodeState = state;
      },
    };
    // SAFETY: The fixture provides the host-owned initial webview state.
    (window as { __initialWebviewState?: unknown }).__initialWebviewState = {
      webviewContext: {
        viewId: 'editor-1',
        surface: 'editor',
        initialRoute: { type: 'new-session' },
      },
      editorContext: {
        workspacePath: 'c:/users/andrew/repo',
        workspaceFolders: [],
        activeFile: null,
        selection: null,
        diagnostics: [],
      },
    };

    const restored = createAppState();

    expect(restored.manualWorkspaceSelection()).toBe(true);
    restored.setManualWorkspaceSelection(false);
    expect(vscodeState[STORAGE_KEYS.manualWorkspaceSelection]).toBeUndefined();
  });

  it('does not restore a manual selection for a different workspace', () => {
    let vscodeState: UnknownRecord = {
      [STORAGE_KEYS.workspacePath]: '/repo-a',
      [STORAGE_KEYS.manualWorkspaceSelection]: true,
    };
    // SAFETY: The fixture provides the unknown fields read by this statement.
    (
      window as {
        __vscodeWebviewState: {
          getState(): UnknownRecord;
          setState(state: UnknownRecord): void;
        };
      }
    ).__vscodeWebviewState = {
      getState: () => vscodeState,
      setState: (state) => {
        vscodeState = state;
      },
    };
    // SAFETY: The fixture provides the host-owned initial webview state.
    (window as { __initialWebviewState?: unknown }).__initialWebviewState = {
      webviewContext: {
        viewId: 'editor-1',
        surface: 'editor',
        initialRoute: { type: 'new-session' },
      },
      editorContext: {
        workspacePath: '/repo-b',
        workspaceFolders: [],
        activeFile: null,
        selection: null,
        diagnostics: [],
      },
    };

    expect(createAppState().manualWorkspaceSelection()).toBe(false);
  });

  it('persists functional updates and removes an empty draft', () => {
    const appState = createAppState();
    appState.setInputText('Keep');
    appState.setInputText((value) => `${value} this`);

    expect(createAppState().inputText()).toBe('Keep this');

    appState.setInputText('');

    expect(window.localStorage.getItem(STORAGE_KEYS.inputDraft)).toBeNull();
    expect(createAppState().inputText()).toBe('');
  });

  it('restores attached files when app state is recreated', () => {
    window.localStorage.setItem(
      STORAGE_KEYS.inputDraftFiles,
      JSON.stringify([
        {
          path: '/repo/src/file.ts',
          relativePath: 'src/file.ts',
          type: 'file',
          lineRanges: [{ startLine: 2, endLine: 4 }],
          attachmentSequence: 3,
        },
        { path: '', relativePath: 'invalid.ts', type: 'file' },
      ])
    );

    const restored = createAppState();

    expect(restored.state.droppedFiles).toEqual([
      {
        path: '/repo/src/file.ts',
        relativePath: 'src/file.ts',
        type: 'file',
        lineRanges: [{ startLine: 2, endLine: 4 }],
        attachmentSequence: 3,
      },
    ]);
  });

  it('restores pasted images from host state without stale temporary files', () => {
    // SAFETY: The fixture provides the unknown fields read by this statement.
    (window as { __initialWebviewState?: unknown }).__initialWebviewState = {
      clipboardImages: [
        {
          id: 'image-1',
          url: 'data:image/png;base64,AA==',
          mime: 'image/png',
          filename: 'pasted-image-1.png',
          size: 1,
          attachmentSequence: 4,
          contextFile: {
            path: '/tmp/old-host/image.png',
            relativePath: 'image.png',
            type: 'file',
          },
        },
      ],
    };

    const restored = createAppState();

    expect(restored.state.clipboardImages).toEqual([
      {
        id: 'image-1',
        url: 'data:image/png;base64,AA==',
        mime: 'image/png',
        filename: 'pasted-image-1.png',
        size: 1,
        attachmentSequence: 4,
      },
    ]);
  });
});
