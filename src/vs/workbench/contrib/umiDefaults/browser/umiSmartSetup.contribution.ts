/*---------------------------------------------------------------------------------------------
 *  Copyright (c) UmiCode Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * UmiCode Smart Setup contribution.
 *
 * Detects the language of the active file (including content-based detection
 * for Plain Text / untitled files) and checks two things:
 *   1. Is the ecosystem extension installed?
 *   2. Is the compiler / runtime available on PATH?
 *
 * Notification cases:
 *   • Neither extension nor compiler → offer to install extension + note about compiler
 *   • Extension missing, compiler found → offer to install extension
 *   • Extension installed, compiler missing → warn about missing compiler, open terminal
 *   • Both present → do nothing
 *
 * Dismissals are persisted per-profile via IStorageService.
 */

import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions } from '../../../common/contributions.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ILanguageDetectionService } from '../../../services/languageDetection/common/languageDetectionWorkerService.js';
import { PLAINTEXT_LANGUAGE_ID } from '../../../../editor/common/languages/modesRegistry.js';
import { IExtensionsWorkbenchService } from '../../extensions/common/extensions.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { getCodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { ThrottledDelayer } from '../../../../base/common/async.js';
import { localize } from '../../../../nls.js';
import { ProgressLocation } from '../../../../platform/progress/common/progress.js';
import { isWindows } from '../../../../base/common/platform.js';
import { URI } from '../../../../base/common/uri.js';

// ─── Language → Extension + Compiler map ─────────────────────────────────────

interface ILanguageSetup {
	/** Marketplace extension ID */
	readonly extensionId: string;
	/** Human-readable language name shown in the notification */
	readonly displayName: string;
	/** Optional VS Code command to run after extension install */
	readonly postInstallCommand?: string;
	/**
	 * Compiler / runtime binaries to look for on PATH.
	 * If any one is found the compiler check passes.
	 * Leave undefined to skip compiler checking for this language.
	 */
	readonly compilerBinaries?: readonly string[];
	/** Human-readable hint shown when no compiler is found. */
	readonly compilerInstallHint?: string;
}

const LANGUAGE_SETUP_MAP: Readonly<Record<string, ILanguageSetup>> = {
	python: {
		extensionId: 'ms-python.python',
		displayName: 'Python',
		postInstallCommand: 'python.createEnvironment',
		compilerBinaries: ['python3', 'python'],
		compilerInstallHint: 'Install Python from python.org or via your package manager.',
	},
	java: {
		extensionId: 'redhat.java',
		displayName: 'Java',
		compilerBinaries: ['javac', 'java'],
		compilerInstallHint: 'Install a JDK (e.g. Eclipse Temurin) from adoptium.net.',
	},
	go: {
		extensionId: 'golang.go',
		displayName: 'Go',
		compilerBinaries: ['go'],
		compilerInstallHint: 'Install Go from go.dev/dl.',
	},
	rust: {
		extensionId: 'rust-lang.rust-analyzer',
		displayName: 'Rust',
		compilerBinaries: ['rustc', 'cargo'],
		compilerInstallHint: 'Install Rust via rustup.rs.',
	},
	c: {
		extensionId: 'llvm-vs-code-extensions.vscode-clangd',
		displayName: 'C/C++',
		compilerBinaries: ['gcc', 'clang', 'g++', 'clang++', 'cl'],
		compilerInstallHint: 'Install GCC (via Homebrew: brew install gcc) or Xcode Command Line Tools (xcode-select --install).',
	},
	cpp: {
		extensionId: 'llvm-vs-code-extensions.vscode-clangd',
		displayName: 'C/C++',
		compilerBinaries: ['g++', 'clang++', 'gcc', 'clang', 'cl'],
		compilerInstallHint: 'Install GCC (via Homebrew: brew install gcc) or Xcode Command Line Tools (xcode-select --install).',
	},
	csharp: {
		extensionId: 'dotnetdev-kr-custom.csharp',
		displayName: 'C#',
		compilerBinaries: ['dotnet'],
		compilerInstallHint: 'Install the .NET SDK from dot.net.',
	},
	php: {
		extensionId: 'devsense.phptools-vscode',
		displayName: 'PHP',
		compilerBinaries: ['php'],
		compilerInstallHint: 'Install PHP from php.net or via Homebrew: brew install php.',
	},
	ruby: {
		extensionId: 'shopify.ruby-lsp',
		displayName: 'Ruby',
		compilerBinaries: ['ruby'],
		compilerInstallHint: 'Install Ruby via rbenv, rvm, or Homebrew: brew install ruby.',
	},
	dart: {
		extensionId: 'dart-code.dart-code',
		displayName: 'Dart / Flutter',
		compilerBinaries: ['dart', 'flutter'],
		compilerInstallHint: 'Install Flutter (includes Dart) from flutter.dev.',
	},
	swift: {
		extensionId: 'swiftlang.swift-vscode',
		displayName: 'Swift',
		compilerBinaries: ['swift', 'swiftc'],
		compilerInstallHint: 'Install Swift via Xcode or swift.org.',
	},
	kotlin: {
		extensionId: 'JetBrains.kotlin-server',
		displayName: 'Kotlin',
		compilerBinaries: ['kotlinc', 'kotlin'],
		compilerInstallHint: 'Install Kotlin via SDKMAN (sdk install kotlin) or Homebrew: brew install kotlin.',
	},
	dockerfile: {
		extensionId: 'docker.docker',
		displayName: 'Docker',
		compilerBinaries: ['docker'],
		compilerInstallHint: 'Install Docker Desktop from docker.com.',
	},
};

