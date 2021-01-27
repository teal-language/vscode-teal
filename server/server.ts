/* --------------------------------------------------------------------------------------------
 * Based on lsp-sample.
 * See LICENSE-vscode-extension-samples at the root of the project for licensing info.
 * ------------------------------------------------------------------------------------------ */

import {
	createConnection,
	TextDocuments,
	Diagnostic,
	DiagnosticSeverity,
	ProposedFeatures,
	InitializeParams,
	DidChangeConfigurationNotification,
	Range,
	TextDocumentSyncKind,
	TextDocumentPositionParams,
	CompletionItem,
	MessageActionItem,
	ShowMessageRequestParams,
	MessageType,
	ShowMessageRequest,
	VersionedTextDocumentIdentifier,
	WorkspaceFolder,
	WorkspaceFoldersRequest,
	FormattingOptions,
} from 'vscode-languageserver';

import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import { withFile } from 'tmp-promise'
import path = require('path');
import { existsSync } from 'fs';
import util = require("util");
import { spawn } from 'child_process';

const write = util.promisify(require("fs").write);

const documents = new TextDocuments(TextDocument);

// Create a connection for the server. The connection uses Node's IPC as a transport.
// Also include all preview / proposed LSP features.
let connection = createConnection(ProposedFeatures.all);

let hasConfigurationCapability: boolean = false;
let hasWorkspaceFolderCapability: boolean = false;
let hasDiagnosticRelatedInformationCapability: boolean = false;

connection.onInitialize((params: InitializeParams) => {
	let capabilities = params.capabilities;

	// Does the client support the `workspace/configuration` request?
	// If not, we will fall back using global settings
	hasConfigurationCapability = !!(
		capabilities.workspace && !!capabilities.workspace.configuration
	);

	hasWorkspaceFolderCapability = !!(
		capabilities.workspace && !!capabilities.workspace.workspaceFolders
	);

	hasDiagnosticRelatedInformationCapability = !!(
		capabilities.textDocument &&
		capabilities.textDocument.publishDiagnostics &&
		capabilities.textDocument.publishDiagnostics.relatedInformation
	);

	return {
		capabilities: {
			textDocumentSync: TextDocumentSyncKind.Full,
			// Tell the client that the server DOES NOT support code completion
			completionProvider: {
				resolveProvider: false
			}
		}
	};
});

connection.onInitialized(() => {
	if (hasConfigurationCapability) {
		// Register for all configuration changes.
		connection.client.register(DidChangeConfigurationNotification.type, undefined);
	}
	if (hasWorkspaceFolderCapability) {
		connection.workspace.onDidChangeWorkspaceFolders(_event => {
			connection.console.log('Workspace folder change event received.');
		});
	}
});

interface TealServerSettings {
	compilerPath: {
		unix: string,
		windows: string
	}
};

// The global settings, used when the `workspace/configuration` request is not supported by the client.
// Please note that this is not the case when using this server with the client provided in this example
// but could happen with other clients.
const defaultSettings: TealServerSettings = {
	compilerPath: {
		unix: "tl",
		windows: "tl.bat"
	}
};

let globalSettings: TealServerSettings = defaultSettings;

// Cache the settings of all open documents
let documentSettings: Map<string, Thenable<TealServerSettings>> = new Map();

connection.onDidChangeConfiguration(change => {
	if (hasConfigurationCapability) {
		// Reset all cached document settings
		documentSettings.clear();
	} else {
		globalSettings = <TealServerSettings>(
			(change.settings.teal || defaultSettings)
		);
	}

	// Revalidate all open text documents
	documents.all().forEach(validateTextDocument);
});

function getDocumentSettings(resource: string): Thenable<TealServerSettings> {
	if (!hasConfigurationCapability) {
		return Promise.resolve(globalSettings);
	}

	let result = documentSettings.get(resource);

	if (!result) {
		result = connection.workspace.getConfiguration({
			scopeUri: resource,
			section: 'teal'
		});

		documentSettings.set(resource, result);
	}

	return result;
}

// Only keep settings for open documents
documents.onDidClose(e => {
	documentSettings.delete(e.document.uri);
});

async function showErrorMessage(message: string, ...actions: MessageActionItem[]) {
	let params: ShowMessageRequestParams = { type: MessageType.Error, message, actions };

	return await connection.sendRequest(ShowMessageRequest.type, params);
}

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent(change => {
	validateTextDocument(change.document);
});

// Monitored files have changed in VS Code
connection.onDidChangeWatchedFiles(_change => {
	for (let x of documents.all()) {
		validateTextDocument(x);
	}
});

class TLNotFoundError extends Error { /* ... */ }

