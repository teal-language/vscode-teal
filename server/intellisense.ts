import { CompletionItem, Position, CompletionItemKind } from "vscode-languageserver/node";
import { SyntaxNode } from "web-tree-sitter";
import { Teal } from "./teal";
import { positionAfterNode, TreeSitterDocument } from "./tree-sitter-document";

export function findNodeAbove(baseNode: SyntaxNode, type: string[]): SyntaxNode | null {
    let ptr: SyntaxNode | null = baseNode;

    while (ptr !== null) {
        if (type.includes(ptr.type)) {
            return ptr;
        }

        ptr = ptr.parent;
    }

    return null;
}

export function findNodeBeforeOrBelow(rootNode: SyntaxNode, type: string[], ignore: string[] = []): SyntaxNode | null {
    for (let i = 0; i < rootNode.namedChildren.length; ++i) {
        const child = rootNode.namedChildren[i];

        if (type.includes(child.type) && !ignore.includes(child.type)) {
            return child;
        }

        let subChild = findNodeBeforeOrBelow(child, type, ignore);

        if (subChild !== null) {
            return subChild;
        }
    }

    let sibling = rootNode.previousNamedSibling;

    while (sibling !== null) {
        if (type.includes(sibling.type) && !ignore.includes(sibling.type)) {
            return sibling;
        }

        sibling = sibling.previousNamedSibling;
    }

    return null;
}

export function findNodeAfter(rootNode: SyntaxNode, type: string[]): SyntaxNode | null {
    let sibling = rootNode.nextNamedSibling;

    while (sibling !== null) {
        if (type.includes(sibling.type)) {
            return sibling;
        }

        sibling = sibling.nextNamedSibling;
    }

    return null;
}

/**
 * Note: the root can include itself in the descendants list (FIXME?)
 */
export function descendantsOfTypes(rootNode: SyntaxNode, type: string[], ignore: string[] = []): SyntaxNode[] {
    let result: SyntaxNode[] = [];

    if (type.includes(rootNode.type)) {
        result.push(rootNode);
    }

    for (let i = 0; i < rootNode.namedChildren.length; ++i) {
        const child = rootNode.namedChildren[i];

        if (!ignore.includes(child.type)) {
            let subChildren = descendantsOfTypes(child, type, ignore);

            if (subChildren.length > 0) {
                result = result.concat(subChildren);
            }
        }
    }

    return result;
}

export function findIndexRootAtPosition(document: TreeSitterDocument, line: number, column: number): SyntaxNode | null {
    const nodeAtPosition = document.getNodeAtPosition({ line: line, character: column });

    if (nodeAtPosition === null) {
        return null;
    }

    let indexRoot: SyntaxNode | null;

    // detects the case where the user is typing between two '.', like abc.|.def
    const isConfusedForOp = nodeAtPosition.type === "op" && nodeAtPosition.startPosition.column === column - 1 && nodeAtPosition.endPosition.column === column + 1;

    if (nodeAtPosition.type === "ERROR" || isConfusedForOp) {
        indexRoot = findNodeBeforeOrBelow(nodeAtPosition, ["index", "method_index", "identifier", "table_entry", "type_annotation", "arg", "simple_type", "type_index"]);

        if (indexRoot !== null && indexRoot.type === "table_entry") {
            indexRoot = indexRoot.childForFieldName("value");
        } else if (indexRoot !== null && indexRoot.type === "type_annotation") {
            indexRoot = findNodeBeforeOrBelow(indexRoot, ["simple_type", "type_index"]);
        } else if (indexRoot !== null && indexRoot.type === "arg") {
            indexRoot = findNodeBeforeOrBelow(indexRoot, ["simple_type", "type_index"]);
        }
    } else {
        indexRoot = findNodeAbove(nodeAtPosition, ["index", "method_index", "type_index"]);
    }

    return indexRoot;
}

export function findFunctionCallRootAtPosition(document: TreeSitterDocument, line: number, column: number): SyntaxNode | null {
    const nodeAtPosition = document.getNodeAtPosition({ line: line, character: column });

    if (nodeAtPosition === null) {
        return null;
    }

    let functionCallRoot: SyntaxNode | null = findNodeAbove(nodeAtPosition, ["function_call"]);

    return functionCallRoot;
}

/**
 * Find every identifier before the cursor in a complex expression.
 * For instance, in the expression `abc.efg().hij|` where | is the cursor, the result would be an array containing [abc, efg].
 * We can then use this array to determine the type of every part of a complex expression, for autocompletion purposes or for displaying signature hints.
 */
export function getSymbolParts(node: SyntaxNode, row: number, column: number): string[] {
    const result: string[] = [];

    descendantsOfTypes(node, ["identifier", "simple_type"], ["arguments"])
        .forEach(x => {
            if (positionAfterNode({ line: row, character: column }, x)) {
                result.push(x.text);
            }
        });

    return result;
}

function getTypeById(typeInfo: Teal.TLTypesCommandResult, typeId: number): any | null {
    let typeDefinition: any | undefined = typeInfo.json?.["types"]?.[typeId];

    if (typeDefinition === undefined) {
        return null;
    }

    return typeDefinition;
}