const STORAGE_KEY_EXT     = 'umiSmartSetup/dismissedLanguages';
const STORAGE_KEY_COMPILER = 'umiSmartSetup/dismissedCompilerWarnings';

// ─── Contribution ─────────────────────────────────────────────────────────────

class UmiSmartSetupContribution extends Disposable implements IWorkbenchContribution {

	private readonly _delayer = new ThrottledDelayer<void>(800);
	private readonly _renderDisposables = this._register(new DisposableStore());

	constructor(
		@IEditorService private readonly _editorService: IEditorService,
		@ILanguageDetectionService private readonly _languageDetectionService: ILanguageDetectionService,
		@IExtensionsWorkbenchService private readonly _extensionsService: IExtensionsWorkbenchService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IStorageService private readonly _storageService: IStorageService,
		@ICommandService private readonly _commandService: ICommandService,
		@IFileService private readonly _fileService: IFileService,
	) {
		super();

		this._register(this._editorService.onDidActiveEditorChange(() => this._schedule()));
		this._schedule();
	}

	// ── Scheduling ────────────────────────────────────────────────────────────

	private _schedule(): void {
		this._delayer.trigger(() => this._check());
	}

	// ── Core check ────────────────────────────────────────────────────────────

	private async _check(): Promise<void> {
		const editor = getCodeEditor(this._editorService.activeTextEditorControl);
		if (!editor) { return; }

		const model = editor.getModel();
		if (!model) { return; }

		// Re-check on language or content changes
		this._renderDisposables.clear();
		editor.onDidChangeModelLanguage(() => this._schedule(), this, this._renderDisposables);
		editor.onDidChangeModelContent(() => this._schedule(), this, this._renderDisposables);

		let languageId = model.getLanguageId();

		// Plain Text / untitled: probe content with ML-based detection
		if (languageId === PLAINTEXT_LANGUAGE_ID) {
			const detected = await this._languageDetectionService.detectLanguage(model.uri);
			if (detected) {
				languageId = detected;
			}
		}

		const setup = LANGUAGE_SETUP_MAP[languageId];
		if (!setup) { return; }

		// Check extension
		const extInstalled = this._extensionsService.local.some(
			e => e.identifier.id.toLowerCase() === setup.extensionId.toLowerCase()
		);

		// Check compiler (only if binaries are defined for this language)
		const compilerFound = setup.compilerBinaries
			? await this._checkCompiler(setup.compilerBinaries)
			: true; // no compiler check needed (e.g. pure LSP languages)

		// ── Dispatch to the right notification ────────────────────────────────

		if (extInstalled && compilerFound) {
			return; // nothing to do
		}

		if (!extInstalled && !compilerFound) {
			// Case 1 — missing both
			if (this._isDismissed(STORAGE_KEY_EXT, languageId)) { return; }
			this._showExtPrompt(languageId, setup, /* missingCompiler */ true);
			return;
		}

		if (!extInstalled && compilerFound) {
			// Case 2 — only extension missing
			if (this._isDismissed(STORAGE_KEY_EXT, languageId)) { return; }
			this._showExtPrompt(languageId, setup, /* missingCompiler */ false);
			return;
		}

		// Case 3 — extension installed but compiler missing
		if (this._isDismissed(STORAGE_KEY_COMPILER, languageId)) { return; }
		this._showCompilerPrompt(languageId, setup);
	}

	// ── Notifications ─────────────────────────────────────────────────────────

