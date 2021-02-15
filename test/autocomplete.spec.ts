import * as assert from "assert";
import 'mocha';
import { SyntaxNode } from "web-tree-sitter";
import { TreeSitterDocument } from "../server/tree-sitter-document";
import { beautify } from "./sexpr";

async function getTestDocument(text: string) {
    const result = new TreeSitterDocument();
    await result.init("./test.tl", text);

    return result;
}

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

    /* sibling = rootNode.nextNamedSibling;

    while (sibling !== null) {
        if (type.includes(sibling.type)) {
            return sibling;
        }

        sibling = sibling.nextNamedSibling;
    } */

    return null;
}

function descendantsOfTypes(rootNode: SyntaxNode, type: string[], ignore: string[] = []): SyntaxNode[] {
    let result: SyntaxNode[] = [];

    console.log("Looping through descendents", rootNode.namedChildCount);

    for (let i = 0; i < rootNode.namedChildren.length; ++i) {
        const child = rootNode.namedChildren[i];

        if (type.includes(child.type) && !ignore.includes(child.type)) {
            result.push(child);
        }

        let subChildren = descendantsOfTypes(child, type, ignore);

        if (subChildren.length > 0) {
            result = result.concat(subChildren);
        }
    }

    /* let sibling = rootNode.nextNamedSibling;

    while (sibling !== null) {
        if (type.includes(sibling.type) && !ignore.includes(sibling.type)) {
            result.push(sibling);
        }

        let subChildren = descendantsOfTypes(sibling, type, ignore);

        if (subChildren.length > 0) {
            result = result.concat(subChildren)
        }

        sibling = sibling.nextNamedSibling;
    } */

    return result;
}

function findIndexRootAtPosition(document: TreeSitterDocument, line: number, column: number): SyntaxNode | null {
    const nodeAtPosition = document.getNodeAtPosition({line: line, character: column});

    assert(nodeAtPosition !== null);

    let indexRoot: SyntaxNode | null;

    if (nodeAtPosition.type === "ERROR" && (nodeAtPosition.text.endsWith(".") || nodeAtPosition.text.endsWith(":")))  {
        indexRoot = findNodeBeforeOrBelow(nodeAtPosition, ["index", "method_index", "identifier"]);
    } else {
        indexRoot = findNodeAbove(nodeAtPosition, ["index", "method_index"]);
    }

    return indexRoot;
}

/**
 * Find every identifier before the cursor in a complex expression.
 * For instance, in the expression `abc.efg().hij|` where | is the cursor, the result would be an array containing [abc, efg].
 * We can then use this array to determine the type of every part in a complex expression, for autocompletion purposes or for signature hints.
 */
function getSymbolParts(node: SyntaxNode, line: number, column: number): string[] {
    const result: string[] = [];

    node.descendantsOfType("identifier")
        .forEach(x => {
            if (x.endPosition.column < column) { 
                result.push(x.text);
            }
        });

    return result;
}

function debugNode(doc: TreeSitterDocument, node: SyntaxNode) {
    console.log("Tree dump:", beautify(doc.dumpTree()));
    console.log("Node at position:", beautify(node.toString()), "[", node.text, "]");
    console.log("Its parent:", beautify(node.parent?.toString()), "[", node.parent?.text, "]");
    console.log("Index node above:", findNodeAbove(node, ["index", "method_index"])?.text);

    if (node.type === "ERROR") {
        console.log("Index node next or below (error node detected):", findNodeBeforeOrBelow(node, ["index", "method_index"])?.text);
    }
}

describe("Splitting an expression into parts", () =>{
    it('works with partial input after a single ":"', async () =>
    {
        const code = `abc:`;
        const doc = await getTestDocument(code);

        const indexRoot = findIndexRootAtPosition(doc, 0, 4);

        assert(indexRoot !== null);

        assert.deepStrictEqual(getSymbolParts(indexRoot, 0, 4), ["abc"]);
    });
    it('works with partial input after a single "."', async () =>
    {
        const code = `abc.`;
        const doc = await getTestDocument(code);

        const indexRoot = findIndexRootAtPosition(doc, 0, 4);

        assert(indexRoot !== null);

        assert.deepStrictEqual(getSymbolParts(indexRoot, 0, 4), ["abc"]);
    });
    it('works with partial input after a second "."', async () =>
    {
        const code = `abc.efg.`;
        const doc = await getTestDocument(code);

        const indexRoot = findIndexRootAtPosition(doc, 0, 8);

        assert(indexRoot !== null);

        assert.deepStrictEqual(getSymbolParts(indexRoot, 0, 8), ["abc", "efg"]);
    });
    it('works with complete input after a second "."', async () =>
    {
        const code = `abc.efg.hij`;
        const doc = await getTestDocument(code);

        const indexRoot = findIndexRootAtPosition(doc, 0, 11);

        assert(indexRoot !== null);

        assert.deepStrictEqual(getSymbolParts(indexRoot, 0, 11), ["abc", "efg"]);
    });
    it('works with partial input after a ".", after a function call', async () =>
    {
        const code = `abc().`;
        const doc = await getTestDocument(code);

        const indexRoot = findIndexRootAtPosition(doc, 0, 6);

        assert(indexRoot !== null);

        assert.deepStrictEqual(getSymbolParts(indexRoot, 0, 6), ["abc"]);
    });
    it('works with partial input after a ".", next to a function call with arguments', async () =>
    {
        const code = `abc(def, ghi.jkl).mno.`;
        const doc = await getTestDocument(code);

        const indexRoot = findIndexRootAtPosition(doc, 0, 22);

        assert(indexRoot !== null);

        assert.deepStrictEqual(getSymbolParts(indexRoot, 0, 22), ["abc", "mno"]);
    });
    it('works with partial input after a ".", inside a function call', async () =>
    {
        const code = `abc(def, ghi.).mno`;
        const doc = await getTestDocument(code);

        const indexRoot = findIndexRootAtPosition(doc, 0, 13);

        assert(indexRoot !== null);

        assert.deepStrictEqual(getSymbolParts(indexRoot, 0, 13), ["ghi"]);
    });
});