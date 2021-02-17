import * as Parser from 'web-tree-sitter';
import * as path from "path";
import { TextDocumentContentChangeEvent, Range, Position } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';

export class TreeSitterDocument {
    private _parser: Parser | null;
    private _lang: Parser.Language | null;
    private _tree: Parser.Tree | null;
    private _document: TextDocument | null;

    private _uri: string;
    public get uri(): string {
        return this._uri;
    }

    private _isInit: boolean;
    public get isInit(): boolean {
        return this._isInit;
    }

    constructor() {
        this._parser = null;
        this._lang = null;
        this._tree = null;
        this._document = null;
        this._uri = "";
        this._isInit = false;
    }

    async init(uri: string, text: string) {
        await Parser.init();
        this._parser = new Parser();
        const langPath = path.resolve(__dirname, "..", "tree-sitter-teal.wasm");
        this._lang = await Parser.Language.load(langPath);
        this._parser.setLanguage(this._lang);
        this._document = TextDocument.create(uri, "teal", 1, text);
        this._tree = this._parser.parse(text);
        this._uri = uri;
        this._isInit = true;
    }

    edit(edits: TextDocumentContentChangeEvent[]) {
        if (this._tree === null || this._parser === null || this._document === null) {
            console.log("[Warning]", "Some edits have been lost!");
            return;
        }

        if (edits.length === 0) {
            return;
        }

        for (const edit of edits) {
            if ("range" in edit) {
                const startIndex = this._document.offsetAt(edit.range.start);
                const oldEndIndex = this._document.offsetAt(edit.range.end);
                const newEndIndex = startIndex + edit.text.length;

                const startPosition = positionToPoint(edit.range.start);
                const oldEndPosition = positionToPoint(edit.range.end);

                const extent = getExtent(edit.text);

                let newEndPosition: Parser.Point = { row: 0, column: 0 };

                newEndPosition.row = startPosition.row + extent.row;

                if (extent.row > 0) {
                    newEndPosition.column = extent.column;
                } else {
                    newEndPosition.column = startPosition.column + extent.column;
                }

                const delta: Parser.Edit = {
                    startIndex: startIndex,
                    oldEndIndex: oldEndIndex,
                    newEndIndex: newEndIndex,
                    startPosition: startPosition,
                    oldEndPosition: oldEndPosition,
                    newEndPosition: newEndPosition
                };

                this._tree.edit(delta);
                this._document = TextDocument.update(this._document!, [edit], this._document!.version + 1);
                this._tree = this._parser.parse(this._document.getText(), this._tree);
            } else {
                console.log("[INFO] Rebuilding whole syntax tree");
                this._document = TextDocument.update(this._document!, [edit], this._document!.version + 1);
                this._tree = this._parser.parse(edit.text);
            }
        }
    }

    public getText(range?: Range | undefined): string {
        if (this._document === null) {
            return "";
        }

        return this._document.getText(range);
    }

    public getWordRangeAtPosition(position: Position): Range | null {
        const identifierRegex = /[a-zA-Z0-9_]/;

        const line = this.getText(Range.create(position.line, 0, position.line + 1, 0));

        let start = position.character;
        let end = position.character;

        // Make sure the cursor is on an identifier
        if (!identifierRegex.test(line[start])) {
            return null;
        }

        while (start > 0 && identifierRegex.test(line[start - 1])) {
            start--;
        }

        while (end < line.length - 1 && identifierRegex.test(line[end + 1])) {
            end++;
        }

        return Range.create(position.line, start, position.line, end);
    }

    public getNodeAtPosition(position: Position): Parser.SyntaxNode | null {
        if (this._tree === null) {
            return null;
        }

        return smallestDescendantForPosition(this._tree.rootNode, position);
    }

    public dumpTree(): string {
        if (this._tree === null) {
            return "";
        }

        return this._tree.rootNode.toString()
    }
};

function getExtent(text: string): Parser.Point {
    let lines = text.split("\n");

    return { row: lines.length - 1, column: lines[lines.length - 1].length };
}


export function positionToPoint(pos: Position): Parser.Point {
    return {
        row: pos.line,
        column: pos.character
    }
}

export function pointToPosition(point: Parser.Point): Position {
    return {
        line: point.row,
        character: point.column
    }
}

export function positionInNode(pos: Position, node: Parser.SyntaxNode): boolean {
    return pos.line >= node.startPosition.row
        && pos.line <= node.endPosition.row
        && !(
            (pos.line === node.startPosition.row && pos.character < node.startPosition.column)
            || (pos.line === node.endPosition.row && pos.character > node.endPosition.column)
        );
}

export function positionAfterNode(pos: Position, node: Parser.SyntaxNode): boolean {
    return pos.line >= node.endPosition.row
        && (
            pos.line > node.endPosition.row
            || pos.character > node.endPosition.column
        );
}


export function nodeLength(node: Parser.SyntaxNode): number {
    return node.endIndex - node.startIndex;
}

export function smallestDescendantForPosition(rootNode: Parser.SyntaxNode, position: Position): Parser.SyntaxNode {
    if (rootNode.namedChildren.length === 0) {
        return rootNode;
    }

    let min = rootNode;

    for (let i = 0; i < rootNode.namedChildren.length; ++i) {
        const child = rootNode.namedChildren[i];

        if (positionInNode(position, child)) {
            const smallestSubChildren = smallestDescendantForPosition(child, position);

            if (nodeLength(smallestSubChildren) <= nodeLength(min)) {
                min = smallestSubChildren
            }
        }
    }

    let sibling = rootNode.nextNamedSibling;

    while (sibling !== null) {
        if (positionInNode(position, sibling)) {
            const smallestSubChildren = smallestDescendantForPosition(sibling, position);

            if (nodeLength(smallestSubChildren) <= nodeLength(min)) {
                min = smallestSubChildren
            }
        }

        sibling = sibling.nextNamedSibling;
    }

    return min
}

export function findNodeOrFieldAbove(baseNode: Parser.SyntaxNode, type: string): Parser.SyntaxNode | null {
    let ptr: Parser.SyntaxNode | null = baseNode;

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
