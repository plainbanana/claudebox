#!/usr/bin/env node
// claudebox - Run Claude Code in a sandbox using @anthropic-ai/sandbox-runtime

const { execSync, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const process = require("process");

// =============================================================================
// Utility Functions
// =============================================================================

function getRepoRoot(projectDir) {
	try {
		return execSync("git rev-parse --show-toplevel 2>/dev/null", {
			encoding: "utf8",
			cwd: projectDir,
		}).trim();
	} catch {
		return projectDir;
	}
}

function realpath(p) {
	return fs.realpathSync(p);
}

function canon(p) {
	try {
		return realpath(p);
	} catch {
		return p;
	}
}

function pathExists(p) {
	try {
		fs.accessSync(p);
		return true;
	} catch {
		return false;
	}
}

function isDirectory(p) {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function getTmpDir() {
	return process.env.TMPDIR || process.env.TEMP || process.env.TMP || "/tmp";
}

function shellQuote(s) {
	return "'" + s.replace(/'/g, "'\\''") + "'";
}

// =============================================================================
// Configuration
// =============================================================================

const CONFIG_DEFAULTS = {
	allowSshAgent: false,
	allowGpgAgent: false,
	allowXdgRuntime: false,
	roBinds: [],
	rwBinds: [],
};

function getConfigPath() {
	if (process.env.CLAUDEBOX_CONFIG) {
		return process.env.CLAUDEBOX_CONFIG;
	}
	const xdgConfig =
		process.env.XDG_CONFIG_HOME || path.join(process.env.HOME, ".config");
	return path.join(xdgConfig, "claudebox", "config.json");
}

function loadConfig() {
	const configPath = getConfigPath();

	try {
		const content = fs.readFileSync(configPath, "utf8");
		const userConfig = JSON.parse(content);
		return { ...CONFIG_DEFAULTS, ...userConfig };
	} catch (err) {
		if (err.code !== "ENOENT") {
			console.error(
				`Warning: Failed to load config from ${configPath}: ${err.message}`,
			);
		}
		return { ...CONFIG_DEFAULTS };
	}
}

// =============================================================================
// SRT Integration
// =============================================================================

let SandboxManager;

async function initSrt() {
	try {
		const srt = require("@anthropic-ai/sandbox-runtime");
		SandboxManager = srt.SandboxManager;
	} catch {
		const srt = await import("@anthropic-ai/sandbox-runtime");
		SandboxManager = srt.SandboxManager;
	}
}

function buildSrtConfig(options, { home, repoRoot, shareTree }) {
	const canonHome = canon(home);
	const canonRepoRoot = canon(repoRoot);
	const canonShareTree = canon(shareTree);

	const allowRead = [
		path.join(canonHome, ".claude"),
		path.join(canonHome, ".claude.json"),
		canonRepoRoot,
	];

	// Temp paths (macOS: /tmp → /private/tmp)
	const tmpPaths = new Set(["/tmp"]);
	try {
		tmpPaths.add(canon("/tmp"));
		tmpPaths.add(canon(getTmpDir()));
	} catch {}

	const allowWrite = [
		canonRepoRoot,
		...[...tmpPaths],
		path.join(canonHome, ".claude"),
		path.join(canonHome, ".claude.json"),
	];

	// Share tree (parent directory of repo, read-only)
	if (canonShareTree !== canonRepoRoot) {
		allowRead.push(canonShareTree);
	}

	// Nix daemon socket needs write access
	if (pathExists("/nix/var/nix/daemon-socket")) {
		allowWrite.push("/nix/var/nix/daemon-socket");
	}

	// roBinds
	for (const p of options.roBinds || []) {
		if (pathExists(p)) {
			allowRead.push(canon(p));
		} else {
			console.warn(`Warning: roBinds path not found, skipping: ${p}`);
		}
	}

	// rwBinds (need both read and write)
	for (const p of options.rwBinds || []) {
		if (pathExists(p)) {
			const cp = canon(p);
			allowRead.push(cp);
			allowWrite.push(cp);
		} else {
			console.warn(`Warning: rwBinds path not found, skipping: ${p}`);
		}
	}

	// SSH agent
	if (options.allowSshAgent && process.env.SSH_AUTH_SOCK) {
		const sock = process.env.SSH_AUTH_SOCK;
		if (pathExists(sock)) {
			allowRead.push(canon(sock));
		}
	}

	// GPG agent
	if (options.allowGpgAgent) {
		const xdgDir =
			process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`;
		const gpgDir = path.join(xdgDir, "gnupg");
		if (isDirectory(gpgDir)) {
			allowRead.push(canon(gpgDir));
		}
	}

	// XDG runtime
	if (options.allowXdgRuntime) {
		const xdgDir =
			process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`;
		if (isDirectory(xdgDir)) {
			allowRead.push(canon(xdgDir));
		}
	}

	return {
		// network omitted → patched schema allows this, no network restrictions
		allowPty: true,
		mandatoryDenySearchDepth: 1,
		filesystem: {
			denyRead: [canonHome],
			allowRead,
			allowWrite,
			denyWrite: [],
		},
	};
}

// =============================================================================
// CLI Argument Parsing
// =============================================================================

function parseArgs(args) {
	// Load config file first
	const config = loadConfig();

	// CLI overrides - undefined means "not specified"
	const cliOverrides = {
		allowSshAgent: undefined,
		allowGpgAgent: undefined,
		allowXdgRuntime: undefined,
	};

	const cliRoBinds = [];
	const cliRwBinds = [];
	let claudeArgs = [];

	let i = 0;
	while (i < args.length) {
		const arg = args[i];

		switch (arg) {
			case "--allow-ssh-agent":
				cliOverrides.allowSshAgent = true;
				i++;
				break;

			case "--allow-gpg-agent":
				cliOverrides.allowGpgAgent = true;
				i++;
				break;

			case "--allow-xdg-runtime":
				cliOverrides.allowXdgRuntime = true;
				i++;
				break;

			case "--ro-bind":
			case "--rw-bind": {
				const next = args[i + 1];
				if (!next || next.startsWith("-")) {
					console.error(`${arg} requires a path argument`);
					process.exit(1);
				}
				const resolved = path.resolve(next);
				if (arg === "--ro-bind") {
					cliRoBinds.push(resolved);
				} else {
					cliRwBinds.push(resolved);
				}
				i += 2;
				break;
			}

			case "--":
				claudeArgs = args.slice(i + 1);
				i = args.length;
				break;

			case "-h":
			case "--help":
				showHelp();
				process.exit(0);
				break;

			default:
				console.error(`Unknown option: ${arg}`);
				console.error("Use --help for usage information");
				process.exit(1);
		}
	}

	// Merge: CLI overrides > config file > defaults
	const options = {
		allowSshAgent:
			cliOverrides.allowSshAgent !== undefined
				? cliOverrides.allowSshAgent
				: config.allowSshAgent,
		allowGpgAgent:
			cliOverrides.allowGpgAgent !== undefined
				? cliOverrides.allowGpgAgent
				: config.allowGpgAgent,
		allowXdgRuntime:
			cliOverrides.allowXdgRuntime !== undefined
				? cliOverrides.allowXdgRuntime
				: config.allowXdgRuntime,
		roBinds: [...(config.roBinds || []), ...cliRoBinds],
		rwBinds: [...(config.rwBinds || []), ...cliRwBinds],
		claudeArgs,
	};

	return options;
}

function showHelp() {
	const configPath = getConfigPath();
	console.log(`Usage: claudebox [OPTIONS] [--] [CLAUDE_ARGS...]

Options:
  --ro-bind <path>                        Extra read-only bind mount (repeatable)
  --rw-bind <path>                        Extra read-write bind mount (repeatable)
  --allow-ssh-agent                       Allow access to SSH agent socket
  --allow-gpg-agent                       Allow access to GPG agent socket
  --allow-xdg-runtime                     Allow full XDG runtime directory access
  -h, --help                              Show this help message

  Arguments after -- are passed directly to claude.

Configuration:
  Settings can be configured in ${configPath}
  Override config path with CLAUDEBOX_CONFIG environment variable.
  CLI arguments override config file settings.

  Example config:
    {
      "allowSshAgent": false,
      "allowGpgAgent": false,
      "allowXdgRuntime": false,
      "roBinds": ["/path/to/dir"],
      "rwBinds": ["/path/to/dir"]
    }

Security:
  By default, claudebox blocks access to /run/user/$UID (XDG runtime directory)
  which contains DBus, audio, display, and other sensitive sockets.
  Use --allow-* flags to selectively enable access to specific services.

Examples:
  claudebox                               # Run with default settings
  claudebox --allow-ssh-agent             # Allow SSH agent for git operations
  claudebox --allow-xdg-runtime           # Allow full XDG runtime access
  claudebox --ro-bind /data -- --resume   # Extra mount + resume session
  claudebox -- -p "summarize this repo"   # Pass prompt to claude`);
}

// =============================================================================
// Main
// =============================================================================

async function main() {
	// Parse CLI first so --help exits without loading srt
	const options = parseArgs(process.argv.slice(2));

	await initSrt();

	const projectDir = process.cwd();
	const repoRoot = getRepoRoot(projectDir);
	const home = process.env.HOME;

	// Ensure Claude config directory exists
	const claudeConfig = path.join(home, ".claude");
	fs.mkdirSync(claudeConfig, { recursive: true });
	const claudeJson = path.join(home, ".claude.json");

	// Initialize Claude if needed
	if (!pathExists(claudeJson)) {
		console.log("Initializing Claude configuration...");
		try {
			execSync("claude --help", { stdio: "ignore" });
		} catch {
			// Ignore initialization errors
		}
	}

	// Smart filesystem sharing
	const realRepoRoot = realpath(repoRoot);
	const realHome = realpath(home);

	let shareTree;
	if (realRepoRoot.startsWith(realHome + "/")) {
		const relPath = realRepoRoot.slice(realHome.length + 1);
		const topDir = relPath.split("/")[0];
		shareTree = path.join(realHome, topDir);
	} else {
		shareTree = realRepoRoot;
	}

	// Initialize srt
	const srtConfig = buildSrtConfig(options, { home, repoRoot, shareTree });
	await SandboxManager.initialize(srtConfig);

	// Build environment exports
	const envExports = ["TMPDIR=/tmp", "TEMPDIR=/tmp", "TEMP=/tmp", "TMP=/tmp"];

	if (options.allowSshAgent && process.env.SSH_AUTH_SOCK) {
		envExports.push(`SSH_AUTH_SOCK=${shellQuote(process.env.SSH_AUTH_SOCK)}`);
	}

	if (options.allowXdgRuntime) {
		const xdgDir =
			process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`;
		if (isDirectory(xdgDir)) {
			envExports.push(`XDG_RUNTIME_DIR=${shellQuote(xdgDir)}`);
		}
	}

	// Terminal size
	if (process.stdout.columns) {
		envExports.push(`COLUMNS=${process.stdout.columns}`);
	}
	if (process.stdout.rows) {
		envExports.push(`LINES=${process.stdout.rows}`);
	}

	// Build claude command
	const claudeCmd = [
		"claude",
		"--dangerously-skip-permissions",
		...options.claudeArgs,
	]
		.map(shellQuote)
		.join(" ");

	const canonProjectDir = canon(projectDir);
	const script = `export ${envExports.join(" ")}; cd ${shellQuote(canonProjectDir)} && exec ${claudeCmd}`;

	// Wrap with sandbox
	const wrappedCommand = await SandboxManager.wrapWithSandbox(script);

	// Cleanup handler
	const cleanup = () => {
		try {
			SandboxManager.cleanupAfterCommand();
		} catch {}
	};
	process.on("SIGINT", () => {
		cleanup();
		process.exit(130);
	});
	process.on("SIGTERM", () => {
		cleanup();
		process.exit(143);
	});

	// Execute
	const child = spawn(wrappedCommand, { shell: true, stdio: "inherit" });
	child.on("error", (err) => {
		console.error(`Failed to execute: ${err.message}`);
		cleanup();
		process.exit(1);
	});
	child.on("close", (code) => {
		cleanup();
		process.exit(code || 0);
	});
}

main().catch(async (err) => {
	console.error(`Error: ${err.message}`);
	try {
		await SandboxManager?.reset?.();
	} catch {}
	process.exit(1);
});
