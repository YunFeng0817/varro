/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: The platform override is restored after each test and only drives platform-specific command selection. */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import packageJson from '../../package.json';

type InstallCommand = {
  command: string;
  args: string[];
  env: Record<string, string | undefined>;
  shell: false;
};

type VscodeInstallModule = {
  createVscodeInstallPlan(options: {
    projectRoot: string;
    packageName: string;
    packageVersion: string;
    platform: string;
    nodePath: string;
    npmExecPath: string;
    env: Record<string, string | undefined>;
    targets?: string[];
  }): {
    vsixPath: string;
    packageCommand: InstallCommand;
    installCommands: InstallCommand[];
  };
  selectStaleVsixFiles(entries: string[], packageName: string): string[];
  parseInstallArgs(args: string[]): { targets: string[]; dryRun: boolean };
};

const vscodeInstallModuleUrl = pathToFileURL(resolve('scripts/vscode-install.mjs'));
const { createVscodeInstallPlan, selectStaleVsixFiles, parseInstallArgs } = (await import(
  vscodeInstallModuleUrl.href
)) as VscodeInstallModule;

describe('VS Code install helper', () => {
  it('parses repeated explicit targets and preserves executable paths with spaces', () => {
    expect(
      parseInstallArgs(['--target', 'code', '--target', '/Apps/Editor CLI', '--dry-run'])
    ).toEqual({
      targets: ['code', '/Apps/Editor CLI'],
      dryRun: true,
    });
    expect(parseInstallArgs([])).toEqual({ targets: [], dryRun: false });
  });

  it.each([['--target'], ['--target', '--dry-run'], ['--all'], ['cursor']])(
    'rejects invalid install arguments %j',
    (...args) => {
      expect(() => parseInstallArgs(args)).toThrow();
    }
  );

  it('packages once for only the requested editors, overriding the single-editor environment', () => {
    const plan = createVscodeInstallPlan({
      projectRoot: '/src/varro',
      packageName: 'varro',
      packageVersion: '0.33.2',
      platform: 'darwin',
      nodePath: '/usr/bin/node',
      npmExecPath: '/npm-cli.js',
      env: { VARRO_VSCODE_CLI: 'cursor' },
      targets: ['code', 'codium', 'code'],
    });
    expect(plan.packageCommand.args).toEqual(['/npm-cli.js', 'run', 'package']);
    expect(plan.installCommands.map((command) => command.command)).toEqual(['code', 'codium']);
    for (const command of plan.installCommands) {
      expect(command.args).toEqual([
        '--install-extension',
        '/src/varro/varro-0.33.2.vsix',
        '--force',
      ]);
      expect(command.shell).toBe(false);
    }
  });

  it('defaults to code alone without editor discovery', () => {
    const plan = createVscodeInstallPlan({
      projectRoot: '/src/varro',
      packageName: 'varro',
      packageVersion: '0.33.2',
      platform: 'linux',
      nodePath: '/usr/bin/node',
      npmExecPath: '/npm-cli.js',
      env: {},
    });
    expect(plan.installCommands.map((command) => command.command)).toEqual(['code']);
  });

  it('accepts explicit --force while keeping force installation for every target', () => {
    const parsed = parseInstallArgs(['--force', '--target', 'code', '--target', 'codium']);
    const plan = createVscodeInstallPlan({
      projectRoot: '/src/varro',
      packageName: 'varro',
      packageVersion: '0.33.2',
      platform: 'linux',
      nodePath: '/usr/bin/node',
      npmExecPath: '/npm-cli.js',
      env: {},
      targets: parsed.targets,
    });
    expect(plan.installCommands).toHaveLength(2);
    for (const command of plan.installCommands) expect(command.args).toContain('--force');
  });

  it('normalizes bare Windows CLI targets without splitting paths or installing duplicates', () => {
    const plan = createVscodeInstallPlan({
      projectRoot: 'C:\\src\\varro',
      packageName: 'varro',
      packageVersion: '0.33.2',
      platform: 'win32',
      nodePath: 'node.exe',
      npmExecPath: 'npm-cli.js',
      env: {},
      targets: ['code', 'CODE.cmd', 'codium', 'C:\\Editor with spaces\\bin\\cli.exe'],
    });
    expect(plan.installCommands.map((command) => command.command)).toEqual([
      'code.cmd',
      'codium.cmd',
      'C:\\Editor with spaces\\bin\\cli.exe',
    ]);
  });

  it('uses the pinned cross-spawn Windows command resolver', () => {
    expect(packageJson.dependencies['cross-spawn']).toBe('7.0.6');
  });

  it('selects only stale VSIX files for this package', () => {
    expect(
      selectStaleVsixFiles(
        ['varro-0.23.4.vsix', 'varro-0.23.5.vsix', 'other-1.0.0.vsix', 'varro-not-vsix.txt'],
        'varro'
      )
    ).toEqual(['varro-0.23.4.vsix', 'varro-0.23.5.vsix']);
  });

  it('builds a Windows-safe plan without POSIX shell syntax or globbing', () => {
    const plan = createVscodeInstallPlan({
      projectRoot: 'C:\\src\\varro',
      packageName: 'varro',
      packageVersion: '0.23.5',
      platform: 'win32',
      nodePath: 'C:\\Program Files\\nodejs\\node.exe',
      npmExecPath: 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js',
      env: { PATH: 'C:\\Windows\\System32' },
    });

    expect(plan.packageCommand).toMatchObject({
      command: 'C:\\Program Files\\nodejs\\node.exe',
      args: ['C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js', 'run', 'package'],
      shell: false,
    });
    expect(plan.installCommands[0]).toMatchObject({
      command: 'code.cmd',
      args: ['--install-extension', 'C:\\src\\varro\\varro-0.23.5.vsix', '--force'],
      shell: false,
      env: expect.objectContaining({ NODE_NO_WARNINGS: '1' }),
    });
    expect(plan.installCommands[0]!.args.join(' ')).not.toContain('*');
  });

  it.each([
    ['spaces', 'work trees'],
    ['ampersands', 'work&trees'],
    ['carets', 'work^trees'],
    ['parentheses', 'work(trees)'],
    ['quotes', 'work"trees'],
  ])('preserves Windows paths containing %s as single non-shell arguments', (_label, segment) => {
    const projectRoot = `C:\\${segment}\\varro`;
    const vscodeCli = `C:\\${segment}\\VS Code\\bin\\code.cmd`;
    const plan = createVscodeInstallPlan({
      projectRoot,
      packageName: 'varro',
      packageVersion: '0.23.5',
      platform: 'win32',
      nodePath: 'C:\\Program Files\\nodejs\\node.exe',
      npmExecPath: 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js',
      env: { VARRO_VSCODE_CLI: vscodeCli },
    });

    expect(plan.installCommands[0]).toMatchObject({
      command: vscodeCli,
      args: ['--install-extension', `${projectRoot}\\varro-0.23.5.vsix`, '--force'],
      shell: false,
    });
  });

  it('uses direct process execution on POSIX', () => {
    const plan = createVscodeInstallPlan({
      projectRoot: '/src/varro',
      packageName: 'varro',
      packageVersion: '0.23.5',
      platform: 'linux',
      nodePath: '/usr/bin/node',
      npmExecPath: '/usr/lib/node_modules/npm/bin/npm-cli.js',
      env: {},
    });

    expect(plan.installCommands[0]).toMatchObject({
      command: 'code',
      args: ['--install-extension', '/src/varro/varro-0.23.5.vsix', '--force'],
      shell: false,
    });
  });
});
