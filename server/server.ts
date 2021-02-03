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
	CompletionItemKind,
	MessageActionItem,
	ShowMessageRequestParams,
	MessageType,
	ShowMessageRequest,
	VersionedTextDocumentIdentifier,
	WorkspaceFolder,
	WorkspaceFoldersRequest,
	FormattingOptions,
	Location,
	TextDocumentIdentifier,
	Definition,
	Position
} from 'vscode-languageserver/node';

import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import { withFile } from 'tmp-promise'
import path = require('path');
import { existsSync } from 'fs';
import util = require("util");
import { spawn } from 'child_process';

interface TLCommandResult {
	filePath: string,
	stdout: string,
	stderr: string
};

interface TLTypeInfo {
	location: Location,
	name: string
};

enum TLCommand {
	Check = "check",
	Types = "types"
};

const write = util.promisify(require("fs").write);

const documents = new TextDocuments(TextDocument);

// Create a connection for the server. The connection uses Node's IPC as a transport.
// Also include all preview / proposed LSP features.
let connection = createConnection(ProposedFeatures.all,);

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
			definitionProvider: true,
			textDocumentSync: TextDocumentSyncKind.Full,
			// Tell the client that the server DOES NOT support code completion
			completionProvider: {
				resolveProvider: false
			},
			hoverProvider: true
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

const tmpBufferPrefix = "__tl__tmp__check-";

