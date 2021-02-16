/* --------------------------------------------------------------------------------------------
 * Based on lsp-sample.
 * See LICENSE-vscode-extension-samples at the root of the project for licensing info.
 * ------------------------------------------------------------------------------------------ */

import {
	createConnection,
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
	Position,
	MarkupKind,
	CancellationToken,
	SignatureHelp,
	ParameterInformation,
	SignatureInformation
} from 'vscode-languageserver/node';

import { URI } from 'vscode-uri';
import * as path from "path";
import { Teal } from './teal';
import { findNodeOrFieldAbove, pointToPosition, positionInNode, positionToPoint, TreeSitterDocument } from './tree-sitter-document'
import { SyntaxNode } from 'web-tree-sitter';
import { fileExists } from './file-utils';
import { TealLS } from './diagnostics';
import { isEmptyOrSpaces } from './text-utils';
import { autoComplete } from './intellisense';

const documents: Map<string, TreeSitterDocument> = new Map();

let connection = createConnection(ProposedFeatures.all);

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;

connection.onInitialize((params: InitializeParams) => {
	let capabilities = params.capabilities;

	hasConfigurationCapability = (
		capabilities.workspace !== undefined 
		&& capabilities.workspace.configuration === true
	);

	hasWorkspaceFolderCapability = (
		capabilities.workspace !== undefined
		&& capabilities.workspace.workspaceFolders === true
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
		connection.client.register(DidChangeConfigurationNotification.type, undefined);
	}

	if (hasWorkspaceFolderCapability) {
		connection.workspace.onDidChangeWorkspaceFolders(_event => {
			connection.console.log('Workspace folder change event received.');
		});
	}
});

interface TealServerSettings { };

const defaultSettings: TealServerSettings = {};

let globalSettings: TealServerSettings = defaultSettings;

// Cache the settings of all open documents
let settingsCache: Map<string, TealServerSettings> = new Map();

// Cache "tl types" queries of all open documents
let typesCommandCache: Map<string, Teal.TLTypesCommandResult> = new Map();

async function verifyMinimumTLVersion() {
	const tlVersion = await Teal.getVersion();

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
		verifyMinimumTLVersion();
		validateTextDocument(x.uri);
	});

	typesCommandCache.clear();
});