/**
 * Determines which type that a type returns when indexed with a specific key.
 */
function getTargetType(type: any, key: string, typeInfo: Teal.TLTypesCommandResult) {
    let targetTypeId: any | undefined;

    // is it a record? if so, check in fields
    if (type["t"] === 0x00020008) {
        targetTypeId = type.fields?.[key];
    }

    // a "nominal"?
    else if (type["t"] === 0x10000000) {
        while (type.ref !== undefined) {
            type = getTypeById(typeInfo, type.ref);
        }

        targetTypeId = type.fields?.[key];
    }

    // an array?
    else if (type["t"] === 0x00010008) {
        targetTypeId = type.elements;
    }

    // a map?
    else if (type["t"] === 0x00040008) {
        targetTypeId = type.values;
    }

    // an arrayrecord?
    else if (type["t"] === 0x00030008) {
        targetTypeId = type.fields?.[key];

        if (targetTypeId === undefined) {
            targetTypeId = type.elements;
        }
    }

    // tuples not yet supported :(
    else if (type["t"] === 0x00080008) {

    }

    // a function?
    else if (type["t"] === 0x00000020) {
        targetTypeId = type.rets[0]?.[0];
    }

    // a string? if so, find the string global table
    else if (type["t"] === 0x00000008) {
        targetTypeId = typeInfo.json["globals"]?.["string"];
    }

    if (targetTypeId === undefined) {
        return null;
    }

    let targetType = getTypeById(typeInfo, targetTypeId);

    while (targetType.ref !== undefined) {
        targetType = getTypeById(typeInfo, targetType.ref);
    }

    return targetType;
}

function autoCompleteIndex(indexRoot: SyntaxNode, typeInfo: Teal.TLTypesCommandResult, symbolsInScope: Map<string, Teal.Symbol>, position: Position): CompletionItem[] {
    let result: CompletionItem[] = [];

    const symbolParts = getSymbolParts(indexRoot, position.line, position.character);

    if (symbolParts.length === 0) {
        return [];
    }

    let rootSymbol = symbolsInScope.get(symbolParts[0]);

    if (rootSymbol === undefined) {
        return [];
    }

    let rootType: any | null = getTypeById(typeInfo, rootSymbol.typeId);

    if (rootType === null) {
        return [];
    }

    while (rootType.ref !== undefined) {
        rootType = getTypeById(typeInfo, rootType.ref);
    }

    let typeRef = rootType;

    for (let x = 1; x < symbolParts.length; ++x) {
        const key = symbolParts[x];

        let targetType = getTargetType(typeRef, key, typeInfo);

        if (targetType === null) {
            return [];
        }

        typeRef = targetType;
    }

    if (typeRef.fields === undefined) {
        const retType = getTargetType(typeRef, "", typeInfo);

        if (retType !== null) {
            typeRef = retType;
        }
    }

    if (typeRef.fields !== undefined) {
        for (const [identifier, typeId] of Object.entries(typeRef.fields)) {
            const completionItem = makeTypeItem(typeInfo, typeId as number, identifier);

            if (completionItem !== null) {
                result.push(completionItem);
            }
        }
    }

    return result;
}

function makeTypeItem(typeInfo: Teal.TLTypesCommandResult, typeId: number, label: string): CompletionItem | null {
    let typeDefinition = getTypeById(typeInfo, typeId);

    if (typeDefinition === null || typeDefinition["str"] === undefined) {
        return null;
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

    const detail = Teal.prettifyTypeStr(typeDefinition.str);

    return {
        label: label,
        kind: kind as CompletionItemKind,
        data: typeDefinition,
        detail: detail,
        commitCharacters: ["("]
    };
}

export async function autoComplete(document: TreeSitterDocument, position: Position, typeInfo: any): Promise<CompletionItem[]> {
    let symbols = Teal.symbolsInScope(typeInfo.json, position.line + 1, position.character + 1);

    const indexRoot = findIndexRootAtPosition(document, position.line, position.character);

    if (indexRoot !== null) {
        const results = autoCompleteIndex(indexRoot, typeInfo, symbols, position);

        return results;
    }

    let nodeAtPosition: SyntaxNode | null = document.getNodeAtPosition(position);

    if (nodeAtPosition === null) {
        return [];
    }

    /* if (nodeAtPosition.type === "ERROR") {
        // try the previous node instead?
        if (nodeAtPosition.previousNamedSibling !== null) {
            nodeAtPosition = nodeAtPosition.previousNamedSibling;
        }
    } */

    const isType = findNodeAbove(nodeAtPosition, ["type_annotation", "type", "table_type", "type_cast", "return_type", "simple_type"]) !== null;

    let result: CompletionItem[] = [];

    function makeBasicItem(str: string, kind: CompletionItemKind): CompletionItem {
        return {
            label: str,
            kind: kind
        };
    }

    // Built-in types and keywords
    result = [
        "true",
        "false",
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
        const completionItem = makeTypeItem(typeInfo, symbol.typeId, symbolIdentifier);

        if (completionItem !== null) {
            result.push(completionItem);
        }
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