function getDefaultCompilerPath() {
	if (process.platform === "win32") {
		return defaultSettings.compilerPath.windows;
	} else {
		return defaultSettings.compilerPath.unix;
	}
}

function getCompilerPath(settings: TealServerSettings) {
	if (process.platform === "win32") {
		return settings.compilerPath.windows;
	} else {
		return settings.compilerPath.unix;
	}
}

async function runTLCheck(filePath: string, settings: TealServerSettings): Promise<string> {
	let child: any;

	let platform = process.platform;

	const compilerPath = getCompilerPath(settings);

	if (platform == "win32") {
		child = spawn('cmd.exe', ['/c', compilerPath, "check", filePath]);
	} else {
		child = spawn(compilerPath, ["check", filePath]);
	}

	return await new Promise(async function (resolve, reject) {
		let stdout = "";
		let stderr = "";

		child.on('error', function (error: any) {
			if (error.code === 'ENOENT') {
				let errorMessage = "Could not find the tl executable. Please make sure that it is available in the PATH, or set the \"Teal > Compiler Path\" setting to the correct value.";

				const compilerPathIsCustom = compilerPath !== getDefaultCompilerPath();

				if (compilerPathIsCustom) {
					errorMessage = "Could not find the tl executable. Please make sure that the \"Teal > Compiler Path\" setting is correct.";
				}

				reject(new TLNotFoundError(errorMessage));
			} else {
				reject(error);
			}
		});

		child.on('close', function (exitCode: any) {
			resolve(stderr);
		});

		for await (const chunk of child.stdout) {
			stdout += chunk;
		}

		for await (const chunk of child.stderr) {
			stderr += chunk;
		}
	});
}

async function validateTextDocument(textDocument: TextDocument): Promise<void> {
	let settings = await getDocumentSettings(textDocument.uri);

	let checkResult: string;

	const tmpBufferPrefix = "__tl__tmp__check-";

	try {
		checkResult = await withFile(async ({ path, fd }) => {
			await write(fd, textDocument.getText());

			try {
				let result = await runTLCheck(path, settings);
				return result;
			} catch (error) {
				throw error;
			}
		}, { prefix: tmpBufferPrefix });
	} catch (error) {
		await showErrorMessage(error.message);
		return;
	}

	let errorPattern = /(?<fileName>^.*?):(?<lineNumber>\d+):((?<columnNumber>\d+):)? (?<errorMessage>.+)$/gm;

	let diagnosticsByPath: { [id: string]: Diagnostic[] } = {};
	diagnosticsByPath[textDocument.uri] = [];

	let syntaxError: RegExpExecArray | null;

	async function pathInWorkspace(pathToCheck: string): Promise<string | null> {
		if (path.basename(pathToCheck).startsWith(tmpBufferPrefix)) {
			return textDocument.uri
		}

		let workspaceFolders = await connection.workspace.getWorkspaceFolders();
		let resolvedPath: string | null = null;

		workspaceFolders?.forEach((folder) => {
			let folderPath = URI.parse(folder.uri).fsPath
			let fullPath = path.join(folderPath, pathToCheck);

			if (existsSync(fullPath)) {
				resolvedPath = URI.file(fullPath).toString()
				return;
			}
		});

		return resolvedPath;
	}

	while ((syntaxError = errorPattern.exec(checkResult))) {		
		const groups = syntaxError.groups!;

		let errorPath = path.normalize(groups.fileName);
		let fullPath = await pathInWorkspace(errorPath);

		if (fullPath === null) {
			continue;
		}

		let lineNumber = Number.parseInt(groups.lineNumber) - 1;
		let columnNumber = 0;

		if (groups.columnNumber !== undefined) {
			columnNumber = Number.parseInt(groups.columnNumber) - 1
		}

		let errorMessage = groups.errorMessage;

		let range = Range.create(lineNumber, columnNumber, lineNumber, columnNumber);

		let diagnostic: Diagnostic = {
			severity: DiagnosticSeverity.Error,
			range: range,
			message: errorMessage,
			source: 'tl check'
		};

		if (hasDiagnosticRelatedInformationCapability) {
			// TODO?
		}

		let arr = diagnosticsByPath[fullPath];

		if (arr) {
			arr.push(diagnostic);
		} else {
			diagnosticsByPath[fullPath] = [diagnostic];
		}
	}

	// Send the computed diagnostics to VSCode.
	for (let [uri, diagnostics] of Object.entries(diagnosticsByPath)) {
		connection.sendDiagnostics({ uri: uri, diagnostics: diagnostics });
	}
}

// This handler provides the initial list of the completion items.
connection.onCompletion(
	(_textDocumentPosition: TextDocumentPositionParams): CompletionItem[] => {
		// TODO
		return [
		];
	}
);

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();
