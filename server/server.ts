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
	ShowMessageRequest
} from 'vscode-languageserver';

import { TextDocument } from 'vscode-languageserver-textdocument';

const documents = new TextDocuments(TextDocument);

import { withFile } from 'tmp-promise'

const util = require("util");
const write = util.promisify(require("fs").write);
const { spawn } = require('child_process');
var path = require('path');

// Create a connection for the server. The connection uses Node's IPC as a transport.
// Also include all preview / proposed LSP features.
let connection = createConnection(ProposedFeatures.all);

let hasConfigurationCapability: boolean = false;
let hasWorkspaceFolderCapability: boolean = false;
let hasDiagnosticRelatedInformationCapability: boolean = false;

let workspaceRoot: string | null | undefined;

connection.onInitialize((params: InitializeParams) => {
	let capabilities = params.capabilities;

	workspaceRoot = params.rootPath;

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

class TLNotFoundError extends Error { /* ... */ }

function isNullOrWhitespace(input: string | null | undefined) {
	return !input || !input.trim();
}

async function runTLCheck(filePath: string): Promise<string> {
	var env = Object.create(process.env);

	if (!isNullOrWhitespace(workspaceRoot)) {
		var luaPath = path.join(workspaceRoot, "?.lua");

		env.LUA_PATH += ";" + luaPath;
	}

	let child = spawn('tl', ["check", filePath], { env: env });

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

	try {
		checkResult = await withFile(async ({ path, fd }) => {
			await write(fd, textDocument.getText());

			try {
				let result = await runTLCheck(path);
				return result;
			} catch (error) {
				throw error;
			}
		});
	} catch (error) {
		await showErrorMessage(error.message);
		return;
	}

	let errorPattern = /^.*:(\d+):(\d+): (.+)$/gm;

	let diagnostics: Diagnostic[] = [];
	let syntaxError: RegExpExecArray | null;

	while ((syntaxError = errorPattern.exec(checkResult))) {
		let lineNumber = Number.parseInt(syntaxError[1]) - 1;
		let columnNumber = Number.parseInt(syntaxError[2]) - 1;
		let errorMessage = syntaxError[3];

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

		diagnostics.push(diagnostic);
	}

	// Send the computed diagnostics to VSCode.
	connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
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
