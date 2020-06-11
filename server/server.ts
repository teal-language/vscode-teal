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

const documents = new TextDocuments(TextDocument);

import { withFile } from 'tmp-promise'
import path = require('path');
import { existsSync } from 'fs';

const util = require("util");
const write = util.promisify(require("fs").write);
const { spawn } = require('child_process');

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

}

// The global settings, used when the `workspace/configuration` request is not supported by the client.
// Please note that this is not the case when using this server with the client provided in this example
// but could happen with other clients.
const defaultSettings: TealServerSettings = {};
let globalSettings: TealServerSettings = defaultSettings;

// Cache the settings of all open documents
let documentSettings: Map<string, Thenable<TealServerSettings>> = new Map();

connection.onDidChangeConfiguration(change => {
	if (hasConfigurationCapability) {
		// Reset all cached document settings
		documentSettings.clear();
	} else {
		globalSettings = <TealServerSettings>(
			(change.settings.languageServerExample || defaultSettings)
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
			section: 'languageServerExample'
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

async function runTLCheck(filePath: string): Promise<string> {
	let child: any;

	let platform = process.platform;
	if (platform == "win32") {
		child = spawn('cmd.exe', ['/c', 'tl.bat', "check", filePath]);
	} else {
		child = spawn('tl', ["check", filePath]);
	}

	return await new Promise(async function (resolve, reject) {
		let stdout = "";
		let stderr = "";

		child.on('error', function (error: any) {
			if (error.code === 'ENOENT') {
				reject(new TLNotFoundError("Could not find the tl executable. Please make sure that it is available in the PATH."));
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

	// If someone names their file with this as a prefix they probably don't deserve problem reporting.
	const tmpBufferPrefix = "__tl__tmp__check-";

	try {
		checkResult = await withFile(async ({ path, fd }) => {
			await write(fd, textDocument.getText());

			try {
				let result = await runTLCheck(path);
				return result;
			} catch (error) {
				throw error;
			}
		}, { prefix: tmpBufferPrefix });
	} catch (error) {
		await showErrorMessage(error.message);
		return;
	}

	let errorPattern = /(^.*):(\d+):(\d+): (.+)$/gm;

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
			// Surely there is some URI nonsense we can do to append paths?
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
		let errorPath = path.normalize(syntaxError[1]);
		let fullPath = await pathInWorkspace(errorPath);

		if (fullPath === null) {
			continue;
		}

		let lineNumber = Number.parseInt(syntaxError[2]) - 1;
		let columnNumber = Number.parseInt(syntaxError[3]) - 1;
		let errorMessage = syntaxError[4];

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