	private _showExtPrompt(languageId: string, setup: ILanguageSetup, missingCompiler: boolean): void {
		let message = missingCompiler
			? localize(
				'umiSmartSetup.bothMissing',
				"UmiCode noticed you're writing {0} but you're missing the extension and a compiler. Want us to install the extension?",
				setup.displayName
			)
			: localize(
				'umiSmartSetup.extMissing',
				"UmiCode noticed you're writing {0}. Want us to install the {0} extension and set up your environment?",
				setup.displayName
			);

		if (missingCompiler && setup.compilerInstallHint) {
			message += `\n${localize('umiSmartSetup.compilerHint', "You'll also need a compiler: {0}", setup.compilerInstallHint)}`;
		}

		this._notificationService.prompt(
			Severity.Info,
			message,
			[
				{
					label: localize('umiSmartSetup.setup', "Set Up"),
					run: () => this._doInstall(languageId, setup),
				},
				{
					label: localize('umiSmartSetup.notNow', "Not Now"),
					run: () => { /* re-prompts next session */ },
				},
				{
					label: localize('umiSmartSetup.never', "Never for {0}", setup.displayName),
					run: () => this._dismiss(STORAGE_KEY_EXT, languageId),
					isSecondary: true,
				},
			],
			{
				sticky: true,
				onCancel: () => { /* treat as Not Now */ },
			}
		);
	}

	private _showCompilerPrompt(languageId: string, setup: ILanguageSetup): void {
		const message = localize(
			'umiSmartSetup.compilerMissing',
			"UmiCode can't find a {0} compiler on your system. You'll need one to build and run your code.{1}",
			setup.displayName,
			setup.compilerInstallHint ? `\n${setup.compilerInstallHint}` : ''
		);

		this._notificationService.prompt(
			Severity.Warning,
			message,
			[
				{
					label: localize('umiSmartSetup.openTerminal', "Open Terminal"),
					run: () => this._commandService.executeCommand('workbench.action.terminal.new').catch(() => {}),
				},
				{
					label: localize('umiSmartSetup.dismiss', "Dismiss"),
					run: () => this._dismiss(STORAGE_KEY_COMPILER, languageId),
				},
			],
			{
				sticky: false,
				onCancel: () => { /* dismiss silently */ },
			}
		);
	}

	// ── Install ───────────────────────────────────────────────────────────────

	private async _doInstall(languageId: string, setup: ILanguageSetup): Promise<void> {
		try {
			await this._extensionsService.install(
				setup.extensionId,
				{ installPreReleaseVersion: false },
				ProgressLocation.Notification
			);
			this._dismiss(STORAGE_KEY_EXT, languageId);

			if (setup.postInstallCommand) {
				setTimeout(() => {
					this._commandService.executeCommand(setup.postInstallCommand!).catch(() => {});
				}, 3000);
			}
		} catch {
			// Install failed (e.g. no marketplace). Silently ignore.
		}
	}

	// ── Compiler detection ────────────────────────────────────────────────────

	/**
	 * Returns true if any of the given binary names is found on PATH.
	 * Uses IFileService so this works in the sandboxed renderer.
	 */
	private async _checkCompiler(binaries: readonly string[]): Promise<boolean> {
		const dirs = this._getPathDirs();
		const exts = isWindows ? ['.exe', '.cmd', '.bat', ''] : [''];

		for (const binary of binaries) {
			for (const dir of dirs) {
				for (const ext of exts) {
					try {
						const uri = URI.file(`${dir}/${binary}${ext}`);
						if (await this._fileService.exists(uri)) {
							return true;
						}
					} catch {
						// ignore stat errors for individual paths
					}
				}
			}
		}
		return false;
	}

	/** Splits the shell PATH into directory entries and adds common fallback dirs. */
	private _getPathDirs(): string[] {
		const sep = isWindows ? ';' : ':';
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const pathEnv: string = (globalThis as any).process?.env?.PATH ?? '';
		const dirs = pathEnv.split(sep).filter(Boolean);

		if (!isWindows) {
			// Common locations that may not be in the env when launched from GUI
			for (const fallback of [
				'/usr/bin',
				'/usr/local/bin',
				'/opt/homebrew/bin',   // Apple Silicon Homebrew
				'/opt/homebrew/sbin',
				'/opt/local/bin',      // MacPorts
				'/usr/local/sbin',
			]) {
				if (!dirs.includes(fallback)) {
					dirs.push(fallback);
				}
			}
		}
		return dirs;
	}

	// ── Dismissal storage ─────────────────────────────────────────────────────

	private _getDismissed(storageKey: string): string[] {
		try {
			return JSON.parse(this._storageService.get(storageKey, StorageScope.PROFILE, '[]'));
		} catch {
			return [];
		}
	}

	private _isDismissed(storageKey: string, languageId: string): boolean {
		return this._getDismissed(storageKey).includes(languageId);
	}

	private _dismiss(storageKey: string, languageId: string): void {
		const existing = this._getDismissed(storageKey);
		if (!existing.includes(languageId)) {
			existing.push(languageId);
			this._storageService.store(storageKey, JSON.stringify(existing), StorageScope.PROFILE, StorageTarget.USER);
		}
	}
}

// ─── Register ─────────────────────────────────────────────────────────────────

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution(
	UmiSmartSetupContribution,
	LifecyclePhase.Restored
);
