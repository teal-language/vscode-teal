type FileName = string;
type TypeId = number;

type SymbolTuple = [number, number, string, TypeId];

interface Symbol {
    y: number,
    x: number,
    identifier: string,
    typeId: TypeId
};

interface TypeInfo {
    x?: number,
    y?: number,
    str?: string,
    file?: FileName,
    fields?: any,
};

/**
 * Y position => X Position => TypeId
 */
type TypePositions = Record<string, Record<string, TypeId>>;

interface TypeReport {
    symbols: SymbolTuple[],
    byPos: Record<FileName, TypePositions>,
    types: Record<TypeId, TypeInfo>
};

function le(vy: number, vx: number, y: number, x: number): boolean {
    return vy < y || (vy == y && vx <= x);
}

function find(symbols: SymbolTuple[], y: number, x: number): number {
    let len = symbols.length;
    let left = 0;
    let mid = 0;
    let right = len - 1;

    while (left <= right) {
        mid = Math.floor((left + right) / 2);

        const sym = symbols[mid];

        if (le(sym[0], sym[1], y, x)) {
            if (mid == len - 1) {
                return mid;
            }
            else {
                const nextSym = symbols[mid + 1];

                if (!le(nextSym[0], nextSym[1], y, x)) {
                    return mid;
                }
            }

            left = mid + 1;
        }
        else {
            right = mid - 1;
        }
    }

    return 0;
}

export function symbolsInScope(typeReport: TypeReport, y: number, x: number): Array<Symbol> {
    let result = new Array<Symbol>();

    let symIndex = find(typeReport.symbols, y, x);

    const symbols = typeReport.symbols;

    while (symIndex >= 0) {
        let sym = symbols[symIndex];

        if (sym[2] == "@{") {
            symIndex = symIndex - 1;
        }
        else if (sym[2] == "@}") {
            symIndex = sym[3];
        }
        else {
            result.push({
                y: sym[0],
                x: sym[1],
                identifier: sym[2],
                typeId: sym[3]
            });

            symIndex = symIndex - 1;
        }
    }

    return result
}
