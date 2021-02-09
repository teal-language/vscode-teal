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
	Position,
	MarkupKind,
	CancellationToken,
	SignatureHelp
} from 'vscode-languageserver/node';

import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import { withFile } from 'tmp-promise'
import path = require('path');
import { access as fsAccess, constants as fsConstants } from 'fs';
import util = require("util");
import { spawn } from 'child_process';
import { symbolsInScope } from './teal';

interface TLCommandIOInfo {
	filePath: string | null,
	stdout: string,
	stderr: string
};

enum TLCommand {
	Check = "check",
	Types = "types",
	Version = "--version"
};

interface TLTypesCommandResult {
	ioInfo: TLCommandIOInfo,
	json: any
}

interface TLTypeInfo {
	location: Location | null,
	name: string
};

function fileExists(filePath: string): Promise<boolean> {
	return new Promise((resolve, reject) => {
		fsAccess(filePath, fsConstants.F_OK, function (error) {
			resolve(error === null);
		});
	});
}

const write = util.promisify(require("fs").write);

const documents = new TextDocuments(TextDocument);

// Create a connection for the server. The connection uses Node's IPC as a transport.
// Also include all preview / proposed LSP features.
let connection = createConnection(ProposedFeatures.all);

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;
let hasDiagnosticRelatedInformationCapability = false;

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
			typeDefinitionProvider: true,
			textDocumentSync: {
				openClose: true,
				change: TextDocumentSyncKind.Incremental
			},
			hoverProvider: true,
			signatureHelpProvider: {
				triggerCharacters: ["("],
				retriggerCharacters: [","]
			},
			completionProvider: {
				resolveProvider: false
			},
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

interface TealServerSettings { };

// The global settings, used when the `workspace/configuration` request is not supported by the client.
// Please note that this is not the case when using this server with the client provided in this example
// but could happen with other clients.
const defaultSettings: TealServerSettings = {};

let globalSettings: TealServerSettings = defaultSettings;

// Cache the settings of all open documents
let settingsCache: Map<string, Thenable<TealServerSettings>> = new Map();

// Cache "tl types" queries of all open documents
let typesCommandCache: Map<string, TLTypesCommandResult> = new Map();

async function verifyMinimumTLVersion(settings: TealServerSettings) {
	const tlVersion = await getTLVersion(settings);

	if (tlVersion !== null) {
		console.log(`tl version: ${tlVersion.major}.${tlVersion.minor}.${tlVersion.patch}`);

		if (tlVersion.major === 0 && tlVersion.minor < 11) {
			showErrorMessage("[Warning]\n" + "You are using an outdated version of the tl compiler. Please upgrade tl to v0.11.0 or later.");
			return null;
		}
	} else {
		console.log("[Warning] tl version is null");
	}
}

connection.onDidChangeConfiguration((change) => {
	if (hasConfigurationCapability) {
		// Reset all cached document settings
		settingsCache.clear();
	} else {
		globalSettings = <TealServerSettings>(
			(change.settings.teal || defaultSettings)
		);
	}

	// Revalidate all open text documents
	documents.all().forEach(async function (x: TextDocument) {
		const settings = await getDocumentSettings(x.uri);

		verifyMinimumTLVersion(settings);
		validateTextDocument(x.uri);
	});

	typesCommandCache.clear();
});

function getDocumentSettings(uri: string): Thenable<TealServerSettings> {
	if (!hasConfigurationCapability) {
		return Promise.resolve(globalSettings);
	}

	let result = settingsCache.get(uri);

	if (!result) {
		result = connection.workspace.getConfiguration({
			scopeUri: uri,
			section: 'teal'
		});

		settingsCache.set(uri, result);
	}

	return result;
}

function debounce(threshold: number, fn: (arg: string) => void): (arg: string) => void {
	let deferTimers: Record<string, NodeJS.Timeout> = {};

	return function (arg: string) {
		clearTimeout(deferTimers[arg]);
		deferTimers[arg] = setTimeout(fn, threshold, arg);
	};
}

function throttle(threshold: number, fn: (arg: string) => void): (arg: string) => void {
	let lasts: Record<string, number> = {};

	return function (arg: string) {
		let now = new Date().getTime();

		if (lasts[arg] !== undefined && now < lasts[arg] + threshold) {
			return;
		}

		lasts[arg] = now;

		setTimeout(fn, threshold, arg);
	};
}

interface MajorMinorPatch {
	major: number,
	minor: number,
	patch: number
}

async function getTLVersion(settings: TealServerSettings): Promise<MajorMinorPatch | null> {
	const commandResult = await runTLCommand(TLCommand.Version, null, settings);

	const majorMinorPatch = commandResult.stdout.match(/(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)/);

	if (majorMinorPatch === null) {
		return null;
	}

	const groups = majorMinorPatch.groups!;

	return {
		major: Number.parseInt(groups.major),
		minor: Number.parseInt(groups.minor),
		patch: Number.parseInt(groups.patch)
	};
}

function isEmptyOrSpaces(str: string) {
	return (str == null || str.trim() === '');
}

