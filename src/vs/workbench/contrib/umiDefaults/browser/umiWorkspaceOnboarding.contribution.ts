/*---------------------------------------------------------------------------------------------
 *  Copyright (c) UmiCode Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * UmiCode Workspace Onboarding contribution.
 *
 * Runs once when the workbench is fully restored and checks ALL opened workspace
 * roots for common "project not set up yet" signals. All checks run
 * independently per root — multiple prompts can appear simultaneously.
 *
 * Checks performed per root:
 *   1. Node project (package.json) with no node_modules/
 *      - Detects lockfile: bun.lock / bun.lockb → bun install,
 *        pnpm-lock.yaml → pnpm install, yarn.lock → yarn install,
 *        else → npm install
 *      - Action: [Install] runs the right package manager in the integrated terminal
 *
 *   2. Python project (requirements.txt / pyproject.toml) with no .venv/
 *      - Detects uv.lock → prefers `uv sync` (modern, fast)
 *      - Else with requirements.txt → python3 -m venv .venv && pip install -r requirements.txt
 *      - Else pyproject.toml only → python3 -m venv .venv
 *      - Action: runs the appropriate setup command
 *
 *   3. Environment template without .env
 *      - Detects .env.example, .env.template, or .env.sample
 *      - Action: [Create .env] copies the template and opens it for editing
 *
 * Dismissal behaviour:
 *   - "Not Now"                → in-memory session dismissal (won't re-prompt until reload)
 *   - "Don't Ask Again"        → persisted per workspace+folder via StorageScope.WORKSPACE
 *
 * Storage keys are scoped by folder URI path to support multi-root workspaces.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions } from '../../../common/contributions.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ITerminalService, ITerminalGroupService } from '../../terminal/browser/terminal.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { isWindows } from '../../../../base/common/platform.js';


// ── Storage key bases ──────────────────────────────────────────────────────────

const KEY_NODE   = 'umiOnboarding/nodeInstallDismissed';
const KEY_PYTHON = 'umiOnboarding/pythonVenvDismissed';
const KEY_GO     = 'umiOnboarding/goDownloadDismissed';
const KEY_RUST   = 'umiOnboarding/rustFetchDismissed';
const KEY_ENV    = 'umiOnboarding/envFileDismissed';

/**
 * Returns a workspace-scoped storage key unique to the given folder URI,
 * allowing independent dismissals in multi-root workspaces.
 */
function scopedKey(base: string, folderUri: URI): string {
	return `${base}:${folderUri.path}`;
}

/** Name of the persistent UmiCode run terminal (shared with umiRunFile contribution). */
const TERMINAL_NAME = 'UmiCode Run';

// ── Contribution ───────────────────────────────────────────────────────────────

class UmiWorkspaceOnboardingContribution extends Disposable implements IWorkbenchContribution {

	/**
	 * In-memory set of scoped keys dismissed for the current session via "Not Now".
	 * Prevents re-prompting until the window is reloaded, without touching persistent storage.
	 */
	private readonly _sessionDismissed = new Set<string>();

	constructor(
		@IFileService             private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@INotificationService     private readonly _notificationService: INotificationService,
		@IStorageService          private readonly _storageService: IStorageService,
		@ITerminalService         private readonly _terminalService: ITerminalService,
		@ITerminalGroupService    private readonly _terminalGroupService: ITerminalGroupService,
		@IOpenerService           private readonly _openerService: IOpenerService,
	) {
		super();
		// Delay slightly so the workbench is visually settled before we show anything
		setTimeout(() => this._check(), 1500);
	}

	// ── Core check ────────────────────────────────────────────────────────────

	private async _check(): Promise<void> {
		const folders = this._workspaceContextService.getWorkspace().folders;
		if (!folders.length) { return; }

		// Run all checks for ALL workspace roots in parallel.
		// Each check is independent — do NOT short-circuit on first match.
		await Promise.all(folders.map(folder => this._checkAll(folder.uri)));
	}

	/** Runs all onboarding checks for a single workspace root, independently and in parallel. */
	private async _checkAll(root: URI): Promise<void> {
		await Promise.all([
			this._checkNode(root),
			this._checkPython(root),
			this._checkGo(root),
			this._checkRust(root),
			this._checkEnv(root),
		]);
	}

	// ── 1. Node: package.json without node_modules ────────────────────────────

	private async _checkNode(root: URI): Promise<void> {
		if (this._isDismissed(KEY_NODE, root)) { return; }

		const hasPackageJson = await this._fileService.exists(joinPath(root, 'package.json'));
		if (!hasPackageJson) { return; }

		const hasNodeModules = await this._fileService.exists(joinPath(root, 'node_modules'));
		if (hasNodeModules)  { return; }

		const { cmd, label } = await this._detectNodePackageManager(root);

		const msg = localize(
			'umi.onboarding.node',
			"UmiCode detected a Node project without installed dependencies. Run '{0}' to install them?",
			cmd,
		);

		this._notificationService.prompt(
			Severity.Info,
			msg,
			[
				{
					label: localize('umi.onboarding.install', 'Install ({0})', label),
					run: () => this._runInTerminal(cmd),
				},
				{
					label: localize('umi.onboarding.notNow', 'Not Now'),
					run: () => this._sessionDismiss(KEY_NODE, root),
				},
				{
					label: localize('umi.onboarding.neverForProject', "Don't Ask Again for This Project"),
					run: () => this._dismiss(KEY_NODE, root),
					isSecondary: true,
				},
			],
			{ sticky: false },
		);
	}

