/* --------------------------------------------------------------------------------------------
 * Based on lsp-sample.
 * See LICENSE-vscode-extension-samples at the root of the project for licensing info.
 * ------------------------------------------------------------------------------------------ */

import {
	createConnection,
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
	Location,
	TextDocumentIdentifier,
	Position,
	MarkupKind,
	CancellationToken,
	SignatureHelp,
	ParameterInformation,
	SignatureInformation
} from 'vscode-languageserver/node';

import { URI } from 'vscode-uri';
import { withFile } from 'tmp-promise'
import path = require('path');
import { access as fsAccess, constants as fsConstants } from 'fs';
import util = require("util");
import { spawn } from 'child_process';
import { symbolsInScope, Symbol } from './teal';
import { pointToPosition, positionInNode, positionToPoint, TreeSitterDocument } from './tree-sitter-document'
import { SyntaxNode } from 'web-tree-sitter';

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

const documents: Map<string, TreeSitterDocument> = new Map();

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
				triggerCharacters: ["(", ","]
			},
			completionProvider: {
				resolveProvider: false,
				triggerCharacters: [".", ":"],
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
	documents.forEach(async function (x: TreeSitterDocument) {
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

function throttle(threshold: number, fn: (arg: string) => Promise<null | undefined>): (arg: string) => void {
	let running: Record<string, boolean> = {};
	let retrigger: Record<string, boolean> = {};

	return function callback(arg: string) {
		if (running[arg]) {
			retrigger[arg] = true;
			return;
		}

		running[arg] = true;
		retrigger[arg] = false;

		const beforeCall = new Date().getTime();

		fn(arg).then(() => {
			const afterCall = new Date().getTime();

			const waitTime = Math.max(0, threshold - (afterCall - beforeCall));

			const postCall = function () {
				running[arg] = false;

				if (retrigger[arg]) {
					callback(arg);
				}
			}

			if (waitTime === 0) {
				postCall();
			} else {
				setTimeout(postCall, waitTime);
			}
		});
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

const feedTypeInfoCache = throttle(250, _feedTypeInfoCache);

function getTypeInfoFromCache(uri: string): TLTypesCommandResult | null {
	const cachedResult = typesCommandCache.get(uri);

	if (cachedResult === undefined) {
		return null;
	}

	return cachedResult;
}

connection.onDidOpenTextDocument(async (params) => {
	// A text document got opened in VS Code.
	// params.uri uniquely identifies the document. For documents store on disk this is a file URI.
	// params.text the initial full content of the document.

	const settings = await getDocumentSettings(params.textDocument.uri);
	verifyMinimumTLVersion(settings);

	const treeSitterDocument = new TreeSitterDocument();
	treeSitterDocument.init(params.textDocument.uri, params.textDocument.text);

	documents.set(params.textDocument.uri, treeSitterDocument);
});

connection.onDidChangeTextDocument((params) => {
	// The content of a text document did change in VS Code.
	// params.uri uniquely identifies the document.
	// params.contentChanges describe the content changes to the document.
	const uri = params.textDocument.uri;

	const document = documents.get(uri);

	if (document === undefined) {
		return;
	}

	document.edit(params.contentChanges);

	validateTextDocument(uri);

	// Put new `tl types` data in cache
	feedTypeInfoCache(uri);
});

connection.onDidCloseTextDocument((params) => {
	const uri = params.textDocument.uri;

	settingsCache.delete(uri);
	typesCommandCache.delete(uri);
	documents.delete(uri);
});

async function showErrorMessage(message: string, ...actions: MessageActionItem[]) {
	let params: ShowMessageRequestParams = { type: MessageType.Error, message, actions };

	return await connection.sendRequest(ShowMessageRequest.type, params);
}

// Monitored files have changed in VS Code
connection.onDidChangeWatchedFiles(_change => {
	for (let [uri, document] of documents) {
		validateTextDocument(uri);

		// Put new `tl types` data in cache
		feedTypeInfoCache(uri);
	}
});

class TLNotFoundError extends Error { /* ... */ }

const tmpBufferPrefix = "__tl__tmp__check-";

async function pathInWorkspace(textDocument: TreeSitterDocument, pathToCheck: string): Promise<string | null> {
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
	const textDocument: TreeSitterDocument | undefined = documents.get(uri);

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

function findNodeAbove(baseNode: SyntaxNode, type: string): SyntaxNode | null {
	let ptr: SyntaxNode | null = baseNode;

	while (ptr !== null) {
		if (ptr.type === type) {
			return ptr;
		}

		const fieldNode = ptr.childForFieldName(type);

		if (fieldNode != null) {
			return fieldNode;
		}

		ptr = ptr.parent;
	}

	return null;
}

/**
 * Given an index node, get the type info in json format of the before-last node
 */
function walkMultiSym2(node: SyntaxNode, typeInfo: TLTypesCommandResult, symbols: Map<string, Symbol>): any | null {
	let indexNode = findNodeAbove(node, "index");

	if (indexNode === null) {
		indexNode = findNodeAbove(node, "method_index");

		if (indexNode === null) {
			indexNode = findNodeAbove(node, "type_index");

			if (indexNode === null) {
				return null;
			}
		}
	}

	console.log("Index node:", indexNode.text);

	let ptr: SyntaxNode | null;

	if (indexNode.childCount === 0) {
		ptr = indexNode;
	} else {
		ptr = indexNode.firstChild!;

		while (ptr.firstChild !== null) {
			ptr = ptr.firstChild;
		}
	}

	if (ptr === null) {
		return null;
	}

	const rootName = ptr.text;

	if (rootName === undefined) {
		return null;
	}

	const rootTypeSymbol = symbols.get(rootName);

	if (rootTypeSymbol === undefined) {
		return null;
	}

	let rootType: any | undefined = typeInfo.json?.["types"]?.[rootTypeSymbol.typeId];

	if (rootType === undefined) {
		return null;
	}

	while (rootType.ref !== undefined) {
		rootType = typeInfo.json?.["types"]?.[rootType.ref];
	}

	if (rootType.childCount === 0) {
		return rootType;
	}

	console.log("Getting the symbols parts");

	const symbolParts = getSymbolParts(indexNode);

	console.log("Got the parts:", symbolParts);

	let typeRef = rootType;

	for (let x = 1; x < symbolParts.length - 1; ++x) {
		const childStr = symbolParts[x];

		// what is the type of the next symbol?
		// it depends on the type of the current one

		let childTypeId: any | undefined;

		console.log("Type code:", typeRef["t"])

		// is it a record? if so, check in fields
		if (typeRef["t"] === 0x00020008) {
			childTypeId = typeRef.fields?.[childStr];
		}

		// a "nominal"?
		else if (typeRef["t"] === 0x10000000) {
			while (typeRef.ref !== undefined) {
				typeRef = typeInfo.json?.["types"]?.[typeRef.ref];
			}

			childTypeId = typeRef.fields?.[childStr];
		}

		// an array?
		else if (typeRef["t"] === 0x00010008) {
			childTypeId = typeRef.elements;
		}

		// a map?
		else if (typeRef["t"] === 0x00040008) {
			childTypeId = typeRef.values;
		}

		// an arrayrecords?
		else if (typeRef["t"] === 0x00030008) {
			childTypeId = typeRef.fields?.[childStr];

			if (childTypeId === undefined) {
				childTypeId = typeRef.elements;
			}
		}

		// tuples not yet supported :(
		else if (typeRef["t"] === 0x00080008) {

		}

		// a function?
		else if (typeRef["t"] === 0x00000020) {
			childTypeId = typeRef.rets[0][0];
		}

		if (childTypeId === undefined) {
			return null;
		}

		let childType = typeInfo.json?.["types"]?.[childTypeId];

		while (childType.ref !== undefined) {
			childType = typeInfo.json?.["types"]?.[childType.ref];
		}

		typeRef = childType;
	}

	console.log("Type at the tip:", typeRef);

	return typeRef;
}

async function autoComplete(textDocumentPositionParams: TextDocumentPositionParams): Promise<CompletionItem[]> {
	let document = documents.get(textDocumentPositionParams.textDocument.uri);

	if (document === undefined) {
		return [];
	}

	const position = textDocumentPositionParams.position;

	let nodeAtPosition: SyntaxNode | null = document.getNodeAtPosition(position);

	if (nodeAtPosition === null) {
		return [];
	}

	const isType = findNodeAbove(nodeAtPosition, "type_annotation") !== null
		|| findNodeAbove(nodeAtPosition, "type") !== null
		|| findNodeAbove(nodeAtPosition, "table_type") !== null
		|| findNodeAbove(nodeAtPosition, "type_cast") !== null
		|| findNodeAbove(nodeAtPosition, "return_type") !== null
		|| findNodeAbove(nodeAtPosition, "simple_type") !== null;

	const typeInfo = getTypeInfoFromCache(document.uri);

	if (typeInfo === null) {
		return [];
	}

	let symbols = symbolsInScope(typeInfo.json, position.line + 1, position.character + 1);

	function makeBasicItem(str: string, kind: CompletionItemKind) {
		return {
			label: str,
			kind: kind
		};
	}

	let result: CompletionItem[] = [];

	let indexType = walkMultiSym2(nodeAtPosition, typeInfo, symbols);

	if (indexType !== null && indexType.fields !== undefined) {
		for (const [identifier, typeId] of Object.entries(indexType.fields)) {
			let typeDefinition: any | undefined = typeInfo.json?.["types"]?.[typeId as number];

			if (typeDefinition === undefined || typeDefinition["str"] === undefined) {
				continue;
			}

			let kind: number = CompletionItemKind.Variable;

			if (typeDefinition["ref"] !== undefined) {
				kind = CompletionItemKind.Variable;
			} else if (typeDefinition["str"].startsWith("function(") || typeDefinition["str"].startsWith("function<")) {
				kind = CompletionItemKind.Function;
			} else if (typeDefinition["enums"] !== undefined) {
				kind = CompletionItemKind.Enum;
			} else if (typeDefinition["str"].startsWith("type record")) {
				kind = CompletionItemKind.Class;
			}

			const detail = prettifyTypeStr(typeDefinition.str);

			result.push({
				label: identifier,
				kind: kind as CompletionItemKind,
				data: typeId,
				detail: detail,
				commitCharacters: ["("]
			});
		}

		return result;
	}

	// Built-in types and keywords
	result = [
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
	].map(x => makeBasicItem(x, CompletionItemKind.Keyword));

	result = result.concat([
		"any",
		"number",
		"string",
		"boolean",
		"thread",
		"nil",
	].map(x => makeBasicItem(x, CompletionItemKind.Interface)));

	for (const [symbolIdentifier, symbol] of symbols) {
		let typeDefinition: any | undefined = typeInfo.json?.["types"]?.[symbol.typeId];

		if (typeDefinition === undefined || typeDefinition["str"] === undefined) {
			continue;
		}

		let kind: number = CompletionItemKind.Variable;

		if (typeDefinition["ref"] !== undefined) {
			kind = CompletionItemKind.Variable;
		} else if (typeDefinition["str"].startsWith("function(") || typeDefinition["str"].startsWith("function<")) {
			kind = CompletionItemKind.Function;
		} else if (typeDefinition["enums"] !== undefined) {
			kind = CompletionItemKind.Enum;
		} else if (typeDefinition["str"].startsWith("record") || typeDefinition["str"].startsWith("type record")) {
			kind = CompletionItemKind.Class;
		}

		const detail = prettifyTypeStr(typeDefinition.str);

		result.push({
			label: symbol.identifier,
			kind: kind as CompletionItemKind,
			data: symbol.typeId,
			detail: detail,
			commitCharacters: ["("]
		});
	}

	if (isType === true) {
		result = result.filter(x =>
			x.kind !== CompletionItemKind.Variable
			&& x.kind !== CompletionItemKind.Function
			&& x.kind !== CompletionItemKind.Keyword
		);
	} else {
		result = result.filter(x =>
			x.kind !== CompletionItemKind.Interface
		);
	}

	return result;
}

connection.onCompletion(autoComplete);

function prettifyTypeStr(type: string): string {
	let result = type.replace(/<any type>/gm, "any");
	result = result.replace(/@a/gm, "T");
	result = result.replace(/@b/gm, "U");
	result = result.replace(/\band\b/gm, "&")

	return result
}

function getFunctionSignature(uri: string, functionName: string, typeJson: any): SignatureInformation | null {
	const typeInfo = getTypeInfoFromCache(uri);

	if (typeInfo === null) {
		return null;
	}

	if (typeJson.args === undefined) {
		return null;
	}

	const parameters = new Array<ParameterInformation>();

	for (let argument of typeJson.args) {
		let argumentType = typeInfo.json["types"][argument[0]];

		parameters.push({
			label: prettifyTypeStr(argumentType.str)
		});
	}

	const returnTypes = new Array<string>();

	for (let returnType of typeJson.rets) {
		let retType = typeInfo.json["types"][returnType[0]];

		returnTypes.push(prettifyTypeStr(retType.str));
	}

	let label = `${functionName}(${parameters.map(x => x.label).join(", ")})`;

	if (returnTypes.length > 0) {
		label += ": " + returnTypes.join(", ");
	}

	return {
		label: label,
		parameters: parameters
	}
}

function getSymbolParts(parentNode: SyntaxNode): Array<string> {
	if (parentNode.childCount === 0) {
		return [parentNode.text];
	}

	const result = new Array<string>();

	let ptr: SyntaxNode | null = parentNode;

	console.log("This the parent node:", parentNode.text);

	while (ptr.firstChild !== null) {
		if (ptr.type === "index" || ptr.type === "method_index") {
			let field = ptr.lastChild!;

			result.push(field.text);
		}

		ptr = ptr.firstChild;
	}

	result.push(ptr.text);

	return result.reverse();
}

async function signatureHelp(textDocumentPosition: TextDocumentPositionParams, token: CancellationToken): Promise<SignatureHelp | null> {
	const document: TreeSitterDocument | undefined = documents.get(textDocumentPosition.textDocument.uri);

	if (document === undefined) {
		return null;
	}

	const position = textDocumentPosition.position;

	const nodeAtPosition = document.getNodeAtPosition(position);

	if (nodeAtPosition === null) {
		return null;
	}

	const parentNode = findNodeAbove(nodeAtPosition, "function_call");

	if (parentNode === null) {
		return null;
	}

	const calledObject = parentNode.childForFieldName("called_object")!;

	const functionArgs = findNodeAbove(nodeAtPosition, "arguments");

	if (functionArgs === null) {
		return null;
	}

	const typeInfo = getTypeInfoFromCache(document.uri);

	if (typeInfo === null) {
		return null;
	}

	const symbols = symbolsInScope(typeInfo.json, position.line + 1, position.character + 1);

	if (symbols === null) {
		return null;
	}

	const functionType = walkMultiSym2(calledObject, typeInfo, symbols);

	if (functionType === null) {
		return null;
	}

	let functionName: string;

	if (calledObject.type === "identifier") {
		functionName = calledObject.text;
	} else {
		functionName = calledObject.lastChild!.text;
	}

	if (functionName === null) {
		return null;
	}

	const functionSignature = getFunctionSignature(document.uri, functionName, functionType);

	if (functionSignature === null) {
		return null;
	}

	return {
		signatures: [
			functionSignature
		],
		activeParameter: Math.max(0, functionArgs.namedChildCount - 1),
		activeSignature: 0,
	};
};

connection.onSignatureHelp(signatureHelp);

const identifierRegex = /[a-zA-Z0-9_]/;

function getWordRangeAtPosition(document: TreeSitterDocument, position: Position): Range | null {
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

async function getTypeInfoAtPosition(uri: string, position: Position): Promise<TLTypeInfo | null> {
	const textDocument = documents.get(uri);

	if (textDocument === undefined) {
		return null;
	}

	const typeInfo = getTypeInfoFromCache(uri);

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
		name: prettifyTypeStr(typeName)
	}
}

connection.onDefinition(async function (params) {
	const typeAtCursor = await getTypeInfoAtPosition(params.textDocument.uri, params.position);

	if (typeAtCursor === null) {
		return null;
	}

	return typeAtCursor.location;
});

connection.onTypeDefinition(async function (params) {
	const typeAtCursor = await getTypeInfoAtPosition(params.textDocument.uri, params.position);

	if (typeAtCursor === null) {
		return null;
	}

	return typeAtCursor.location;
});

connection.onHover(async function (params) {
	const typeAtCursor = await getTypeInfoAtPosition(params.textDocument.uri, params.position);

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

// Listen on the connection
connection.listen();
