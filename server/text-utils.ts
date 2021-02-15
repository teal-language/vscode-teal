import { Position, Range } from "vscode-languageserver/node";

export function isEmptyOrSpaces(str: string) {
	return (str == null || str.trim() === '');
}

