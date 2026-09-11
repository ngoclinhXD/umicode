/*---------------------------------------------------------------------------------------------
 *  Copyright (c) UmiCode Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * UmiCode Run File / Preview contribution.
 *
 * Adds a context-aware button to the editor title bar (top-right navigation area):
 *
 *   - HTML (.html, .htm) -> "Preview" (eye icon) -- opens the current file in the
 *     built-in Simple Browser with a file:// URI. No terminal needed.
 *
 *   - Runnable scripts -> "Run File" (play icon) -- sends a language-appropriate
 *     shell command to a persistent "UmiCode" terminal tab and focuses it.
 *     Always runs the CURRENTLY FOCUSED editor file. No entry-point guessing.
 *
 *   - All other file types -> button is hidden.
 *
 * Supported runtimes:
 *   Python     -> .venv/bin/python3 if .venv present, else python3
 *   JavaScript -> node <file>
 *   TypeScript -> bun <file> if bun found, else npx tsx <file>
 *   Go         -> go run <file>
 *   Rust       -> cargo run (Cargo.toml in workspace root), else rustc + exec
 *   C / C++    -> gcc/g++/clang compile to temp binary, then execute
 *   Shell      -> bash / zsh <file>
 */

import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions } from '../../../common/contributions.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ITerminalService, ITerminalGroupService } from '../../terminal/browser/terminal.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../editor/browser/editorExtensions.js';
import { localize, localize2 } from '../../../../nls.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { URI } from '../../../../base/common/uri.js';
import { isWindows } from '../../../../base/common/platform.js';
import { extname, joinPath } from '../../../../base/common/resources.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IOutputService, Extensions as OutputExtensions, IOutputChannelRegistry } from '../../../services/output/common/output.js';

// ── Context keys ───────────────────────────────────────────────────────────────

/** True when the active editor contains an HTML file. */
const CTX_ACTIVE_IS_HTML = new RawContextKey<boolean>('umiActiveEditorIsHtml', false, true);
/** True when the active editor contains a directly-runnable script. */
const CTX_ACTIVE_IS_RUNNABLE = new RawContextKey<boolean>('umiActiveEditorIsRunnable', false, true);

// ── Icons ──────────────────────────────────────────────────────────────────────

const ICON_RUN     = registerIcon('umi-run-file',    Codicon.run, localize('umiRunFile',    'Run the current file.'));
const ICON_PREVIEW = registerIcon('umi-preview-html', Codicon.eye, localize('umiPreviewHtml', 'Preview the current HTML file.'));

// ── Extension sets ─────────────────────────────────────────────────────────────

const HTML_EXTENSIONS = new Set(['.html', '.htm']);

const RUNNABLE_EXTENSIONS = new Set([
	'.py',
	'.js', '.mjs', '.cjs',
	'.ts', '.mts', '.cts',
	'.go',
	'.rs',
	'.c', '.cpp', '.cc', '.cxx',
	'.sh', '.zsh', '.bash',
	'.rb',
	'.php',
	'.dart',
	'.kt', '.kts',
]);

// ── Constants ──────────────────────────────────────────────────────────────────

const CMD_RUN_FILE     = 'workbench.action.umi.runFile';
const CMD_PREVIEW_HTML = 'workbench.action.umi.previewHtml';
const TERMINAL_NAME    = 'UmiCode Run';
const OUTPUT_CHANNEL_ID = 'umi.runFile.output';

Registry.as<IOutputChannelRegistry>(OutputExtensions.OutputChannels).registerChannel({
	id: OUTPUT_CHANNEL_ID,
	label: localize('umiRunFileOutput', 'UmiCode Run'),
	log: false
});

let terminalDataListener: IDisposable | undefined;

const configRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);
configRegistry.registerConfiguration({
	id: 'umiRunFile',
	order: 20,
	title: localize('umiRunFileConfigurationTitle', 'UmiCode Run File'),
	type: 'object',
	properties: {
		'umi.runFile.outputDestination': {
			type: 'string',
			enum: ['terminal', 'outputChannel'],
			default: 'terminal',
			description: localize('umi.runFile.outputDestination', 'Where to display output when running a file using the UmiCode Run button (terminal or clean output channel).')
		}
	}
});

// ── Helpers ────────────────────────────────────────────────────────────────────

interface IRunConfig {
	readonly command: string;
}