async function _feedTypeInfoCache(uri: string) {
	const textDocument = documents.get(uri);

	if (textDocument === undefined) {
		return null;
	}

	const settings = await getDocumentSettings(textDocument.uri);

	const documentText = textDocument.getText();

	const typesCmdResult = await runTLCommandOnText(TLCommand.Types, documentText, settings);

	if (typesCmdResult === null) {
		return null;
	}

	if (isEmptyOrSpaces(typesCmdResult.stdout)) {
		showErrorMessage("[Error]\n" + "`tl types` has returned an empty response.");
		return null;
	}

	try {
		var json: any = JSON.parse(typesCmdResult.stdout);
	} catch {
		console.log(typesCmdResult.stderr);
		showErrorMessage("[Error]\n" + "`tl types` has returned an invalid JSON response.");
		return null;
	};

	const result = {
		ioInfo: typesCmdResult,
		json: json
	};

	typesCommandCache.set(uri, result);
}

const feedTypeInfoCache = throttle(500, _feedTypeInfoCache);

function getTypeInfoFromCache(uri: string): TLTypesCommandResult | null {
	const cachedResult = typesCommandCache.get(uri);

	if (cachedResult === undefined) {
		return null;
	}

	return cachedResult;
}

documents.onDidOpen(async (e) => {
	const settings = await getDocumentSettings(e.document.uri);

	verifyMinimumTLVersion(settings);
});

// Only keep caches for open documents
documents.onDidClose(e => {
	settingsCache.delete(e.document.uri);
	typesCommandCache.delete(e.document.uri);
});

async function showErrorMessage(message: string, ...actions: MessageActionItem[]) {
	let params: ShowMessageRequestParams = { type: MessageType.Error, message, actions };

	return await connection.sendRequest(ShowMessageRequest.type, params);
}

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent(change => {
	validateTextDocument(change.document.uri);

	// Put new `tl types` data in cache
	feedTypeInfoCache(change.document.uri);
});

// Monitored files have changed in VS Code
connection.onDidChangeWatchedFiles(_change => {
	for (let x of documents.all()) {
		validateTextDocument(x.uri);

		// Put new `tl types` data in cache
		feedTypeInfoCache(x.uri);
	}
});

class TLNotFoundError extends Error { /* ... */ }

const tmpBufferPrefix = "__tl__tmp__check-";

async function pathInWorkspace(textDocument: TextDocument, pathToCheck: string): Promise<string | null> {
	if (path.basename(pathToCheck).startsWith(tmpBufferPrefix)) {
		return textDocument.uri
	}

	let workspaceFolders = await connection.workspace.getWorkspaceFolders();

	if (workspaceFolders === null) {
		return null;
	}

	let resolvedPath: string | null = null;

	for (const folder of workspaceFolders) {
		let folderPath = URI.parse(folder.uri).fsPath
		let fullPath = path.join(folderPath, pathToCheck);

		if (await fileExists(fullPath)) {
			resolvedPath = URI.file(fullPath).toString()
			break;
		}
	};

	return resolvedPath;
}

/**
 * Runs a `tl` command on a specific text.
 */