	private async _detectNodePackageManager(root: URI): Promise<{ cmd: string; label: string }> {
		// bun.lock  = text-format lockfile (Bun ≥ 1.1)
		// bun.lockb = binary-format lockfile (Bun < 1.1)
		if (await this._fileService.exists(joinPath(root, 'bun.lock')))       { return { cmd: 'bun install',  label: 'bun' }; }
		if (await this._fileService.exists(joinPath(root, 'bun.lockb')))      { return { cmd: 'bun install',  label: 'bun' }; }
		if (await this._fileService.exists(joinPath(root, 'pnpm-lock.yaml'))) { return { cmd: 'pnpm install', label: 'pnpm' }; }
		if (await this._fileService.exists(joinPath(root, 'yarn.lock')))      { return { cmd: 'yarn install', label: 'yarn' }; }
		return { cmd: 'npm install', label: 'npm' };
	}

	// ── 2. Python: requirements/pyproject without .venv ───────────────────────

	private async _checkPython(root: URI): Promise<void> {
		if (this._isDismissed(KEY_PYTHON, root)) { return; }

		const hasReqs      = await this._fileService.exists(joinPath(root, 'requirements.txt'));
		const hasPyproject = await this._fileService.exists(joinPath(root, 'pyproject.toml'));
		if (!hasReqs && !hasPyproject) { return; }

		const hasVenv = await this._fileService.exists(joinPath(root, '.venv'));
		if (hasVenv)  { return; }

		// Prefer uv when a uv.lock is present (modern, significantly faster than pip)
		const hasUvLock = await this._fileService.exists(joinPath(root, 'uv.lock'));

		let setupCmd: string;
		let actionLabel: string;
		let msg: string;

		if (hasUvLock) {
			setupCmd    = 'uv sync';
			actionLabel = localize('umi.onboarding.uvSync', 'Run uv sync');
			msg = localize(
				'umi.onboarding.python.uv',
				"UmiCode detected a uv project without a synced virtual environment. Run 'uv sync' to set it up?",
			);
		} else if (hasReqs) {
			const pipBin = isWindows ? '.venv\\Scripts\\pip.exe' : '.venv/bin/pip';
			setupCmd    = `python3 -m venv .venv && ${pipBin} install -r requirements.txt`;
			actionLabel = localize('umi.onboarding.createVenv', 'Create .venv');
			msg = localize(
				'umi.onboarding.python.reqs',
				'UmiCode detected a Python project without a virtual environment. Create a .venv and install requirements?',
			);
		} else {
			setupCmd    = 'python3 -m venv .venv';
			actionLabel = localize('umi.onboarding.createVenv', 'Create .venv');
			msg = localize(
				'umi.onboarding.python.pyproject',
				'UmiCode detected a Python project without a virtual environment. Create a .venv?',
			);
		}

		this._notificationService.prompt(
			Severity.Info,
			msg,
			[
				{
					label: actionLabel,
					run: () => this._runInTerminal(setupCmd),
				},
				{
					label: localize('umi.onboarding.notNow', 'Not Now'),
					run: () => this._sessionDismiss(KEY_PYTHON, root),
				},
				{
					label: localize('umi.onboarding.neverForProject', "Don't Ask Again for This Project"),
					run: () => this._dismiss(KEY_PYTHON, root),
					isSecondary: true,
				},
			],
			{ sticky: false },
		);
	}

	// ── 3. Go: go.mod without dependencies / go.sum ───────────────────────────

	private async _checkGo(root: URI): Promise<void> {
		if (this._isDismissed(KEY_GO, root)) { return; }

		const hasGoMod = await this._fileService.exists(joinPath(root, 'go.mod'));
		if (!hasGoMod) { return; }

		const hasGoSum = await this._fileService.exists(joinPath(root, 'go.sum'));
		const hasVendor = await this._fileService.exists(joinPath(root, 'vendor'));
		if (hasGoSum || hasVendor) { return; }

		this._notificationService.prompt(
			Severity.Info,
			localize(
				'umi.onboarding.go',
				"UmiCode detected a Go module without downloaded dependencies. Run 'go mod download' to fetch them?",
			),
			[
				{
					label: localize('umi.onboarding.goDownload', 'Run go mod download'),
					run: () => this._runInTerminal('go mod download'),
				},
				{
					label: localize('umi.onboarding.notNow', 'Not Now'),
					run: () => this._sessionDismiss(KEY_GO, root),
				},
				{
					label: localize('umi.onboarding.neverForProject', "Don't Ask Again for This Project"),
					run: () => this._dismiss(KEY_GO, root),
					isSecondary: true,
				},
			],
			{ sticky: false },
		);
	}