/** Build the shell command to execute the given file. */
async function buildRunCommand(
	fileUri: URI,
	fileService: IFileService,
	workspaceContextService: IWorkspaceContextService,
): Promise<IRunConfig | undefined> {
	const ext          = extname(fileUri).toLowerCase();
	const filePath     = fileUri.fsPath;
	const workspaceRoot = workspaceContextService.getWorkspace().folders[0]?.uri;

	switch (ext) {
		// ── Python ────────────────────────────────────────────────────────────
		case '.py': {
			let pythonBin = 'python3';
			if (workspaceRoot) {
				const venvBin = joinPath(workspaceRoot, '.venv', isWindows ? 'Scripts\\python.exe' : 'bin/python3');
				if (await fileService.exists(venvBin)) {
					pythonBin = `"${venvBin.fsPath}"`;
				}
			}
			return { command: `${pythonBin} "${filePath}"` };
		}

		// ── JavaScript ────────────────────────────────────────────────────────
		case '.js':
		case '.mjs':
		case '.cjs':
			return { command: `node "${filePath}"` };

		// ── TypeScript ────────────────────────────────────────────────────────
		case '.ts':
		case '.mts':
		case '.cts': {
			const hasBun = await findBinary(['bun'], fileService);
			return { command: hasBun ? `bun "${filePath}"` : `npx tsx "${filePath}"` };
		}

		// ── Go ────────────────────────────────────────────────────────────────
		case '.go':
			return { command: `go run "${filePath}"` };

		// ── Rust ──────────────────────────────────────────────────────────────
		case '.rs': {
			if (workspaceRoot) {
				const cargoToml = joinPath(workspaceRoot, 'Cargo.toml');
				if (await fileService.exists(cargoToml)) {
					return { command: 'cargo run' };
				}
			}
			const tmp = isWindows ? '%TEMP%\\umi_run_out.exe' : '/tmp/umi_run_out';
			return { command: `rustc "${filePath}" -o "${tmp}" && "${tmp}"` };
		}

		// ── C ─────────────────────────────────────────────────────────────────
		case '.c': {
			const tmp = isWindows ? '%TEMP%\\umi_run_out.exe' : '/tmp/umi_run_out';
			const cc  = await findBinary(['gcc', 'clang', 'cc'], fileService) ?? 'gcc';
			return { command: `${cc} "${filePath}" -o "${tmp}" && "${tmp}"` };
		}

		// ── C++ ───────────────────────────────────────────────────────────────
		case '.cpp':
		case '.cc':
		case '.cxx': {
			const tmp = isWindows ? '%TEMP%\\umi_run_out.exe' : '/tmp/umi_run_out';
			const cxx = await findBinary(['g++', 'clang++', 'c++'], fileService) ?? 'g++';
			return { command: `${cxx} "${filePath}" -o "${tmp}" && "${tmp}"` };
		}

		// ── Shell ─────────────────────────────────────────────────────────────
		case '.sh':
		case '.bash':
			return { command: `bash "${filePath}"` };
		case '.zsh':
			return { command: `zsh "${filePath}"` };

		// ── Ruby ──────────────────────────────────────────────────────────────
		case '.rb':
			return { command: `ruby "${filePath}"` };

		// ── PHP ───────────────────────────────────────────────────────────────
		case '.php':
			return { command: `php "${filePath}"` };

		// ── Dart ──────────────────────────────────────────────────────────────
		case '.dart':
			return { command: `dart run "${filePath}"` };

		// ── Kotlin ────────────────────────────────────────────────────────────
		case '.kts':
			return { command: `kotlinc -script "${filePath}"` };
		case '.kt': {
			const jar = isWindows ? '%TEMP%\\umi_kt_out.jar' : '/tmp/umi_kt_out.jar';
			return { command: `kotlinc "${filePath}" -include-runtime -d "${jar}" && java -jar "${jar}"` };
		}

		default:
			return undefined;
	}
}

/** Returns the first binary name found on PATH, or undefined. */
async function findBinary(names: string[], fileService: IFileService): Promise<string | undefined> {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const pathEnv: string = (globalThis as any).process?.env?.PATH ?? '';
	const sep  = isWindows ? ';' : ':';
	const dirs = pathEnv.split(sep).filter(Boolean);
	if (!isWindows) {
		for (const fb of ['/usr/bin', '/usr/local/bin', '/opt/homebrew/bin']) {
			if (!dirs.includes(fb)) { dirs.push(fb); }
		}
	}
	const exts = isWindows ? ['.exe', '.cmd', ''] : [''];

	for (const name of names) {
		for (const dir of dirs) {
			for (const ext of exts) {
				try {
					if (await fileService.exists(URI.file(`${dir}/${name}${ext}`))) {
						return name;
					}
				} catch { /* ignore stat errors */ }
			}
		}
	}
	return undefined;
}

