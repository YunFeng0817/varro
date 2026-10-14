import { access, readFile, readdir, rm } from 'node:fs/promises';
import { dirname, join, posix, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import spawn from 'cross-spawn';

const scriptPath = fileURLToPath(import.meta.url);
const defaultProjectRoot = resolve(dirname(scriptPath), '..');

export function selectStaleVsixFiles(entries, packageName) {
  const prefix = `${packageName}-`;
  return entries.filter((entry) => entry.startsWith(prefix) && entry.endsWith('.vsix'));
}

export function parseInstallArgs(args) {
  const targets = [];
  let dryRun = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--dry-run') {
      dryRun = true;
    } else if (argument === '--force') {
      // Installation already uses --force for every editor; retain explicit invocations too.
      continue;
    } else if (argument === '--target') {
      const target = args[++index];
      if (!target?.trim() || target.startsWith('--')) {
        throw new Error('--target requires an editor CLI name or executable path');
      }
      targets.push(target.trim());
    } else {
      throw new Error(`Unknown argument ${argument}; use --target <editor>, --force, or --dry-run`);
    }
  }
  return { targets, dryRun };
}

export function createVscodeInstallPlan(options) {
  if (!options.npmExecPath) {
    throw new Error('npm_execpath is unavailable; run this helper with npm run vscode:install');
  }

  const pathJoin = options.platform === 'win32' ? win32.join : posix.join;
  const vsixPath = pathJoin(
    options.projectRoot,
    `${options.packageName}-${options.packageVersion}.vsix`
  );
  const targets = options.targets?.length
    ? options.targets
    : [options.env.VARRO_VSCODE_CLI?.trim() || 'code'];
  const commands = targets.map((target) =>
    options.platform === 'win32' && !/[/\\.]/.test(target) ? `${target}.cmd` : target
  );
  const uniqueCommands = commands.filter(
    (command, index) =>
      commands.findIndex((candidate) =>
        options.platform === 'win32'
          ? candidate.toLowerCase() === command.toLowerCase()
          : candidate === command
      ) === index
  );
  const installCommands = uniqueCommands.map((command) => ({
    command,
    args: ['--install-extension', vsixPath, '--force'],
    env: { ...options.env, NODE_NO_WARNINGS: '1' },
    shell: false,
  }));

  return {
    vsixPath,
    packageCommand: {
      command: options.nodePath,
      args: [options.npmExecPath, 'run', 'package'],
      env: options.env,
      shell: false,
    },
    installCommands,
  };
}

function runCommand(spec, cwd) {
  return new Promise((resolveCommand, rejectCommand) => {
    // cross-spawn resolves Windows .cmd shims through cmd.exe with escaped,
    // verbatim arguments while preserving direct execution on POSIX.
    const child = spawn(spec.command, spec.args, {
      cwd,
      env: spec.env,
      shell: spec.shell,
      stdio: 'inherit',
    });
    child.once('error', rejectCommand);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolveCommand();
        return;
      }
      const outcome = signal ? `signal ${signal}` : `exit code ${String(code)}`;
      rejectCommand(new Error(`${spec.command} failed with ${outcome}`));
    });
  });
}

async function main() {
  const args = parseInstallArgs(process.argv.slice(2));
  const manifest = JSON.parse(await readFile(join(defaultProjectRoot, 'package.json'), 'utf8'));
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- JSON boundary validation must reject malformed manifest fields before use.
  if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') {
    throw new Error('package.json must define string name and version fields');
  }

  const plan = createVscodeInstallPlan({
    projectRoot: defaultProjectRoot,
    packageName: manifest.name,
    packageVersion: manifest.version,
    platform: process.platform,
    nodePath: process.execPath,
    npmExecPath: process.env.npm_execpath,
    env: process.env,
    targets: args.targets,
  });
  const staleVsixFiles = selectStaleVsixFiles(await readdir(defaultProjectRoot), manifest.name);

  if (args.dryRun) {
    process.stdout.write(
      [
        `Would remove: ${staleVsixFiles.join(', ') || '(none)'}`,
        `Would package: ${plan.packageCommand.command} ${plan.packageCommand.args.join(' ')}`,
        ...plan.installCommands.map(
          (install) => `Would install: ${install.command} ${install.args.join(' ')}`
        ),
        '',
      ].join('\n')
    );
    return;
  }

  await Promise.all(
    staleVsixFiles.map((file) => rm(join(defaultProjectRoot, file), { force: true }))
  );
  await runCommand(plan.packageCommand, defaultProjectRoot);
  await access(plan.vsixPath);
  const failures = [];
  for (const install of plan.installCommands) {
    try {
      await runCommand(install, defaultProjectRoot);
      process.stdout.write(`Installed into ${install.command}\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Could not install into ${install.command}: ${message}\n`);
      failures.push(install.command);
    }
  }
  if (failures.length > 0) throw new Error(`Installation failed for: ${failures.join(', ')}`);
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  await main();
}
