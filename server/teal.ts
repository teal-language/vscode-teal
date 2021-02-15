import { withFile } from 'tmp-promise'
import { spawn } from 'child_process';
import { writeFile } from './file-utils';
import { Location } from 'vscode-languageserver/node';

export namespace Teal {
    class TLNotFoundError extends Error { /* ... */ }

    export const TmpBufferPrefix = "__tl__tmp__check-";

    export interface TLCommandIOInfo {
        filePath: string | null,
        stdout: string,
        stderr: string
    };

    export enum TLCommand {
        Check = "check",
        Types = "types",
        Version = "--version"
    };

    export interface TLTypesCommandResult {
        ioInfo: TLCommandIOInfo,
        json: any
    }

    export interface TLTypeInfo {
        location: Location | null,
        name: string
    };
    
    type FileName = string;
    type TypeId = number;

    type SymbolTuple = [number, number, string, TypeId];

    export interface Symbol {
        y?: number,
        x?: number,
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
        types: Record<TypeId, TypeInfo>,
        globals: Record<string, TypeId>
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

    export function symbolsInScope(typeReport: TypeReport, y: number, x: number): Map<string, Symbol> {
        let result = new Map<string, Symbol>();

        let symIndex = find(typeReport.symbols, y, x);

        const globals = typeReport.globals;

        for (const [str, typeId] of Object.entries(globals)) {
            result.set(str, {
                identifier: str,
                typeId: typeId
            });
        }

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
                result.set(sym[2], {
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
    
    /**
     * Runs a `tl` command on a specific text.
     */
    export async function runCommandOnText(command: TLCommand, text: string): Promise<TLCommandIOInfo> {
        try {
            return await withFile(async ({ path, fd }) => {
                await writeFile(fd, text);

                try {
                    let result = await runCommand(command, path);
                    return result;
                } catch (error) {
                    throw error;
                }
            }, { prefix: TmpBufferPrefix });
        } catch (error) {
            throw error;
        }
    }

    /**
     * 
     */
    export async function runCommand(command: TLCommand, filePath?: string): Promise<TLCommandIOInfo> {
        let child: any;

        let platform = process.platform;

        if (platform == "win32") {
            let args = ['/c', "tl.bat", "-q", command];

            if (filePath !== undefined) {
                args.push(filePath);
            }

            child = spawn('cmd.exe', args);
        } else {
            let args = ["-q", command];

            if (filePath !== undefined) {
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
                resolve({ filePath: filePath ? filePath : null, stdout: stdout, stderr: stderr });
            });

            for await (const chunk of child.stdout) {
                stdout += chunk;
            }

            for await (const chunk of child.stderr) {
                stderr += chunk;
            }
        });
    }

    interface MajorMinorPatch {
        major: number,
        minor: number,
        patch: number
    }

    export async function getVersion(): Promise<MajorMinorPatch | null> {
        const commandResult = await Teal.runCommand(Teal.TLCommand.Version);

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
};