async function runTLCommandOnText(command: TLCommand, text: string, settings: TealServerSettings): Promise<TLCommandIOInfo | null> {
	try {
		return await withFile(async ({ path, fd }) => {
			await write(fd, text);

			try {
				let result = await runTLCommand(command, path, settings);
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

async function runTLCommand(command: TLCommand, filePath: string | null, settings: TealServerSettings): Promise<TLCommandIOInfo> {
	let child: any;

	let platform = process.platform;

	if (platform == "win32") {
		let args = ['/c', "tl.bat", "-q", command];

		if (filePath !== null) {
			args.push(filePath);
		}

		child = spawn('cmd.exe', args);
	} else {
		let args = ["-q", command];

		if (filePath !== null) {
			args.push(filePath);
		}

		child = spawn("tl", args);
	}

	return await new Promise(async function (resolve, reject) {
		let stdout = "";
		let stderr = "";

		child.on('error', function (error: any) {
			if (error.code === 'ENOENT') {
				let errorMessage = "Could not find the tl executable. Please make sure that it is available in the PATH.";
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

async function _validateTextDocument(uri: string): Promise<void> {
	const textDocument: TextDocument | undefined = documents.get(uri);

	if (textDocument === undefined) {
		return;
	}

	let settings = await getDocumentSettings(textDocument.uri);

	let checkResult = await runTLCommandOnText(TLCommand.Check, textDocument.getText(), settings);

	if (checkResult === null) {
		connection.sendDiagnostics({ uri: textDocument.uri, diagnostics: [] });
		return;
	}

	let crashPattern = /stack traceback:/m;

	if (crashPattern.test(checkResult.stderr)) {
		connection.sendDiagnostics({ uri: textDocument.uri, diagnostics: [] });
		showErrorMessage("[Error]\n" + checkResult.stderr);
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

const validateTextDocument = debounce(500, _validateTextDocument);

async function autoComplete(textDocumentPositionParams: TextDocumentPositionParams): Promise<CompletionItem[]> {
	let textDocument = documents.get(textDocumentPositionParams.textDocument.uri);

	if (textDocument === undefined) {
		return [];
	}

	const position = textDocumentPositionParams.position;

	const typeInfo = getTypeInfoFromCache(textDocument.uri);

	if (typeInfo === null) {
		return [];
	}

	function makeBasicItem(str: string) {
		return {
			label: str,
			kind: CompletionItemKind.Keyword
		};
	}

	// Built-in types and keywords
	let result: CompletionItem[] = [
		"any",
		"number",
		"string",
		"boolean",
		"thread",
		"nil",
		"break",
		"goto",
		"do",
		"end",
		"while",
		"repeat",
		"until",
		"if",
		"then",
		"elseif",
		"else",
		"for",
		"in",
		"function",
		"local",
		"global",
		"record",
		"enum",
		"type",
		"userdata"
	].map(x => makeBasicItem(x));

	let symbols = symbolsInScope(typeInfo.json, position.line + 1, position.character + 1);

	for (const symbol of symbols) {
		let typeDefinition: any | undefined = typeInfo.json?.["types"]?.[symbol.typeId];

		if (typeDefinition === undefined || typeDefinition["str"] === undefined) {
			continue;
		}

		let kind: CompletionItemKind = CompletionItemKind.Interface;

		if (typeDefinition["ref"] !== undefined) {
			kind = CompletionItemKind.Variable;
		} else if (typeDefinition["str"].startsWith("function(")) {
			kind = CompletionItemKind.Function;
		} else if (typeDefinition["enums"] !== undefined) {
			kind = CompletionItemKind.Enum;
		} else if (typeDefinition["str"].startsWith("type record")) {
			kind = CompletionItemKind.Class;
		}

		result.push({
			label: symbol.identifier,
			kind: kind,
			data: symbol.typeId,
			detail: typeDefinition.str
		});
	}

	return result;
}

connection.onCompletion(autoComplete);

async function signatureHelp(textDocumentPosition: TextDocumentPositionParams, token: CancellationToken): Promise<SignatureHelp | null> {
	// TODO
	return null;

	const document: TextDocument | undefined = documents.get(textDocumentPosition.textDocument.uri);

	if (document === undefined) {
		return null;
	}

	return {
		signatures: [
			{
				label: "This is a test"
			}
		],
		activeParameter: null,
		activeSignature: 0,
	};
};

connection.onSignatureHelp(signatureHelp);

const identifierRegex = /[a-zA-Z0-9_]/;

function getWordRangeAtPosition(document: TextDocument, position: Position): Range | null {
	// Get text on current line
	let str = document.getText(Range.create(position.line, 0, position.line, position.character));

	let start = position.character;
	let end = position.character;

	// Make sure the cursor is on an identifier
	if (!identifierRegex.test(str[start])) {
		return null;
	}

	while (start > 0 && identifierRegex.test(str[start - 1])) {
		start--;
	}

	while (end < str.length - 1 && identifierRegex.test(str[end + 1])) {
		end++;
	}

	return Range.create(position.line, start, position.line, end);
}

async function getTypeInfoAtPosition(textDocumentIdentifier: TextDocumentIdentifier, position: Position): Promise<TLTypeInfo | null> {
	const textDocument = documents.get(textDocumentIdentifier.uri);

	if (textDocument === undefined) {
		return null;
	}

	const typeInfo = getTypeInfoFromCache(textDocumentIdentifier.uri);

	if (typeInfo === null) {
		return null;
	}

	const tmpPath = typeInfo.ioInfo.filePath!;
	const typesJson = typeInfo.json;

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

	let typeName: string | undefined = typeDefinition["str"];

	let typeRef: string | undefined = typeDefinition["ref"];

	if (typeRef !== undefined) {
		typeDefinition = typesJson["types"][typeRef];

		if (typeDefinition["str"] === "type record" && typeName !== undefined) {
			// record
			typeName = "record " + typeName;
		}
		else if (typeDefinition["enums"] !== undefined) {
			// enum
			typeName = typeDefinition["str"].replace(/^type /, "enum ");
		}
		else {
			// `type`
			typeName = `type ${typeName} = ${typeDefinition["str"].replace(/^type /, "")}`;
		}
	}

	if (typeName === undefined) {
		return null;
	}

	let destinationLocation: Location | null = null;

	let destinationY = typeDefinition["y"];
	let destinationX = typeDefinition["x"];

	if (destinationY !== undefined && destinationX !== undefined) {
		let destinationRange = Range.create(destinationY - 1, destinationX - 1, destinationY - 1, destinationX - 1);

		let typeFile: string | undefined = typeDefinition["file"];

		if (typeFile === undefined) {
			typeFile = tmpPath;
		}

		let destinationUri: string | null = await pathInWorkspace(textDocument, typeFile);

		if (destinationUri !== null) {
			destinationLocation = Location.create(destinationUri, destinationRange);
		}
	}

	return {
		location: destinationLocation,
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

connection.onTypeDefinition(async function (params) {
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
			kind: MarkupKind.Markdown,
			value: "```teal\n" + typeAtCursor.name + "\n```",
		}
	};
});

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();