	// ── 4. Rust: Cargo.toml without Cargo.lock or target/ ────────────────────

	private async _checkRust(root: URI): Promise<void> {
		if (this._isDismissed(KEY_RUST, root)) { return; }

		const hasCargoToml = await this._fileService.exists(joinPath(root, 'Cargo.toml'));
		if (!hasCargoToml) { return; }

		const hasCargoLock = await this._fileService.exists(joinPath(root, 'Cargo.lock'));
		const hasTarget = await this._fileService.exists(joinPath(root, 'target'));
		if (hasCargoLock && hasTarget) { return; }

		const cmd = hasCargoLock ? 'cargo check' : 'cargo fetch';
		const label = hasCargoLock ? 'cargo check' : 'cargo fetch';

		this._notificationService.prompt(
			Severity.Info,
			localize(
				'umi.onboarding.rust',
				"UmiCode detected a Rust project. Run '{0}' to fetch dependencies and check the project?",
				cmd,
			),
			[
				{
					label: localize('umi.onboarding.rustRun', 'Run {0}', label),
					run: () => this._runInTerminal(cmd),
				},
				{
					label: localize('umi.onboarding.notNow', 'Not Now'),
					run: () => this._sessionDismiss(KEY_RUST, root),
				},
				{
					label: localize('umi.onboarding.neverForProject', "Don't Ask Again for This Project"),
					run: () => this._dismiss(KEY_RUST, root),
					isSecondary: true,
				},
			],
			{ sticky: false },
		);
	}

	// ── 5. .env.example / .env.template without .env ─────────────────────────

	private async _checkEnv(root: URI): Promise<void> {
		if (this._isDismissed(KEY_ENV, root)) { return; }

		const hasEnv = await this._fileService.exists(joinPath(root, '.env'));
		if (hasEnv)  { return; }

		let templateUri: URI | undefined;
		let templateName: string | undefined;

		for (const name of ['.env.example', '.env.template', '.env.sample']) {
			const candidate = joinPath(root, name);
			if (await this._fileService.exists(candidate)) {
				templateUri  = candidate;
				templateName = name;
				break;
			}
		}

		if (!templateUri || !templateName) { return; }

		const capturedTemplateUri = templateUri;
		const envUri = joinPath(root, '.env');

		this._notificationService.prompt(
			Severity.Info,
			localize('umi.onboarding.env', "UmiCode found '{0}' but no '.env' file. Create one from the template?", templateName),
			[
				{
					label: localize('umi.onboarding.createEnv', 'Create .env'),
					run: async () => {
						try {
							const content = await this._fileService.readFile(capturedTemplateUri);
							await this._fileService.writeFile(envUri, content.value);
							// Open the new file immediately so the user can fill in their secrets
							await this._openerService.open(envUri);
						} catch (err) {
							this._notificationService.error(
								localize('umi.onboarding.envError', 'UmiCode could not create .env: {0}', String(err)),
							);
						}
					},
				},
				{
					label: localize('umi.onboarding.notNow', 'Not Now'),
					run: () => this._sessionDismiss(KEY_ENV, root),
				},
				{
					label: localize('umi.onboarding.neverForProject', "Don't Ask Again for This Project"),
					run: () => this._dismiss(KEY_ENV, root),
					isSecondary: true,
				},
			],
			{ sticky: false },
		);
	}

	// ── Terminal helper ────────────────────────────────────────────────────────

	private async _runInTerminal(command: string): Promise<void> {
		const existing = this._terminalService.instances.find(t => t.title === TERMINAL_NAME);
		const terminal = existing ?? await this._terminalService.createTerminal({ config: { name: TERMINAL_NAME } });

		// Only send Ctrl+C to a pre-existing terminal — a fresh one has nothing running
		if (existing) {
			await terminal.sendText('\x03', false);
			await new Promise<void>(resolve => setTimeout(resolve, 150));
		}

		await terminal.sendText(command, true);
		this._terminalService.setActiveInstance(terminal);
		await this._terminalGroupService.showPanel(true);
	}

	// ── Dismissal helpers ─────────────────────────────────────────────────────

	private _isDismissed(base: string, folderUri: URI): boolean {
		const key = scopedKey(base, folderUri);
		// Check in-memory session dismissal first, then persistent storage
		return this._sessionDismissed.has(key) ||
			this._storageService.getBoolean(key, StorageScope.WORKSPACE, false);
	}

	/** Persists dismissal permanently for this workspace + folder. */
	private _dismiss(base: string, folderUri: URI): void {
		this._storageService.store(scopedKey(base, folderUri), true, StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	/** Dismisses for the current session only (in-memory, clears on window reload). */
	private _sessionDismiss(base: string, folderUri: URI): void {
		this._sessionDismissed.add(scopedKey(base, folderUri));
	}
}

// ── Register ───────────────────────────────────────────────────────────────────

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution(
	UmiWorkspaceOnboardingContribution,
	LifecyclePhase.Restored,
);