async function pathInWorkspace(textDocument: TextDocument, pathToCheck: string): Promise<string | null> {
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

/**
 * Runs a `tl` command on a specific text.
 */
async function runTLCommand(command: TLCommand, text: string, settings: TealServerSettings): Promise<TLCommandResult | null> {
	try {
		return await withFile(async ({ path, fd }) => {
			await write(fd, text);

			try {
				let result = await _runTLCommand(command, path, settings);
				return result;
			} catch (error) {
				throw error;
			}
		}, { prefix: tmpBufferPrefix });
	} catch (error) {
		await showErrorMessage(error.message);
		return null;
	}
}

async function _runTLCommand(command: TLCommand, filePath: string, settings: TealServerSettings): Promise<TLCommandResult> {
	let child: any;

	let platform = process.platform;

	const compilerPath = getCompilerPath(settings);

	if (platform == "win32") {
		child = spawn('cmd.exe', ['/c', compilerPath, "-q", command, filePath]);
	} else {
		child = spawn(compilerPath, ["-q", command, filePath]);
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
			resolve({ filePath: filePath, stdout: stdout, stderr: stderr });
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

	let checkResult = await runTLCommand(TLCommand.Check, textDocument.getText(), settings);

	if (checkResult === null) {
		return;
	}

	let errorPattern = /(?<fileName>^.*?):(?<lineNumber>\d+):((?<columnNumber>\d+):)? (?<errorMessage>.+)$/gm;

	let diagnosticsByPath: { [id: string]: Diagnostic[] } = {};
	diagnosticsByPath[textDocument.uri] = [];

	let syntaxError: RegExpExecArray | null;

	while ((syntaxError = errorPattern.exec(checkResult.stderr))) {
		const groups = syntaxError.groups!;

		let errorPath = path.normalize(groups.fileName);
		let fullPath = await pathInWorkspace(textDocument, errorPath);

		if (fullPath === null) {
			continue;
		}

		let lineNumber = Number.parseInt(groups.lineNumber) - 1;
		let columnNumber = Number.MAX_VALUE;

		if (groups.columnNumber !== undefined) {
			columnNumber = Number.parseInt(groups.columnNumber) - 1
		}

		let errorMessage = groups.errorMessage;

		// Avoid showing the temporary file's name in the error message
		errorMessage = errorMessage.replace(errorPath, fullPath);

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

/* async function autoComplete(textDocumentPositionParams: TextDocumentPositionParams): Promise<CompletionItem[]> {
	let textDocument = documents.get(textDocumentPositionParams.textDocument.uri);

	if (textDocument === undefined) {
		return [];
	}

	let settings = await getDocumentSettings(textDocument.uri);

	let typesCmdResult: string;

	try {
		typesCmdResult = await withFile(async ({ path, fd }) => {
			await write(fd, textDocument!.getText());

			try {
				let result = await runTL("types", path, settings);
				return result.stdout;
			} catch (error) {
				throw error;
			}
		}, { prefix: tmpBufferPrefix });
	} catch (error) {
		await showErrorMessage(error.message);
		return [];
	}

	let typesJson = JSON.parse(typesCmdResult);

	// Built-in types
	let result: CompletionItem[] = [
		{
			label: 'any',
			kind: CompletionItemKind.Keyword,
			data: 0
		},
		{
			label: 'number',
			kind: CompletionItemKind.Keyword,
			data: 0
		},
		{
			label: 'string',
			kind: CompletionItemKind.Keyword,
			data: 0
		},
		{
			label: 'boolean',
			kind: CompletionItemKind.Keyword,
			data: 0
		}
	];

	for (let x in typesJson["types"]) {
		let typ = typesJson["types"][x];

		console.log(typ);

		if (typ["ref"] !== undefined) {
			result.push(
				{
					label: typ["str"],
					kind: CompletionItemKind.Class,
					data: x
				}
			);
		}
	}

	return result;
}

connection.onCompletion(autoComplete);

// This handler resolves additional information for the item selected in
// the completion list.
connection.onCompletionResolve(
	(item: CompletionItem): CompletionItem => {
		if (item.data === 0) {
			item.detail = 'Built-in type';
			item.documentation = 'Built-in type';
		}

		return item;
	}
); */

// This handler provides the initial list of the completion items.
connection.onCompletion(
	(_textDocumentPosition: TextDocumentPositionParams): CompletionItem[] => {
		// TODO
		return [
		];
	}
);

const identifierRegex = /[a-zA-Z0-9_]/;

function getWordRangeAtPosition(document: TextDocument, position: Position): Range | null {
	// Get text on current line
	let str = document.getText(Range.create(position.line, 0, position.line, position.character));

	let start = position.character;
	let end = position.character;

	if (!identifierRegex.exec(str[start])) {
		return null;
	}

	while (start > 0 && identifierRegex.exec(str[start - 1])) {
		start--;
	}

	while (end < str.length - 1 && identifierRegex.exec(str[end + 1])) {
		end++;
	}

	return Range.create(position.line, start, position.line, end);
}

async function getTypeInfoAtPosition(textDocumentIdentifier: TextDocumentIdentifier, position: Position): Promise<TLTypeInfo | null> {
	const textDocument = documents.get(textDocumentIdentifier.uri);

	if (textDocument === undefined) {
		return null;
	}

	let settings = await getDocumentSettings(textDocument.uri);

	let typesCmdResult = await runTLCommand(TLCommand.Types, textDocument.getText(), settings);

	if (typesCmdResult === null) {
		return null;
	}

	let typesJson = JSON.parse(typesCmdResult.stdout);

	const tmpPath = typesCmdResult.filePath;

	let wordRange = getWordRangeAtPosition(textDocument, position);

	if (wordRange === null) {
		return null;
	};

	let typeId: string | undefined = typesJson?.["by_pos"]?.[tmpPath]?.[position.line + 1]?.[wordRange.start.character + 1];

	if (typeId === undefined) {
		return null;
	}

	let typeDefinition: any | undefined = typesJson?.["types"]?.[typeId];

	if (typeDefinition === undefined) {
		return null;
	}

	let typeName = typeDefinition["str"];

	let typeRef: string | undefined = typeDefinition["ref"];

	if (typeRef !== undefined) {
		typeDefinition = typesJson["types"][typeRef];

		if (typeDefinition["str"] !== "type record") {
			typeName = typeDefinition["str"];
		}
	}

	let destinationY = typeDefinition["y"];
	let destinationX = typeDefinition["x"];

	if (destinationY === undefined || destinationX == undefined) {
		return null;
	}

	let typeFile: string | undefined = typeDefinition["file"];

	if (typeFile === undefined) {
		typeFile = tmpPath;
	}

	let destinationRange = Range.create(destinationY - 1, destinationX - 1, destinationY - 1, destinationX - 1);

	let destinationUri: string | null = await pathInWorkspace(textDocument, typeFile);

	if (destinationUri === null) {
		return null;
	}

	if (typeName === undefined) {
		return null;
	}

	return {
		location: Location.create(destinationUri, destinationRange),
		name: typeName
	}
}

connection.onDefinition(async function (params) {
	const typeAtCursor = await getTypeInfoAtPosition(params.textDocument, params.position);

	if (typeAtCursor === null) {
		return null;
	}

	return typeAtCursor.location;
});

connection.onHover(async function (params) {
	const typeAtCursor = await getTypeInfoAtPosition(params.textDocument, params.position);

	if (typeAtCursor === null) {
		return null;
	}

	return {
		contents: {
			kind: 'markdown',
			value: "```teal.type\n" + typeAtCursor.name + "\n```",
		},
	};
});

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();