async function getDocumentSettings(uri: string): Promise<TealServerSettings | null> {
	if (!hasConfigurationCapability) {
		return Promise.resolve(globalSettings);
	}

	let result = settingsCache.get(uri);

	if (result === undefined) {
		result = await connection.workspace.getConfiguration({
			scopeUri: uri,
			section: 'teal'
		});

		if (result === undefined) {
			return null;
		}

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

async function _feedTypeInfoCache(uri: string) {
	const textDocument = documents.get(uri);

	if (textDocument === undefined) {
		return null;
	}

	const settings = await getDocumentSettings(textDocument.uri);

	const documentText = textDocument.getText();

	let typesCmdResult: Teal.TLCommandIOInfo;

	try {
		typesCmdResult = await Teal.runCommandOnText(Teal.TLCommand.Types, documentText);
	} catch(error) {
		showErrorMessage("[Error]\n" + error.message);
		return null;
	};

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

export function getTypeInfoFromCache(uri: string): Teal.TLTypesCommandResult | null {
	const cachedResult = typesCommandCache.get(uri);

	if (cachedResult === undefined) {
		return null;
	}

	return cachedResult;
}

connection.onDidOpenTextDocument(async (params) => {
	verifyMinimumTLVersion();

	const treeSitterDocument = new TreeSitterDocument();
	await treeSitterDocument.init(params.textDocument.uri, params.textDocument.text);

	documents.set(params.textDocument.uri, treeSitterDocument);

	validateTextDocument(params.textDocument.uri);
	feedTypeInfoCache(params.textDocument.uri);
});

connection.onDidChangeTextDocument((params) => {
	const uri = params.textDocument.uri;

	const document = documents.get(uri);

	if (document === undefined) {
		return;
	}

	document.edit(params.contentChanges);

	validateTextDocument(uri);
	feedTypeInfoCache(uri);
});

connection.onDidCloseTextDocument((params) => {
	const uri = params.textDocument.uri;

	settingsCache.delete(uri);
	typesCommandCache.delete(uri);
	documents.delete(uri);
});

connection.onDidSaveTextDocument((params) => {

});

async function showErrorMessage(message: string, ...actions: MessageActionItem[]) {
	let params: ShowMessageRequestParams = { type: MessageType.Error, message, actions };

	return await connection.sendRequest(ShowMessageRequest.type, params);
}

connection.onDidChangeWatchedFiles(_change => {
	for (let [uri, document] of documents) {
		validateTextDocument(uri);

		// Put new `tl types` data in cache
		feedTypeInfoCache(uri);
	}
});

export async function pathInWorkspace(textDocument: TreeSitterDocument, pathToCheck: string): Promise<string | null> {
	if (path.basename(pathToCheck).startsWith(Teal.TmpBufferPrefix)) {
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

async function _validateTextDocument(uri: string): Promise<void> {
	const textDocument: TreeSitterDocument | undefined = documents.get(uri);

	if (textDocument === undefined) {
		return;
	}

	let settings = await getDocumentSettings(textDocument.uri);

	try {
		const diagnosticsByPath = await TealLS.validateTextDocument(textDocument);
	
		for (let [uri, diagnostics] of diagnosticsByPath.entries()) {
			connection.sendDiagnostics({ uri: uri, diagnostics: diagnostics });
		}
	} catch(error) {
		showErrorMessage("[Error]\n" + error.message);
		connection.sendDiagnostics({ uri: uri, diagnostics: [] });
		return;
	}

}

const validateTextDocument = debounce(500, _validateTextDocument);

connection.onCompletion((params) => {
	const document = documents.get(params.textDocument.uri);

	if (document === undefined) {
		return null;
	}

	const position = params.position;

	const typeInfo = getTypeInfoFromCache(document.uri);

    if (typeInfo === null) {
        return null;
    }

	return autoComplete(document, position, typeInfo);
});

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
			label: Teal.prettifyTypeStr(argumentType.str)
		});
	}

	const returnTypes = new Array<string>();

	for (let returnType of typeJson.rets) {
		let retType = typeInfo.json["types"][returnType[0]];

		returnTypes.push(Teal.prettifyTypeStr(retType.str));
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

	while (ptr.firstChild !== null) {
		if (ptr.type === "index" || ptr.type === "method_index") {
			let field = ptr.childForFieldName("key")!;

			result.push(field.text);
		}

		ptr = ptr.firstChild;
	}

	result.push(ptr.text);

	return result.reverse();
}

async function signatureHelp(textDocumentPosition: TextDocumentPositionParams, token: CancellationToken): Promise<SignatureHelp | null> {
	return null;
	
	/* const document: TreeSitterDocument | undefined = documents.get(textDocumentPosition.textDocument.uri);

	if (document === undefined) {
		return null;
	}

	const position = textDocumentPosition.position;

	const nodeAtPosition = document.getNodeAtPosition(position);

	if (nodeAtPosition === null) {
		return null;
	}

	const parentNode = findNodeOrFieldAbove(nodeAtPosition, "function_call");

	if (parentNode === null) {
		return null;
	}

	const calledObject = parentNode.childForFieldName("called_object")!;

	const functionArgs = findNodeOrFieldAbove(nodeAtPosition, "arguments");

	if (functionArgs === null) {
		return null;
	}

	const typeInfo = getTypeInfoFromCache(document.uri);

	if (typeInfo === null) {
		return null;
	}

	const symbols = Teal.symbolsInScope(typeInfo.json, position.line + 1, position.character + 1);

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
	}; */
};

connection.onSignatureHelp(signatureHelp);

async function getTypeInfoAtPosition(uri: string, position: Position): Promise<Teal.TLTypeInfo | null> {
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

	let wordRange = textDocument.getWordRangeAtPosition(position);

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
		name: Teal.prettifyTypeStr(typeName)
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

connection.listen();