// ── Actions ────────────────────────────────────────────────────────────────────

registerAction2(class UmiRunFileAction extends Action2 {
	constructor() {
		super({
			id: CMD_RUN_FILE,
			title: localize2('umi.runFile', 'Run File'),
			icon: ICON_RUN,
			menu: [{
				id: MenuId.EditorTitle,
				group: 'navigation',
				order: -2,
				when: CTX_ACTIVE_IS_RUNNABLE,
			}],
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const editorService    = accessor.get(IEditorService);
		const terminalService  = accessor.get(ITerminalService);
		const terminalGroupService = accessor.get(ITerminalGroupService);
		const fileService      = accessor.get(IFileService);
		const workspaceService = accessor.get(IWorkspaceContextService);

		const activeUri = editorService.activeEditor?.resource;
		if (!activeUri || activeUri.scheme === 'untitled') { return; }

		const config = await buildRunCommand(activeUri, fileService, workspaceService);
		if (!config) { return; }

		const configService   = accessor.get(IConfigurationService);
		const outputService   = accessor.get(IOutputService);
		const destination     = configService.getValue<string>('umi.runFile.outputDestination') ?? 'terminal';

		// Reuse or create a persistent named terminal
		let terminal = terminalService.instances.find(t => t.title === TERMINAL_NAME);
		if (!terminal) {
			terminal = await terminalService.createTerminal({ config: { name: TERMINAL_NAME } });
		}

		if (destination === 'outputChannel') {
			const channel = outputService.getChannel(OUTPUT_CHANNEL_ID);
			channel?.clear();
			channel?.append(`[Running: ${config.command}]\n`);
			await outputService.showChannel(OUTPUT_CHANNEL_ID, true);

			// Wire terminal output to output channel (strip ANSI escape codes)
			terminalDataListener?.dispose();
			terminalDataListener = terminal.onData(data => {
				const clean = data.replace(/\x1b\[[0-9;]*[mGKHFJ]/g, '');
				channel?.append(clean);
			});
		}

		// Send Ctrl+C to interrupt any currently running process, then run the new command
		await terminal.sendText('\x03', false);
		await new Promise<void>(resolve => setTimeout(resolve, 150));
		await terminal.sendText(config.command, true);

		if (destination === 'terminal') {
			terminalService.setActiveInstance(terminal);
			await terminalGroupService.showPanel(true);
		}
	}
});

registerAction2(class UmiPreviewHtmlAction extends Action2 {
	constructor() {
		super({
			id: CMD_PREVIEW_HTML,
			title: localize2('umi.previewHtml', 'Preview'),
			icon: ICON_PREVIEW,
			menu: [{
				id: MenuId.EditorTitle,
				group: 'navigation',
				order: -2,
				when: CTX_ACTIVE_IS_HTML,
			}],
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const editorService  = accessor.get(IEditorService);
		const commandService = accessor.get(ICommandService);

		const activeUri = editorService.activeEditor?.resource;
		if (!activeUri) { return; }

		// Ensure we hand a file:// URL to the Simple Browser
		const url = activeUri.scheme === 'file'
			? activeUri.toString()
			: activeUri.with({ scheme: 'file' }).toString();

		await commandService.executeCommand('simpleBrowser.show', url);
	}
});

// ── Contribution: sync context keys with the active editor ─────────────────────

class UmiRunFileContribution extends Disposable implements IWorkbenchContribution {

	private readonly _ctxIsHtml: IContextKey<boolean>;
	private readonly _ctxIsRunnable: IContextKey<boolean>;

	constructor(
		@IEditorService     private readonly _editorService: IEditorService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();
		this._ctxIsHtml     = CTX_ACTIVE_IS_HTML.bindTo(contextKeyService);
		this._ctxIsRunnable = CTX_ACTIVE_IS_RUNNABLE.bindTo(contextKeyService);
		this._register(this._editorService.onDidActiveEditorChange(() => this._update()));
		this._update();
	}

	private _update(): void {
		const resource = this._editorService.activeEditor?.resource;
		if (!resource) {
			this._ctxIsHtml.set(false);
			this._ctxIsRunnable.set(false);
			return;
		}
		const ext = extname(resource).toLowerCase();
		this._ctxIsHtml.set(HTML_EXTENSIONS.has(ext));
		this._ctxIsRunnable.set(RUNNABLE_EXTENSIONS.has(ext));
	}
}

// ── Register ───────────────────────────────────────────────────────────────────

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution(
	UmiRunFileContribution,
	LifecyclePhase.Restored,
);
